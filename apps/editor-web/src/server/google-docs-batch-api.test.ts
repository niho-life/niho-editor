import { describe, expect, it, vi } from "vitest";
import type {
  GoogleDocsBatchJob,
  GoogleDocsBatchTreePage,
  GoogleDocsBatchView,
  PrepareGoogleDocsBatchInput,
} from "@niho/editor-store";
import type { AuthProvider, Session, SessionRequest } from "../auth/types";
import { GoogleDocsBatchNihoError, type NihoGoogleDocsBatchOwnerGateway, type NihoGoogleDocsBatchServiceClient } from "../google-docs/batch-niho";
import type { GoogleDocsBatchQueue } from "../google-docs/batch-queue";
import type { PrivateJobPayloadCipher } from "../storage/private-job-payload";
import {
  cancelGoogleDocsBatchRoute,
  getLatestGoogleDocsBatchRoute,
  previewGoogleDocsBatch,
  startGoogleDocsBatch,
  type GoogleDocsBatchApiDeps,
  type GoogleDocsBatchStore,
} from "./google-docs-batch-api";

const ORIGIN = "https://editor.example.test";
const ROOT = "00000000-0000-4000-8000-000000000001";
const JOB = "00000000-0000-4000-8000-000000000002";
const ITEM = "00000000-0000-4000-8000-000000000003";
const EXPORT = "00000000-0000-4000-8000-000000000004";
const OPERATION = "00000000-0000-4000-8000-000000000005";
const GRANT = "00000000-0000-4000-8000-000000000006";
const CHILD = "00000000-0000-4000-8000-000000000007";
const EXPIRY = "2030-01-01T23:50:00.000Z";
const tree: GoogleDocsBatchTreePage[] = [{
  id: ROOT, title: "DBに保存した題名", revision: 7, parent: null, depth: 0,
  blocks: [{ type: "paragraph", content: [{ type: "text", text: "DBに保存した本文" }] }] as GoogleDocsBatchTreePage["blocks"],
  entities: [{ name: "人物" }], terms: [], transcriptSegments: [{ start: 0, speaker: 1, text: "合成文字起こし" }], speakerNames: { 1: "話者" }, hasRecording: true,
  hasBackground: true, hasTranscript: true,
  backgroundCount: 1, transcriptCount: 1,
}];
const options = { includeBackground: false, includeTranscript: false };

function request(path: string, body?: unknown, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(body === undefined ? {} : { origin, "content-type": "application/json" }), cookie: "synthetic-session=current" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function auth(owner: string | null = "owner"): AuthProvider {
  const unused = async () => { throw new Error("not used"); };
  return {
    mode: "niho",
    getSession: async () => owner ? ({ userId: owner, mode: "niho", sessionId: "connection", expiresAt: "2030-01-02T00:00:00.000Z" } satisfies Session) : null,
    beginLogin: unused, completeLogin: unused, logout: unused, apiToken: async () => null,
    docsApiToken: async () => "synthetic-docs-token",
  };
}
function job(input: PrepareGoogleDocsBatchInput, grantAttached = false): GoogleDocsBatchJob {
  return {
    id: input.jobId, rootPageId: input.rootPageId, operationId: input.operationId, status: grantAttached ? "queued" : "prepared",
    options: input.options, grantAttached, grantRevoked: false, nextOrdinal: 0, generation: 1, errorCode: null, expiresAt: input.expiresAt,
    createdAt: "2030-01-01T00:00:00.000Z", cancelledAt: null, completedAt: null,
  };
}

function fixture(overrides: Partial<GoogleDocsBatchApiDeps> = {}) {
  let current: GoogleDocsBatchView | null = null;
  let preparedInput: PrepareGoogleDocsBatchInput | null = null;
  const store: GoogleDocsBatchStore = {
    tree: vi.fn(async (owner) => owner === "owner" ? tree : null),
    source: vi.fn(async (owner, page) => owner === "owner" && page.id === ROOT ? { ok: true as const, page: tree[0]! } : null),
    prepare: vi.fn(async (_owner, input) => {
      preparedInput = input;
      const identity = input.selections[0]!;
      const payload = input.prepare(tree[0]!, { jobId: input.jobId, itemId: identity.itemId, expiresAt: input.expiresAt });
      current = {
        job: job(input),
        items: [{
          id: identity.itemId, ordinal: 0, pageId: ROOT, pageRevision: 7, exportId: identity.exportId,
          payloadSha256: payload.payloadSha256, payloadBytes: payload.payloadBytes, omissions: [...payload.omissions], status: "prepared",
          sentAt: null, documentId: null, retryable: false, errorCode: null, title: tree[0]!.title,
        }],
      };
      return { job: current.job, created: true };
    }),
    get: vi.fn(async (owner) => owner === "owner" ? current : null),
    latest: vi.fn(async (owner) => owner === "owner" ? current : null),
    attachGrant: vi.fn(async () => {
      if (!current) return false;
      current = { ...current, job: { ...current.job, grantAttached: true, status: "queued" }, items: current.items.map((item) => ({ ...item, status: "queued" })) };
      return true;
    }),
    markGrantRevoked: vi.fn(async () => {
      if (!current) return false;
      current = { ...current, job: { ...current.job, grantRevoked: true } };
      return true;
    }),
    outbox: vi.fn(async () => current?.job.grantAttached ? [{ jobId: current.job.id, generation: 1, dispatchAttempt: 1 }] : []),
    submitted: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    cancel: vi.fn(async () => ({ grantId: GRANT, inflight: true })),
  };
  const cipher: PrivateJobPayloadCipher = {
    encrypt: vi.fn(() => ({ keyId: "v1", nonce: new Uint8Array(12), ciphertext: new Uint8Array([1]), tag: new Uint8Array(16) })),
    decrypt: vi.fn(),
  };
  const gateway = {
    grant: vi.fn(async () => ({ version: 1 as const, grantId: GRANT, jobId: JOB, expiresAt: EXPIRY })),
    revoke: vi.fn(async () => undefined),
  };
  const service = { lookup: vi.fn(async () => ({ version: 1 as const, grantId: GRANT, jobId: JOB, expiresAt: EXPIRY })) };
  const queue = { enqueue: vi.fn(async () => ({ deduplicated: false })) };
  const credential = vi.fn(async (session: Session, request: SessionRequest) => {
    void session; void request;
    return { idToken: () => "synthetic-docs-token" };
  });
  const ids = [JOB, ITEM, EXPORT];
  const deps: GoogleDocsBatchApiDeps = {
    auth: () => auth(), store: () => store, cipher: () => cipher,
    ownerGateway: () => gateway as unknown as NihoGoogleDocsBatchOwnerGateway,
    service: () => service as unknown as NihoGoogleDocsBatchServiceClient,
    queue: () => queue as unknown as GoogleDocsBatchQueue,
    credential, maintenanceReady: () => true,
    now: () => new Date("2030-01-01T00:00:00.000Z"), newId: () => ids.shift()!, env: { EDITOR_ORIGIN: ORIGIN },
    ...overrides,
  };
  return { deps, store, cipher, gateway, service, queue, credential, current: () => current, preparedInput: () => preparedInput };
}
function startBody(extra: Record<string, unknown> = {}) {
  return { rootPageId: ROOT, operationId: OPERATION, selections: [{ pageId: ROOT, expectedRevision: 7 }], options, ...extra };
}

describe("Google Docs batch preview/start API", () => {
  it("previewはownerのactive treeを木順で読み、省略理由とrevisionだけを返す", async () => {
    const f = fixture();
    const response = await previewGoogleDocsBatch(request("/api/google-docs/batches/preview", { rootPageId: ROOT, options }), f.deps);
    expect(response.status).toBe(200);
    const body = await response.json() as { pages: Array<Record<string, unknown>> };
    expect(body.pages[0]).toMatchObject({ pageId: ROOT, title: "DBに保存した題名", revision: 7, depth: 0, exportable: true });
    expect(body.pages[0]!.omissions).toEqual(expect.arrayContaining([
      { reason: "background_not_selected", count: 1 }, { reason: "transcript_not_selected", count: 1 }, { reason: "original_audio_omitted", count: 1 },
    ]));
  });

  it("previewはrich sourceを木順に1件ずつ読み、metadata結果だけを保持する", async () => {
    const f = fixture();
    const child = { ...tree[0]!, id: CHILD, title: "子ページ", parent: ROOT, depth: 1 };
    let active = 0;
    let maxActive = 0;
    const source = vi.fn(async (_owner, page: { id: string }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { ok: true as const, page: page.id === ROOT ? tree[0]! : child };
    });
    const store: GoogleDocsBatchStore = {
      ...f.store,
      tree: vi.fn(async () => [tree[0]!, child]),
      source,
    };
    const response = await previewGoogleDocsBatch(
      request("/api/google-docs/batches/preview", { rootPageId: ROOT, options }),
      { ...f.deps, store: () => store },
    );
    expect(response.status).toBe(200);
    expect(source.mock.calls.map((call) => call[1].id)).toEqual([ROOT, CHILD]);
    expect(maxActive).toBe(1);
  });

  it("previewはSQL上限を超えたraw sourceを本文変換や外部呼出し前に拒否する", async () => {
    const f = fixture();
    const store: GoogleDocsBatchStore = {
      ...f.store,
      source: vi.fn(async () => ({ ok: false as const, reason: "source_too_large" as const })),
    };
    const response = await previewGoogleDocsBatch(
      request("/api/google-docs/batches/preview", { rootPageId: ROOT, options }),
      { ...f.deps, store: () => store },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pages: [{ pageId: ROOT, exportable: false, problem: "source_too_large" }], canStart: false });
    expect(f.gateway.grant).not.toHaveBeenCalled();
    expect(f.queue.enqueue).not.toHaveBeenCalled();
  });

  it("clientのtitle/markdownを拒み、server保存本文をtransaction内で暗号化してから外部grant/queueへ進む", async () => {
    const f = fixture();
    const invalid = await startGoogleDocsBatch(request("/api/google-docs/batches", startBody({ title: "横入り" })), f.deps);
    expect(invalid.status).toBe(400);
    const response = await startGoogleDocsBatch(request("/api/google-docs/batches", startBody()), f.deps);
    expect(response.status).toBe(202);
    expect(f.cipher.encrypt).toHaveBeenCalledWith(
      expect.objectContaining({ schema: 1, title: "DBに保存した題名", markdown: expect.stringContaining("DBに保存した本文") }),
      expect.objectContaining({ owner: "owner", jobId: JOB, itemId: ITEM, purpose: "google-docs", expiresAt: EXPIRY }),
    );
    expect(f.gateway.grant).toHaveBeenCalledWith(expect.anything(), JOB, [expect.objectContaining({ exportId: EXPORT, payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
    expect(f.queue.enqueue).toHaveBeenCalledWith({ jobId: JOB, generation: 1, dispatchAttempt: 1 });
    expect(f.credential.mock.calls[0]![1]).toBeInstanceOf(Request);
  });

  it("grant応答消失は同じjobのinternal lookupへ回復し、新job/grantを作らない", async () => {
    const f = fixture();
    f.gateway.grant.mockRejectedValueOnce(new GoogleDocsBatchNihoError(503, "network_unknown", true));
    const response = await startGoogleDocsBatch(request("/api/google-docs/batches", startBody()), f.deps);
    expect(response.status).toBe(202);
    expect(f.service.lookup).toHaveBeenCalledWith(JOB, "owner");
    expect(f.store.attachGrant).toHaveBeenCalledWith("owner", JOB, GRANT, EXPIRY);
  });

  it("lookup 404は新しいgrant発行の許可にせずpreparedを残して503", async () => {
    const f = fixture();
    f.gateway.grant.mockRejectedValueOnce(new GoogleDocsBatchNihoError(503, "network_unknown", true));
    f.service.lookup.mockRejectedValueOnce(new GoogleDocsBatchNihoError(404, "grant_not_found"));
    const response = await startGoogleDocsBatch(request("/api/google-docs/batches", startBody()), f.deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "grant_not_registered" });
    expect(f.current()?.job.status).toBe("prepared");
    expect(f.store.attachGrant).not.toHaveBeenCalled();
  });

  it("internal lookupのservice identity拒否をbrowser本人の401へ降格せず503で再試行可能にする", async () => {
    const f = fixture();
    f.gateway.grant.mockRejectedValueOnce(new GoogleDocsBatchNihoError(503, "network_unknown", true));
    f.service.lookup.mockRejectedValueOnce(new GoogleDocsBatchNihoError(401, "unauthorized"));
    const response = await startGoogleDocsBatch(request("/api/google-docs/batches", startBody()), f.deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "google_docs_unavailable" });
  });

  it("queue応答消失でもsnapshot/outboxを消さず202にし、submitted扱いにしない", async () => {
    const f = fixture();
    f.queue.enqueue.mockRejectedValueOnce(new Error("lost response"));
    const response = await startGoogleDocsBatch(request("/api/google-docs/batches", startBody()), f.deps);
    expect(response.status).toBe(202);
    expect(f.store.submitted).not.toHaveBeenCalled();
    expect(f.current()?.job.status).toBe("queued");
  });

  it("keyring/maintenance/DBが無ければ外部やtokenを触らず503", async () => {
    for (const override of [
      { cipher: () => null }, { maintenanceReady: () => false }, { store: () => null },
    ] satisfies Array<Partial<GoogleDocsBatchApiDeps>>) {
      const f = fixture(override);
      const response = await startGoogleDocsBatch(request("/api/google-docs/batches", startBody()), f.deps);
      expect(response.status).toBe(503);
      expect(f.credential).not.toHaveBeenCalled();
      expect(f.gateway.grant).not.toHaveBeenCalled();
    }
  });

  it("same-originと認証を先に拒み、other ownerのlatestは404", async () => {
    const f = fixture();
    expect((await startGoogleDocsBatch(request("/api/google-docs/batches", startBody(), "https://evil.invalid"), f.deps)).status).toBe(403);
    const noAuth = fixture({ auth: () => auth(null) });
    expect((await previewGoogleDocsBatch(request("/api/google-docs/batches/preview", { rootPageId: ROOT, options }), noAuth.deps)).status).toBe(401);
    const other = fixture({ auth: () => auth("other") });
    expect((await getLatestGoogleDocsBatchRoute(request(`/api/google-docs/batches/root/${ROOT}`), ROOT, other.deps)).status).toBe(404);
  });
});

describe("Google Docs batch cancel", () => {
  it("revoke成功をjobへCAS記録し、reload後の不要な再試行を止める", async () => {
    const f = fixture();
    await startGoogleDocsBatch(request("/api/google-docs/batches", startBody()), f.deps);
    const response = await cancelGoogleDocsBatchRoute(new Request(`${ORIGIN}/api/google-docs/batches/${JOB}`, { method: "DELETE", headers: { origin: ORIGIN } }), JOB, f.deps);
    expect(response.status).toBe(200);
    expect(f.gateway.revoke).toHaveBeenCalledWith(expect.anything(), GRANT);
    expect(f.store.markGrantRevoked).toHaveBeenCalledWith("owner", JOB, GRANT);
  });

  it("本人tokenを再取得できなくてもlocal future/payload停止を先に確定し、revoke pendingを返す", async () => {
    const f = fixture({ credential: vi.fn(async () => null) });
    await startGoogleDocsBatch(request("/api/google-docs/batches", startBody()), { ...f.deps, credential: async () => ({ idToken: () => "token" }) });
    const response = await cancelGoogleDocsBatchRoute(new Request(`${ORIGIN}/api/google-docs/batches/${JOB}`, { method: "DELETE", headers: { origin: ORIGIN } }), JOB, f.deps);
    expect(response.status).toBe(202);
    expect(f.store.cancel).toHaveBeenCalledWith("owner", JOB);
    expect(f.gateway.revoke).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ revokePending: true, error: "google_docs_unavailable" });
  });

  it("gateway設定が一時的に閉じてもlocal cancelは止めずrevoke pendingにする", async () => {
    const f = fixture({ ownerGateway: () => null });
    const response = await cancelGoogleDocsBatchRoute(new Request(`${ORIGIN}/api/google-docs/batches/${JOB}`, { method: "DELETE", headers: { origin: ORIGIN } }), JOB, f.deps);
    expect(response.status).toBe(202);
    expect(f.store.cancel).toHaveBeenCalledWith("owner", JOB);
    expect(await response.json()).toMatchObject({ revokePending: true });
  });
});
