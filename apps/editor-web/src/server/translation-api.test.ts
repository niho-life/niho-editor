import { describe, expect, it, vi } from "vitest";
import type { AiUsageTotals, Page, TranslationProposal, TranslationProposalPayload, TranslationSource } from "@niho/editor-store";
import { AnthropicError, type AnthropicClient } from "../ai/anthropic";
import { createPrivateJobPayloadCipher } from "../storage/private-job-payload";
import type { ObjectStorage } from "../storage/types";
import { generateTranslationRoute, type TranslationApiDeps, type TranslationStore } from "./translation-api";

const OWNER = "synthetic-api-owner";
const PAGE_ID = "00000000-0000-4000-8000-000000000001";
const OPERATION_ID = "00000000-0000-4000-8000-000000000002";
const PROPOSAL_ID = "00000000-0000-4000-8000-000000000003";
const TARGET_ID = "00000000-0000-4000-8000-000000000004";
const NOW = new Date("2030-01-01T00:00:00.000Z");

const page: Page = {
  id: PAGE_ID,
  kind: "article",
  title: "合成の題名",
  lang: "ja",
  blocks: [{ type: "paragraph", content: [{ type: "text", text: "合成の本文 [CONFIRM: synthetic fact]" }] }],
  cover: null,
  lead: "合成のリード",
  parent: null,
  recipe: null,
  stepStatus: null,
  sortOrder: 0,
  revision: 7,
  createdAt: "2029-12-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
};

const source: TranslationSource = {
  source: { id: PAGE_ID, kind: "article", title: page.title, lead: page.lead, blocks: page.blocks, cover: null, revision: page.revision },
  relation: null,
  target: null,
  assets: [],
};

function request(body: unknown): Request {
  return new Request(`https://editor.test/api/pages/${PAGE_ID}/translation/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://editor.test" },
    body: JSON.stringify(body),
  });
}

function fixture() {
  let record: TranslationProposalPayload | null = null;
  let idIndex = 0;
  const complete = vi.fn<AnthropicClient["complete"]>(async (input) => {
    const body = JSON.parse(input.user) as { fields: Array<{ path: string; text: string }> };
    const translations = body.fields.map((field) => ({
      path: field.path,
      text: field.text.includes("[CONFIRM:") ? `Synthetic English [CONFIRM: synthetic fact]` : `Synthetic English: ${field.path}`,
    }));
    return { text: JSON.stringify({ translations }), usage: { model: "fake", inputTokens: 20, outputTokens: 10 } };
  });
  const store: TranslationStore = {
    page: async () => page,
    source: async () => source,
    start: async (_owner, _pageId, input) => {
      if (record) return { proposal: record.proposal, created: false };
      const proposal: TranslationProposal = {
        id: input.proposalId,
        sourcePageId: PAGE_ID,
        sourceIdentity: PAGE_ID,
        targetPageId: input.targetPageId,
        relationId: null,
        relationVersion: null,
        generation: 1,
        operationId: input.operationId,
        inputHash: input.inputHash,
        sourceRevision: input.sourceRevision,
        targetRevision: null,
        status: "generating",
        errorCode: null,
        fieldCount: input.fieldCount,
        codepointCount: input.codepointCount,
        omissions: [...input.omissions],
        expiresAt: input.expiresAt,
        createdAt: NOW.toISOString(),
      };
      record = { proposal, envelope: input.envelope, copies: [] };
      return { proposal, created: true };
    },
    latest: async () => record?.proposal ?? null,
    proposal: async () => record,
    finish: async (_owner, proposalId, generation, operationId, envelope) => {
      if (!record || record.proposal.id !== proposalId || record.proposal.generation !== generation || record.proposal.operationId !== operationId || record.proposal.status !== "generating") return false;
      record = { ...record, proposal: { ...record.proposal, status: "ready" }, envelope };
      return true;
    },
    fail: async (_owner, proposalId, generation, operationId, errorCode) => {
      if (!record || record.proposal.id !== proposalId || record.proposal.generation !== generation || record.proposal.operationId !== operationId || record.proposal.status !== "generating") return false;
      record = { ...record, proposal: { ...record.proposal, status: "failed", errorCode }, envelope: null };
      return true;
    },
    markCopy: async () => true,
    adopt: async () => null,
    relation: async () => null,
    review: async () => null,
    detach: async () => null,
  };
  const usage: AiUsageTotals = { owner: OWNER, month: "2030-01", source: "server", requests: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 };
  const recordUsage = vi.fn(async () => ({ ...usage, requests: 1 }));
  const storage: ObjectStorage = {
    kind: "fake",
    startUpload: async () => { throw new Error("unused"); },
    stat: async () => null,
    copyObject: async () => { throw new Error("unused"); },
    readObject: async () => null,
  };
  const cipher = createPrivateJobPayloadCipher({
    EDITOR_PRIVATE_JOBS_KEY_RING: JSON.stringify({ active: "synthetic-v1", keys: { "synthetic-v1": Buffer.alloc(32, 7).toString("base64") } }),
  })!;
  const ids = [PROPOSAL_ID, TARGET_ID];
  const deps: TranslationApiDeps = {
    auth: () => ({ getSession: async () => ({ userId: OWNER, mode: "stub" }) }) as never,
    store: () => store,
    storage: () => storage,
    cipher: () => cipher,
    compose: () => ({
      client: { complete, converse: async () => { throw new Error("unused"); } },
      model: "fake",
      provider: null,
      route: "server",
      engine: "fake:fake",
    }),
    usage: () => ({ get: async () => usage, record: recordUsage }),
    limitUsd: () => 10,
    monthKey: () => "2030-01",
    now: () => NOW,
    newId: () => ids[idIndex++] ?? "00000000-0000-4000-8000-000000000099",
    env: { EDITOR_ORIGIN: "https://editor.test", EDITOR_AI_MAX_TOKENS: "12000" },
  };
  return { deps, complete, recordUsage, getRecord: () => record };
}

describe("managed translation API", () => {
  it("uses only the server-saved source, records the existing usage path, and replays without a second provider call", async () => {
    const f = fixture();
    const first = await generateTranslationRoute(request({ operationId: OPERATION_ID }), PAGE_ID, f.deps);
    expect(first.status).toBe(201);
    const body = await first.json() as { proposal: { status: string; sourceFields: unknown[]; candidateFields: unknown[] } };
    expect(body.proposal.status).toBe("ready");
    expect(body.proposal.sourceFields).toHaveLength(3);
    expect(body.proposal.candidateFields).toHaveLength(3);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.recordUsage).toHaveBeenCalledTimes(1);
    expect(f.getRecord()?.proposal.status).toBe("ready");

    const replay = await generateTranslationRoute(request({ operationId: OPERATION_ID }), PAGE_ID, f.deps);
    expect(replay.status).toBe(200);
    expect(f.complete, "same operation returns the durable proposal without another charge").toHaveBeenCalledTimes(1);
    expect(f.recordUsage).toHaveBeenCalledTimes(1);
  });

  it("rejects page-bound audio before a provider call or durable proposal", async () => {
    const f = fixture();
    const current = f.deps.store()!;
    const response = await generateTranslationRoute(request({ operationId: OPERATION_ID }), PAGE_ID, {
      ...f.deps, store: () => ({ ...current, source: async () => ({ ...source, source: {
        ...source.source, blocks: [...source.source.blocks, { type: "recording", attrs: { assetId: PROPOSAL_ID } }],
      } }) }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "translation_recording_requires_text_page" });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.getRecord()).toBeNull();
  });

  it("rejects browser-supplied text before reading source or calling the provider", async () => {
    const f = fixture();
    const response = await generateTranslationRoute(request({ operationId: OPERATION_ID, title: "browser-controlled text" }), PAGE_ID, f.deps);
    expect(response.status).toBe(400);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.getRecord()).toBeNull();
  });

  it("returns 409 before provider use when the server-side source or relation CAS changed", async () => {
    const f = fixture();
    const current = f.deps.store()!;
    const response = await generateTranslationRoute(request({ operationId: OPERATION_ID }), PAGE_ID, {
      ...f.deps,
      store: () => ({ ...current, start: async () => "conflict" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "translation_conflict" });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.recordUsage).not.toHaveBeenCalled();
  });

  it("fixes the durable proposal as failed even when recording usage for a rejected provider response also fails", async () => {
    const f = fixture();
    f.complete.mockRejectedValueOnce(new AnthropicError("invalid_output", {
      reason: "not_json",
      usage: { model: "fake", inputTokens: 8, outputTokens: 3 },
    }));
    f.recordUsage.mockRejectedValueOnce(new Error("synthetic usage outage"));
    const response = await generateTranslationRoute(request({ operationId: OPERATION_ID }), PAGE_ID, f.deps);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "ai_invalid_output" });
    expect(f.getRecord()?.proposal).toMatchObject({ status: "failed", errorCode: "ai_invalid_output" });
    expect(f.getRecord()?.envelope).toBeNull();
  });
});
