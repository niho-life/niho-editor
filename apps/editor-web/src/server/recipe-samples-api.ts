import {
  GUIDE_EXTRACTION_PROFILE_ID,
  GUIDE_MAX_CHARS,
  buildGuideExtractionPrompt,
  estimateTokenCostUsd,
  mergeExtractedTerms,
  parseGuideExtraction,
} from "@niho/docs-core";
import { RECIPE_SAMPLE_MAX_COUNT, type AiUsageDelta, type OwnerId, type RecipeGuideExtraction, type RecipeSample, type RecipeSampleBody, type SettingsTerm } from "@niho/editor-store";
import { AnthropicError, maxTokensLimit, timeoutMs } from "../ai/anthropic";
import type { AiComposeBackend } from "../ai/config";
import type { AiUsageReport } from "../ai/model";
import type { AuthProvider } from "../auth/types";
import { stepGenerationOptions } from "../steps/profile";
import { isRecipeKey, type RecipeDef } from "../steps/recipes";
import { errorResponse, isSameOriginRequest, jsonResponse, notFoundResponse } from "./http";
import { importUploadedSample, importUrlSample, RecipeSampleImportError, RECIPE_SAMPLE_UPLOAD_MAX_BYTES } from "./recipe-sample-import";
import type { ImportedSampleText } from "./recipe-sample-import";

const MULTIPART_BODY_MAX_BYTES = RECIPE_SAMPLE_UPLOAD_MAX_BYTES + 256 * 1024;

export type RecipeSampleStore = {
  recipes: (owner: OwnerId) => Promise<RecipeDef[]>;
  glossary: (owner: OwnerId) => Promise<SettingsTerm[]>;
  sampleBodies: (owner: OwnerId, recipeId: string) => Promise<RecipeSampleBody[] | null>;
  addSample: (owner: OwnerId, recipeId: string, sample: RecipeSample, body: string) => Promise<"created" | "not_found" | "limit" | "conflict">;
  saveExtraction: (owner: OwnerId, recipeId: string, sampleIds: readonly string[], guide: string, candidates: readonly SettingsTerm[]) => Promise<boolean>;
  getExtraction: (owner: OwnerId, recipeId: string) => Promise<RecipeGuideExtraction | null>;
};

export type RecipeSampleUsageStore = {
  get: (owner: OwnerId, month: string) => Promise<{ costMicroUsd: number }>;
  record: (owner: OwnerId, month: string, delta: AiUsageDelta) => Promise<unknown>;
};

export type RecipeSampleApiDeps = {
  auth: () => AuthProvider;
  store: () => RecipeSampleStore | null;
  compose: () => AiComposeBackend | null;
  usage: () => RecipeSampleUsageStore | null;
  limitUsd: () => number | null;
  monthKey: (date: Date) => string;
  now?: () => Date;
  env?: Readonly<Record<string, string | undefined>>;
  importFile?: (name: string, bytes: Buffer) => Promise<ImportedSampleText>;
  importUrl?: (url: string) => Promise<ImportedSampleText & { sourceUrl: string; name: string }>;
};

function requestError(status: number, code: string): Response {
  return jsonResponse(status, { error: code });
}

async function guarded(route: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    const code = error instanceof RecipeSampleImportError
      ? error.code
      : typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
    console.error("editor-web: recipe sample request failed", { route, name: error instanceof Error ? error.name : "unknown", ...(code ? { code } : {}) });
    return errorResponse("internal");
  }
}

function importErrorResponse(error: RecipeSampleImportError): Response {
  const status: Record<RecipeSampleImportError["code"], number> = {
    bad_request: 400,
    unsupported_type: 415,
    too_large: 413,
    unsafe_url: 400,
    fetch_failed: 422,
    timeout: 408,
    invalid_document: 422,
  };
  return requestError(status[error.code], error.code);
}

function safeSampleName(value: string): string {
  const result = value.normalize("NFC").replace(/[\\/\r\n\u0000-\u001f<>]+/g, " ").trim();
  return Array.from(result || "お手本").slice(0, 200).join("");
}

function byteLengthHeader(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

async function readBoundedFormData(request: Request, maxBytes: number): Promise<FormData> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data;")) throw new RecipeSampleImportError("bad_request");
  if (!request.body) throw new RecipeSampleImportError("bad_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RecipeSampleImportError("too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new RecipeSampleImportError("bad_request");
  }
}

/** POST /api/settings/recipes/{recipeId}/samples — attach a local document or safely fetch a public URL. */
export function importRecipeSample(request: Request, recipeId: string, deps: RecipeSampleApiDeps): Promise<Response> {
  return guarded("POST /api/settings/recipes/[recipeId]/samples", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    if (!isRecipeKey(recipeId)) return notFoundResponse();
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const contentLength = byteLengthHeader(request);
    if (contentLength !== null && contentLength > MULTIPART_BODY_MAX_BYTES) return requestError(413, "too_large");
    const recipe = (await store.recipes(session.userId)).find((entry) => entry.id === recipeId);
    if (!recipe) return notFoundResponse();
    if (recipe.samples.length >= RECIPE_SAMPLE_MAX_COUNT) return requestError(409, "sample_limit");

    let form: FormData;
    try { form = await readBoundedFormData(request, MULTIPART_BODY_MAX_BYTES); }
    catch (error) { if (error instanceof RecipeSampleImportError) return importErrorResponse(error); throw error; }
    const entries = [...form.entries()];
    if (entries.length !== 1 || !["file", "url"].includes(entries[0]![0])) return requestError(400, "bad_request");
    let imported: ImportedSampleText & { sourceUrl?: string; name: string };
    if (entries[0]![0] === "url") {
      const value = entries[0]![1];
      if (typeof value !== "string" || value.trim() === "") return requestError(400, "bad_request");
      try { imported = await (deps.importUrl ?? importUrlSample)(value.trim()); }
      catch (error) { if (error instanceof RecipeSampleImportError) return importErrorResponse(error); throw error; }
    } else {
      const value = entries[0]![1];
      if (!(value instanceof File)) return requestError(400, "bad_request");
      if (value.size < 1) return requestError(400, "bad_request");
      if (value.size > RECIPE_SAMPLE_UPLOAD_MAX_BYTES) return requestError(413, "too_large");
      const fileName = value.name.split(/[\\/]/).filter(Boolean).at(-1) ?? "お手本.txt";
      try {
        imported = { ...await (deps.importFile ?? importUploadedSample)(fileName, Buffer.from(await value.arrayBuffer())), name: safeSampleName(fileName) };
      } catch (error) { if (error instanceof RecipeSampleImportError) return importErrorResponse(error); throw error; }
    }
    const sample: RecipeSample = {
      id: `sample-${crypto.randomUUID().replaceAll("-", "")}`,
      name: safeSampleName(imported.name),
      chars: imported.chars,
      ...(imported.truncatedFrom === undefined ? {} : { truncatedFrom: imported.truncatedFrom }),
      ...(imported.sourceUrl === undefined ? {} : { sourceUrl: imported.sourceUrl }),
    };
    const result = await store.addSample(session.userId, recipeId, sample, imported.text);
    if (result === "not_found") return notFoundResponse();
    if (result === "limit") return requestError(409, "sample_limit");
    if (result === "conflict") return requestError(409, "sample_conflict");
    return jsonResponse(201, { sample });
  });
}

function usageDelta(backend: AiComposeBackend, usage: AiUsageReport): AiUsageDelta {
  const inputTokens = Number.isSafeInteger(usage.inputTokens) && usage.inputTokens > 0 ? usage.inputTokens : 0;
  const outputTokens = Number.isSafeInteger(usage.outputTokens) && usage.outputTokens > 0 ? usage.outputTokens : 0;
  const amount = backend.provider ? estimateTokenCostUsd(backend.provider, backend.model, inputTokens, outputTokens) : null;
  return { requests: 1, inputTokens, outputTokens, costMicroUsd: amount === null ? 0 : Math.max(0, Math.round(amount * 1_000_000)) };
}

function quotaReached(costMicroUsd: number, limitUsd: number | null): boolean {
  return limitUsd !== null && costMicroUsd >= Math.round(limitUsd * 1_000_000);
}

/** GET /api/settings/recipes/{recipeId}/guide-extraction — read the last reviewable preview without sample text. */
export function getRecipeGuideExtraction(request: Request, recipeId: string, deps: RecipeSampleApiDeps): Promise<Response> {
  return guarded("GET /api/settings/recipes/[recipeId]/guide-extraction", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isRecipeKey(recipeId)) return notFoundResponse();
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const extraction = await store.getExtraction(session.userId, recipeId);
    return jsonResponse(200, { extraction });
  });
}

/** POST /api/settings/recipes/{recipeId}/guide-extraction — run docs-core's guide extraction and save a review draft. */
export function extractRecipeGuide(request: Request, recipeId: string, deps: RecipeSampleApiDeps): Promise<Response> {
  return guarded("POST /api/settings/recipes/[recipeId]/guide-extraction", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    if (!isRecipeKey(recipeId)) return notFoundResponse();
    const store = deps.store();
    const usage = deps.usage();
    const backend = deps.compose();
    if (!store || !usage) return errorResponse("unavailable");
    if (!backend) return requestError(503, "ai_unavailable");
    const recipe = (await store.recipes(session.userId)).find((entry) => entry.id === recipeId);
    if (!recipe) return notFoundResponse();
    const bodies = await store.sampleBodies(session.userId, recipeId);
    if (!bodies || bodies.length === 0) return requestError(409, "no_samples");
    const bodyById = new Map(bodies.map((entry) => [entry.id, entry.text] as const));
    const selected = recipe.samples.flatMap((sample) => {
      const text = bodyById.get(sample.id);
      return text === undefined ? [] : [{ id: sample.id, name: sample.name, text, ...(sample.truncatedFrom === undefined ? {} : { truncatedFrom: sample.truncatedFrom }) }];
    });
    if (selected.length === 0) return requestError(409, "no_samples");
    const samples = selected.map(({ name, text, truncatedFrom }) => ({ name, text, ...(truncatedFrom === undefined ? {} : { truncatedFrom }) }));
    const prompt = buildGuideExtractionPrompt(samples);
    const now = deps.now?.() ?? new Date();
    const month = deps.monthKey(now);
    const limitUsd = deps.limitUsd();
    const before = await usage.get(session.userId, month);
    if (quotaReached(before.costMicroUsd, limitUsd)) return requestError(429, "quota_exceeded");
    const env = deps.env ?? process.env;
    const generation = stepGenerationOptions(backend.model, GUIDE_EXTRACTION_PROFILE_ID, 6_000, maxTokensLimit(env));
    let turn;
    try {
      turn = await backend.client.converse({
        system: prompt.systemPrompt,
        messages: [{ role: "user", content: prompt.userPrompt }],
        maxTokens: generation.maxTokens,
        ...(generation.thinking ? { thinking: generation.thinking } : {}),
        ...(generation.outputConfig ? { outputConfig: generation.outputConfig } : {}),
        signal: request.signal,
      });
    } catch (error) {
      if (error instanceof AnthropicError && error.usage) await usage.record(session.userId, month, usageDelta(backend, error.usage));
      return requestError(502, "guide_extraction_failed");
    }
    await usage.record(session.userId, month, usageDelta(backend, turn.usage));
    if (turn.stopReason === "max_tokens") return requestError(502, "guide_extraction_failed");
    const result = parseGuideExtraction(turn.text, samples);
    if (!result.ok || Array.from(result.guide).length > GUIDE_MAX_CHARS) return requestError(502, "guide_extraction_failed");
    const glossary = await store.glossary(session.userId);
    const knownTerms = [...glossary, ...recipe.terms];
    const merged = mergeExtractedTerms(knownTerms, result.terms);
    const candidates = merged.terms.slice(knownTerms.length, knownTerms.length + Math.max(0, 200 - knownTerms.length));
    const sampleIds = selected.map((sample) => sample.id);
    const saved = await store.saveExtraction(session.userId, recipeId, sampleIds, result.guide, candidates);
    if (!saved) return requestError(409, "samples_changed");
    return jsonResponse(200, { extraction: { sampleIds, guide: result.guide, candidates, createdAt: now.toISOString() } });
  });
}
