import { createHash, randomUUID } from "node:crypto";
import { estimateTokenCostUsd } from "@niho/docs-core";
import {
  PAGE_KINDS,
  TRANSLATION_PROPOSAL_TTL_HOURS,
  pageImageIds,
  type AdoptTranslationInput,
  type AdoptTranslationResult,
  type AiUsageDelta,
  type AiUsageTotals,
  type DetachTranslationResult,
  type OwnerId,
  type Page,
  type ReviewTranslationResult,
  type StartTranslationProposalInput,
  type StartTranslationProposalResult,
  type TranslationProposal,
  type TranslationProposalPayload,
  type TranslationRelationState,
  type TranslationSource,
  type TranslationEnvelope,
} from "@niho/editor-store";
import { AnthropicError, maxTokensLimit } from "../ai/anthropic";
import type { AiComposeBackend } from "../ai/config";
import type { AiUsageReport } from "../ai/model";
import {
  applyManagedTranslation,
  buildManagedTranslationPrompt,
  parseManagedTranslationOutput,
  planManagedTranslation,
  type TranslationCandidate,
  type TranslationField,
  type TranslationPageSnapshot,
} from "../ai/translation";
import type { AuthProvider } from "../auth/types";
import type { PrivateJobPayloadCipher } from "../storage/private-job-payload";
import { StorageError, isObjectPath, type ObjectStorage } from "../storage/types";
import { errorResponse, folderResponse, guarded, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSLATION_OUTPUT_MAX_TOKENS_BASE = 1024;
const TRANSLATION_OUTPUT_TOKENS_PER_CODEPOINT = 3;

type StoredSourceAsset = TranslationSource["assets"][number] & { sourceGeneration: string };
type StoredTranslationPayload = {
  schema: 1;
  source: TranslationPageSnapshot & { id: string; revision: number };
  sourceAssets: StoredSourceAsset[];
  sourceFields: TranslationField[];
  translatedFields: TranslationField[] | null;
};

export type TranslationStore = {
  page(owner: OwnerId, pageId: string): Promise<Page | null>;
  source(owner: OwnerId, pageId: string): Promise<TranslationSource | null>;
  start(owner: OwnerId, pageId: string, input: StartTranslationProposalInput): Promise<StartTranslationProposalResult>;
  latest(owner: OwnerId, sourcePageId: string): Promise<TranslationProposal | null>;
  proposal(owner: OwnerId, proposalId: string): Promise<TranslationProposalPayload | null>;
  finish(owner: OwnerId, proposalId: string, generation: number, operationId: string, envelope: TranslationEnvelope): Promise<boolean>;
  fail(owner: OwnerId, proposalId: string, generation: number, operationId: string, errorCode: string): Promise<boolean>;
  markCopy(owner: OwnerId, proposalId: string, sourceAssetId: string, result: { state: "copied"; sourceGeneration: string } | { state: "failed"; errorCode: string }): Promise<boolean>;
  adopt(owner: OwnerId, proposalId: string, input: AdoptTranslationInput): Promise<AdoptTranslationResult>;
  relation(owner: OwnerId, pageId: string): Promise<TranslationRelationState | null>;
  review(owner: OwnerId, targetPageId: string, sourceRevision: number, targetRevision: number): Promise<ReviewTranslationResult>;
  detach(owner: OwnerId, targetPageId: string, targetRevision: number): Promise<DetachTranslationResult>;
};

export type TranslationUsageStore = {
  get(owner: OwnerId, month: string): Promise<AiUsageTotals>;
  record(owner: OwnerId, month: string, delta: AiUsageDelta): Promise<AiUsageTotals>;
};

export type TranslationApiDeps = {
  auth: () => AuthProvider;
  store: () => TranslationStore | null;
  storage: () => ObjectStorage | null;
  cipher: () => PrivateJobPayloadCipher | null;
  compose: () => AiComposeBackend | null;
  usage: () => TranslationUsageStore | null;
  limitUsd: () => number | null;
  monthKey: (date: Date) => string;
  now?: () => Date;
  newId?: () => string;
  env?: Readonly<Record<string, string | undefined>>;
};

type TranslationProposalDto = {
  id: string;
  status: TranslationProposal["status"];
  generation: number;
  sourceRevision: number;
  targetRevision: number | null;
  targetPageId: string;
  expiresAt: string;
  omissions: string[];
  sourceFields?: TranslationField[];
  candidateFields?: TranslationField[];
};

type TranslationStateDto = {
  page: { id: string; lang: Page["lang"]; revision: number };
  relation: TranslationRelationState | null;
  proposal: TranslationProposalDto | null;
  provider: { destination: "Anthropic API"; metered: true };
};

function requestError(status: number, code: string): Response {
  return jsonResponse(status, { error: code });
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function uuidBody(value: unknown, key: string): string | null {
  if (!plain(value) || !exact(value, [key])) return null;
  const id = value[key];
  return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null;
}

function revisionsBody(value: unknown): { sourceRevision: number; targetRevision: number } | null {
  if (!plain(value) || !exact(value, ["sourceRevision", "targetRevision"])) return null;
  const { sourceRevision, targetRevision } = value;
  return Number.isSafeInteger(sourceRevision) && (sourceRevision as number) > 0 && Number.isSafeInteger(targetRevision) && (targetRevision as number) > 0
    ? { sourceRevision: sourceRevision as number, targetRevision: targetRevision as number }
    : null;
}

function adoptionBody(value: unknown): { sourceRevision: number; targetRevision: number | null } | null {
  if (!plain(value) || !exact(value, ["sourceRevision", "targetRevision"])) return null;
  const { sourceRevision, targetRevision } = value;
  if (!Number.isSafeInteger(sourceRevision) || (sourceRevision as number) < 1) return null;
  if (targetRevision !== null && (!Number.isSafeInteger(targetRevision) || (targetRevision as number) < 1)) return null;
  return { sourceRevision: sourceRevision as number, targetRevision: targetRevision as number | null };
}

function targetRevisionBody(value: unknown): number | null {
  if (!plain(value) || !exact(value, ["targetRevision"])) return null;
  return Number.isSafeInteger(value.targetRevision) && (value.targetRevision as number) > 0 ? value.targetRevision as number : null;
}

function usageDelta(backend: AiComposeBackend, report: AiUsageReport): AiUsageDelta {
  const inputTokens = Number.isSafeInteger(report.inputTokens) && report.inputTokens > 0 ? report.inputTokens : 0;
  const outputTokens = Number.isSafeInteger(report.outputTokens) && report.outputTokens > 0 ? report.outputTokens : 0;
  const usd = backend.provider ? estimateTokenCostUsd(backend.provider, report.model, inputTokens, outputTokens) : null;
  return { requests: 1, inputTokens, outputTokens, costMicroUsd: usd === null ? 0 : Math.max(0, Math.round(usd * 1_000_000)) };
}

function overLimit(totals: AiUsageTotals, limitUsd: number | null): boolean {
  return limitUsd !== null && totals.costMicroUsd >= Math.round(limitUsd * 1_000_000);
}

function sourceSnapshot(source: TranslationSource, assets: readonly StoredSourceAsset[]): StoredTranslationPayload["source"] {
  return {
    id: source.source.id,
    revision: source.source.revision,
    kind: source.source.kind,
    title: source.source.title,
    lead: source.source.lead,
    blocks: source.source.blocks,
    cover: source.source.cover,
    assets: assets.map(({ assetId, alt }) => ({ assetId, alt })),
  };
}

function inputHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function fieldArray(value: unknown): TranslationField[] | null {
  if (!Array.isArray(value)) return null;
  const fields: TranslationField[] = [];
  for (const item of value) {
    if (!plain(item) || !exact(item, ["path", "text"]) || typeof item.path !== "string" || typeof item.text !== "string") return null;
    fields.push({ path: item.path, text: item.text });
  }
  return fields;
}

function storedAsset(value: unknown): StoredSourceAsset | null {
  if (!plain(value) || !exact(value, ["assetId", "objectPath", "bytes", "sha256", "contentType", "alt", "credit", "consent", "reusedTargetAssetId", "sourceGeneration"])) return null;
  if (
    typeof value.assetId !== "string" || !UUID.test(value.assetId)
    || !isObjectPath(value.objectPath)
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 1
    || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)
    || typeof value.contentType !== "string" || value.contentType.length < 1
    || (value.alt !== null && typeof value.alt !== "string")
    || (value.credit !== null && typeof value.credit !== "string")
    || typeof value.consent !== "boolean"
    || (value.reusedTargetAssetId !== null && (typeof value.reusedTargetAssetId !== "string" || !UUID.test(value.reusedTargetAssetId)))
    || typeof value.sourceGeneration !== "string" || !/^[1-9][0-9]{0,30}$/.test(value.sourceGeneration)
  ) return null;
  return value as StoredSourceAsset;
}

function storedSource(value: unknown): StoredTranslationPayload["source"] | null {
  if (!plain(value) || !exact(value, ["id", "revision", "kind", "title", "lead", "blocks", "cover", "assets"])) return null;
  if (
    typeof value.id !== "string" || !UUID.test(value.id)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || typeof value.kind !== "string" || !PAGE_KINDS.includes(value.kind as (typeof PAGE_KINDS)[number])
    || typeof value.title !== "string"
    || (value.lead !== null && typeof value.lead !== "string")
    || !Array.isArray(value.blocks)
    || (value.cover !== null && (typeof value.cover !== "string" || !UUID.test(value.cover)))
    || !Array.isArray(value.assets)
  ) return null;
  const ids = new Set<string>();
  for (const asset of value.assets) {
    if (!plain(asset) || !exact(asset, ["assetId", "alt"]) || typeof asset.assetId !== "string" || !UUID.test(asset.assetId)
      || (asset.alt !== null && typeof asset.alt !== "string")) return null;
    const id = asset.assetId.toLowerCase();
    if (ids.has(id)) return null;
    ids.add(id);
  }
  const referenced = pageImageIds(value.blocks as never[]);
  if (value.cover !== null) referenced.add(value.cover.toLowerCase());
  if (referenced.size !== ids.size || [...referenced].some((id) => !ids.has(id))) return null;
  return value as unknown as StoredTranslationPayload["source"];
}

/** 認証済み envelope でも、schema/version と固定入力を再検証してから候補へ使う。 */
function parseStoredPayload(value: unknown): { payload: StoredTranslationPayload; candidate: TranslationCandidate | null } | null {
  if (!plain(value) || !exact(value, ["schema", "source", "sourceAssets", "sourceFields", "translatedFields"]) || value.schema !== 1 || !Array.isArray(value.sourceAssets)) return null;
  const source = storedSource(value.source);
  if (!source) return null;
  const assets = value.sourceAssets.map(storedAsset);
  if (assets.some((asset) => asset === null)) return null;
  const fixedAssets = assets as StoredSourceAsset[];
  const ids = new Set(fixedAssets.map((asset) => asset.assetId.toLowerCase()));
  if (ids.size !== fixedAssets.length) return null;
  const sourceAssets = new Map(source.assets?.map((asset) => [asset.assetId.toLowerCase(), asset.alt] as const));
  if (sourceAssets.size !== ids.size || fixedAssets.some((asset) => sourceAssets.get(asset.assetId.toLowerCase()) !== asset.alt)) return null;
  const sourceFields = fieldArray(value.sourceFields);
  if (!sourceFields) return null;
  const planned = planManagedTranslation(source);
  if (!planned.ok || JSON.stringify(planned.plan.fields) !== JSON.stringify(sourceFields)) return null;
  const translatedFields = value.translatedFields === null ? null : fieldArray(value.translatedFields);
  if (value.translatedFields !== null && !translatedFields) return null;
  let candidate: TranslationCandidate | null = null;
  if (translatedFields) {
    const parsed = parseManagedTranslationOutput({ translations: translatedFields }, sourceFields);
    if (!parsed.ok) return null;
    candidate = applyManagedTranslation(source, parsed.fields);
    if (!candidate) return null;
  }
  return { payload: { schema: 1, source, sourceAssets: fixedAssets, sourceFields, translatedFields }, candidate };
}

function decryptForOwner(cipher: PrivateJobPayloadCipher, owner: string, record: TranslationProposalPayload): { payload: StoredTranslationPayload; candidate: TranslationCandidate | null } | null {
  if (!record.envelope) return null;
  try {
    return parseStoredPayload(cipher.decrypt(record.envelope, {
      owner,
      proposalId: record.proposal.id,
      purpose: "managed-translation",
      expiresAt: record.proposal.expiresAt,
    }));
  } catch {
    return null;
  }
}

async function proposalDto(store: TranslationStore, cipher: PrivateJobPayloadCipher | null, owner: OwnerId, proposal: TranslationProposal | null): Promise<TranslationProposalDto | null> {
  if (!proposal) return null;
  const base: TranslationProposalDto = {
    id: proposal.id,
    status: proposal.status,
    generation: proposal.generation,
    sourceRevision: proposal.sourceRevision,
    targetRevision: proposal.targetRevision,
    targetPageId: proposal.targetPageId,
    expiresAt: proposal.expiresAt,
    omissions: [...proposal.omissions],
  };
  if (proposal.status !== "ready" || !cipher) return base;
  const record = await store.proposal(owner, proposal.id);
  if (!record) return base;
  const decoded = decryptForOwner(cipher, owner, record);
  return decoded?.candidate ? { ...base, sourceFields: decoded.payload.sourceFields, candidateFields: [...decoded.candidate.fields] } : base;
}

async function readState(store: TranslationStore, cipher: PrivateJobPayloadCipher | null, owner: OwnerId, page: Page): Promise<TranslationStateDto> {
  const relation = await store.relation(owner, page.id);
  const sourceId = relation?.sourcePageId ?? (page.lang === "ja" ? page.id : null);
  const latest = sourceId ? await store.latest(owner, sourceId) : null;
  return {
    page: { id: page.id, lang: page.lang, revision: page.revision },
    relation,
    proposal: await proposalDto(store, cipher, owner, latest),
    provider: { destination: "Anthropic API", metered: true },
  };
}

/** GET /api/pages/{id}/translation — managed relation と、まだ有効な本人の比較候補。 */
export function getTranslationRoute(request: Request, pageId: string, deps: TranslationApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/translation", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!UUID.test(pageId)) return notFoundResponse();
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const page = await store.page(session.userId, pageId);
    if (!page) return notFoundResponse();
    return jsonResponse(200, await readState(store, deps.cipher(), session.userId, page));
  });
}

function planProblem(reason: string): Response {
  const status = reason === "too_large" || reason === "too_many_fields" ? 413 : 422;
  return requestError(status, `translation_${reason}`);
}

function aiErrorCode(error: AnthropicError): string {
  return `ai_${error.kind}`;
}

/** POST /api/pages/{id}/translation/generate — 保存済みsourceだけを、明示操作で既存API providerへ送る。 */
export function generateTranslationRoute(request: Request, pageId: string, deps: TranslationApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/translation/generate", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    if (!UUID.test(pageId)) return notFoundResponse();
    const body = await readJsonBody(request, 4096);
    if (!body.ok) return body.response;
    const operationId = uuidBody(body.value, "operationId");
    if (!operationId) return errorResponse("bad_request");
    const store = deps.store();
    const storage = deps.storage();
    const cipher = deps.cipher();
    const backend = deps.compose();
    const usage = deps.usage();
    if (!store || !storage || !storage.copyObject || !cipher || !usage) return errorResponse("unavailable");
    if (!backend) return requestError(503, "ai_unavailable");
    const source = await store.source(session.userId, pageId);
    if (!source) return notFoundResponse();
    // フォルダは英語版を持たない（§3.2 の 3）
    if (source.source.kind === "folder") return folderResponse();

    const referenced = pageImageIds(source.source.blocks);
    if (source.source.cover) referenced.add(source.source.cover.toLowerCase());
    const assetById = new Map(source.assets.map((asset) => [asset.assetId.toLowerCase(), asset] as const));
    if ([...referenced].some((assetId) => !assetById.has(assetId))) return requestError(409, "translation_asset_unavailable");
    const fixedAssets: StoredSourceAsset[] = [];
    for (const assetId of [...referenced].sort()) {
      const asset = assetById.get(assetId)!;
      const stored = await storage.stat(asset.objectPath);
      if (!stored || stored.sizeBytes !== asset.bytes || stored.contentType !== asset.contentType || !stored.generation || !/^[1-9][0-9]{0,30}$/.test(stored.generation)) {
        return requestError(409, "translation_asset_unavailable");
      }
      fixedAssets.push({ ...asset, sourceGeneration: stored.generation });
    }
    const snapshot = sourceSnapshot(source, fixedAssets);
    const plan = planManagedTranslation(snapshot);
    if (!plan.ok) return planProblem(plan.reason);
    const now = deps.now?.() ?? new Date();
    const month = deps.monthKey(now);
    if (overLimit(await usage.get(session.userId, month), deps.limitUsd())) return requestError(429, "quota_exceeded");

    const newId = deps.newId ?? randomUUID;
    const proposalId = newId().toLowerCase();
    const targetPageId = source.target?.id ?? newId().toLowerCase();
    const expiresAt = new Date(now.getTime() + TRANSLATION_PROPOSAL_TTL_HOURS * 60 * 60 * 1000).toISOString();
    const initialPayload: StoredTranslationPayload = {
      schema: 1,
      source: snapshot,
      sourceAssets: fixedAssets,
      sourceFields: plan.plan.fields.map((field) => ({ ...field })),
      translatedFields: null,
    };
    const binding = { owner: session.userId, proposalId, purpose: "managed-translation" as const, expiresAt };
    const envelope = cipher.encrypt(initialPayload, binding);
    const hash = inputHash({
      source: snapshot,
      assets: fixedAssets,
      relationId: source.relation?.id ?? null,
      relationVersion: source.relation?.version ?? null,
      targetRevision: source.target?.revision ?? null,
    });
    const copies: StartTranslationProposalInput["copies"] = fixedAssets.map((asset) => ({
      sourceAssetId: asset.assetId,
      targetAssetId: asset.reusedTargetAssetId ?? newId().toLowerCase(),
      sourceObjectPath: asset.objectPath,
      sourceGeneration: asset.sourceGeneration,
      sourceBytes: asset.bytes,
      sourceSha256: asset.sha256,
      sourceContentType: asset.contentType,
      sourceAlt: asset.alt,
      sourceCredit: asset.credit,
      sourceConsent: asset.consent,
      reused: asset.reusedTargetAssetId !== null,
    }));
    const started = await store.start(session.userId, pageId, {
      proposalId,
      operationId,
      targetPageId,
      relationId: source.relation?.id ?? null,
      relationVersion: source.relation?.version ?? null,
      inputHash: hash,
      sourceRevision: source.source.revision,
      targetRevision: source.target?.revision ?? null,
      fieldCount: plan.plan.fields.length,
      codepointCount: plan.plan.codepoints,
      omissions: plan.plan.omissions,
      expiresAt,
      envelope,
      copies,
    });
    if (!started) return notFoundResponse();
    if (started === "conflict") return requestError(409, "translation_conflict");
    if (!started.created) {
      const dto = await proposalDto(store, cipher, session.userId, started.proposal);
      return jsonResponse(started.proposal.status === "generating" ? 202 : 200, { proposal: dto });
    }

    const prompt = buildManagedTranslationPrompt(plan.plan.fields);
    let report: AiUsageReport | null = null;
    let translated: TranslationField[];
    try {
      const completion = await backend.client.complete({
        system: prompt.system,
        user: prompt.user,
        maxTokens: Math.min(maxTokensLimit(deps.env ?? process.env), TRANSLATION_OUTPUT_MAX_TOKENS_BASE + plan.plan.codepoints * TRANSLATION_OUTPUT_TOKENS_PER_CODEPOINT),
      });
      report = completion.usage;
      await usage.record(session.userId, month, usageDelta(backend, completion.usage));
      let output: unknown;
      try { output = JSON.parse(completion.text); } catch { output = null; }
      const parsed = parseManagedTranslationOutput(output, plan.plan.fields);
      if (!parsed.ok || !applyManagedTranslation(snapshot, parsed.fields)) throw new AnthropicError("invalid_output", { reason: "not_json" });
      translated = parsed.fields.map((field) => ({ ...field }));
    } catch (error) {
      if (error instanceof AnthropicError && error.usage && report === null) {
        // usage 台帳の一時失敗でも durable proposal を generating のまま残さない。
        await usage.record(session.userId, month, usageDelta(backend, error.usage)).catch(() => null);
      }
      const code = error instanceof AnthropicError ? aiErrorCode(error) : "translation_failed";
      await store.fail(session.userId, started.proposal.id, started.proposal.generation, operationId, code).catch(() => false);
      return requestError(error instanceof AnthropicError && error.kind === "rate_limit" ? 429 : 502, code);
    }
    const readyPayload: StoredTranslationPayload = { ...initialPayload, translatedFields: translated };
    const readyEnvelope = cipher.encrypt(readyPayload, binding);
    const finished = await store.finish(session.userId, started.proposal.id, started.proposal.generation, operationId, readyEnvelope);
    if (!finished) return requestError(409, "translation_late_result");
    const record = await store.proposal(session.userId, started.proposal.id);
    return jsonResponse(201, { proposal: await proposalDto(store, cipher, session.userId, record?.proposal ?? null) });
  });
}

function targetAssetIdMap(record: TranslationProposalPayload): Map<string, string> {
  return new Map(record.copies.map((copy) => [copy.sourceAssetId.toLowerCase(), copy.targetAssetId.toLowerCase()] as const));
}

function rewriteCandidateAssets(candidate: TranslationCandidate, ids: ReadonlyMap<string, string>): TranslationCandidate | null {
  const next = structuredClone(candidate) as TranslationCandidate;
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return true;
    if (Array.isArray(value)) return value.every(visit);
    const node = value as Record<string, unknown>;
    if (node.type === "image") {
      const attrs = plain(node.attrs) ? node.attrs : null;
      if (!attrs || typeof attrs.assetId !== "string") return false;
      const target = ids.get(attrs.assetId.toLowerCase());
      if (!target) return false;
      attrs.assetId = target;
    }
    return !Array.isArray(node.content) || node.content.every(visit);
  };
  if (!visit(next.blocks)) return null;
  if (next.cover) {
    const targetCover = ids.get(next.cover.toLowerCase());
    if (!targetCover) return null;
    (next as { cover: string | null }).cover = targetCover;
  }
  return next;
}

function translatedAssetAlt(fields: readonly TranslationField[], sourceAssetId: string, fallback: string | null): string | null {
  return fields.find((field) => field.path === `assets[${sourceAssetId.toLowerCase()}].alt`)?.text ?? fallback;
}

function adoptionResponse(result: AdoptTranslationResult): Response {
  if (!result) return notFoundResponse();
  if (result.status === "adopted") return jsonResponse(200, result);
  if (result.status === "conflict") return requestError(409, "translation_conflict");
  if (result.status === "page_full" || result.status === "too_many_images") return requestError(413, result.status);
  return requestError(409, "translation_not_ready");
}

/** POST /api/pages/{id}/translation/proposals/{proposalId}/adopt — copy完了後に両revisionをCASして採用。 */
export function adoptTranslationRoute(request: Request, pageId: string, proposalId: string, deps: TranslationApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/translation/proposals/[proposalId]/adopt", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    if (!UUID.test(pageId) || !UUID.test(proposalId)) return notFoundResponse();
    const body = await readJsonBody(request, 4096);
    if (!body.ok) return body.response;
    const expected = adoptionBody(body.value);
    if (!expected) return errorResponse("bad_request");
    const store = deps.store();
    const storage = deps.storage();
    const cipher = deps.cipher();
    if (!store || !storage?.copyObject || !cipher) return errorResponse("unavailable");
    const record = await store.proposal(session.userId, proposalId);
    if (!record || record.proposal.sourceIdentity !== pageId.toLowerCase()) return notFoundResponse();
    if (record.proposal.status === "adopted") return jsonResponse(200, { status: "adopted", targetPageId: record.proposal.targetPageId });
    if (record.proposal.status !== "ready" || expected.sourceRevision !== record.proposal.sourceRevision || expected.targetRevision !== record.proposal.targetRevision) {
      return requestError(409, "translation_conflict");
    }
    const decoded = decryptForOwner(cipher, session.userId, record);
    if (!decoded?.candidate) return requestError(409, "translation_not_ready");
    for (const copy of record.copies) {
      if (copy.state === "reused" || copy.state === "copied") continue;
      if (!copy.sourceGeneration) return requestError(409, "translation_asset_unavailable");
      try {
        const copied = await storage.copyObject({
          sourceObjectPath: copy.sourceObjectPath,
          targetObjectPath: copy.targetObjectPath,
          sourceGeneration: copy.sourceGeneration,
        });
        const source = decoded.payload.sourceAssets.find((asset) => asset.assetId.toLowerCase() === copy.sourceAssetId.toLowerCase());
        if (!source || copied.sizeBytes !== source.bytes || copied.contentType !== source.contentType || copied.sourceGeneration !== copy.sourceGeneration) {
          await store.markCopy(session.userId, proposalId, copy.sourceAssetId, { state: "failed", errorCode: "copy_mismatch" });
          return requestError(502, "translation_copy_failed");
        }
        if (!(await store.markCopy(session.userId, proposalId, copy.sourceAssetId, { state: "copied", sourceGeneration: copied.sourceGeneration }))) {
          return requestError(409, "translation_conflict");
        }
      } catch (error) {
        const code = error instanceof StorageError ? `copy_${error.code}` : "copy_failed";
        await store.markCopy(session.userId, proposalId, copy.sourceAssetId, { state: "failed", errorCode: code }).catch(() => false);
        return requestError(502, "translation_copy_failed");
      }
    }
    const refreshed = await store.proposal(session.userId, proposalId);
    if (!refreshed) return notFoundResponse();
    const ids = targetAssetIdMap(refreshed);
    const candidate = rewriteCandidateAssets(decoded.candidate, ids);
    if (!candidate) return requestError(409, "translation_not_ready");
    const copies = new Map(refreshed.copies.map((copy) => [copy.sourceAssetId.toLowerCase(), copy] as const));
    const assets: AdoptTranslationInput["assets"] = decoded.payload.sourceAssets.map((source) => {
      const copy = copies.get(source.assetId.toLowerCase())!;
      return {
        sourceAssetId: source.assetId,
        sourceObjectPath: source.objectPath,
        sourceGeneration: source.sourceGeneration,
        sourceBytes: source.bytes,
        sourceSha256: source.sha256,
        sourceContentType: source.contentType,
        sourceAlt: source.alt,
        sourceCredit: source.credit,
        sourceConsent: source.consent,
        targetAssetId: copy.targetAssetId,
        targetObjectPath: copy.targetObjectPath,
        bytes: source.bytes,
        sha256: source.sha256,
        contentType: source.contentType,
        alt: translatedAssetAlt(decoded.candidate!.fields, source.assetId, source.alt),
        credit: source.credit,
        consent: source.consent,
        reused: copy.state === "reused",
      };
    });
    return adoptionResponse(await store.adopt(session.userId, proposalId, {
      sourceRevision: expected.sourceRevision,
      targetRevision: expected.targetRevision,
      kind: candidate.kind,
      title: candidate.title,
      lead: candidate.lead,
      blocks: candidate.blocks,
      cover: candidate.cover,
      assets,
    }));
  });
}

/** POST /api/pages/{target}/translation/review — 現在の両revisionを本人が確認した記録。 */
export function reviewTranslationRoute(request: Request, targetPageId: string, deps: TranslationApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/translation/review", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    if (!UUID.test(targetPageId)) return notFoundResponse();
    const body = await readJsonBody(request, 4096);
    if (!body.ok) return body.response;
    const revisions = revisionsBody(body.value);
    if (!revisions) return errorResponse("bad_request");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const result = await store.review(session.userId, targetPageId, revisions.sourceRevision, revisions.targetRevision);
    if (result === null) return notFoundResponse();
    if (result === "conflict") return requestError(409, "translation_conflict");
    if (result === "source_missing") return requestError(409, "translation_source_missing");
    return jsonResponse(200, { status: "reviewed" });
  });
}

/** POST /api/pages/{target}/translation/detach — source不明時だけ、現在ENを確認して独立化。 */
export function detachTranslationRoute(request: Request, targetPageId: string, deps: TranslationApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/translation/detach", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    if (!UUID.test(targetPageId)) return notFoundResponse();
    const body = await readJsonBody(request, 4096);
    if (!body.ok) return body.response;
    const targetRevision = targetRevisionBody(body.value);
    if (!targetRevision) return errorResponse("bad_request");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const result = await store.detach(session.userId, targetPageId, targetRevision);
    if (result === null) return notFoundResponse();
    if (result === "conflict") return requestError(409, "translation_conflict");
    if (result === "source_available") return requestError(409, "translation_source_available");
    return jsonResponse(200, { status: "detached" });
  });
}
