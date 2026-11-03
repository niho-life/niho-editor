import { describe, expect, it, vi } from "vitest";
import type { ClaimedGoogleDocsBatchItem } from "@niho/editor-store";
import type { GoogleDocsBatchConfig } from "../google-docs/batch-config";
import { GoogleDocsBatchNihoError, type NihoGoogleDocsBatchServiceClient } from "../google-docs/batch-niho";
import type { GoogleDocsBatchQueue } from "../google-docs/batch-queue";
import type { PrivateJobPayloadCipher } from "../storage/private-job-payload";
import type { OidcVerifyResult } from "./google-oidc";
import { runGoogleDocsBatchTask, sweepGoogleDocsBatchTasks, type GoogleDocsBatchWorkerDeps, type GoogleDocsBatchWorkerStore } from "./google-docs-batch-worker-api";

const JOB = "00000000-0000-4000-8000-000000000001";
const ITEM = "00000000-0000-4000-8000-000000000002";
const GRANT = "00000000-0000-4000-8000-000000000003";
const EXPORT = "00000000-0000-4000-8000-000000000004";
const DOCUMENT = "1AbCdEfGhIjKlMnOpQrStUvWxYz";
const NOW = Date.parse("2030-01-01T00:00:00.000Z");
const PAYLOAD = { schema: 1 as const, title: "合成の題名", markdown: "合成本文 😀" };
const HASH = "a109e877eeb8090777c9857539bcc7d55358a62c6d506eed359d364d271adbbc";

const config: Extract<GoogleDocsBatchConfig, { mode: "cloud-tasks" }> = {
  mode: "cloud-tasks",
  queue: {
    queue: "projects/synthetic-project/locations/test-region/queues/google-docs",
    workerUrl: "https://editor.example.invalid",
    invokerServiceAccount: "worker@synthetic-project.iam.gserviceaccount.com",
  },
  nihoApiBase: "https://niho.example.invalid/api",
  nihoAudience: "https://niho.example.invalid/api/internal/editor-docs-drive",
};

function claim(extra: Partial<ClaimedGoogleDocsBatchItem> = {}): ClaimedGoogleDocsBatchItem {
  return {
    owner: "synthetic-owner", jobId: JOB, itemId: ITEM, ordinal: 0, generation: 1, grantId: GRANT, exportId: EXPORT,
    payloadSha256: HASH, payloadBytes: 32, envelope: { keyId: "v1", nonce: new Uint8Array(12), ciphertext: new Uint8Array([1]), tag: new Uint8Array(16) },
    expiresAt: "2030-01-01T23:50:00.000Z", alreadySent: false, receiptOnly: false, ...extra,
  };
}

function request(path: "run" | "sweep", body: unknown, authorization = true): Request {
  return new Request(`https://editor.example.invalid/api/internal/google-docs/${path}`, {
    method: "POST", headers: { ...(authorization ? { authorization: "Bearer synthetic.jwt.token" } : {}), "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

function fixture(input: { claim?: ClaimedGoogleDocsBatchItem | null; alreadySent?: boolean } = {}) {
  const calls: string[] = [];
  const current = input.claim === undefined ? claim({ alreadySent: input.alreadySent ?? false }) : input.claim;
  const store: GoogleDocsBatchWorkerStore = {
    claim: vi.fn(async () => current),
    markSent: vi.fn(async () => { calls.push("sent"); return true; }),
    complete: vi.fn(async (_claim, documentId) => { calls.push(`complete:${documentId}`); return true; }),
    requeue: vi.fn(async (_claim, retry) => { calls.push(`requeue:${retry.errorCode}:${retry.retryable}`); return true; }),
    fail: vi.fn(async (_claim, failure) => { calls.push(`fail:${failure.errorCode}:${failure.stopFuture === true}`); return true; }),
    settleCancelled: vi.fn(async () => { calls.push("cancelled"); return true; }),
    prepared: vi.fn(async () => []),
    attachGrant: vi.fn(async () => true),
    recover: vi.fn(async () => 0),
    purge: vi.fn(async () => 0),
    outbox: vi.fn(async () => []),
    submitted: vi.fn(async () => true),
  };
  const service = {
    lookup: vi.fn<NihoGoogleDocsBatchServiceClient["lookup"]>(),
    status: vi.fn<NihoGoogleDocsBatchServiceClient["status"]>(async () => ({ exportId: EXPORT, status: "pending" as const, retryable: true })),
    export: vi.fn<NihoGoogleDocsBatchServiceClient["export"]>(async () => ({ exportId: EXPORT, status: "completed" as const, documentId: DOCUMENT, url: `https://docs.google.com/document/d/${DOCUMENT}/edit` })),
  };
  const queue = { enqueue: vi.fn(async () => ({ deduplicated: false })) };
  const cipher: PrivateJobPayloadCipher = { encrypt: vi.fn(), decrypt: vi.fn(() => PAYLOAD) };
  const deps: GoogleDocsBatchWorkerDeps = {
    config: () => config,
    verify: vi.fn(async (): Promise<OidcVerifyResult> => ({ ok: true })),
    store: () => store,
    cipher: () => cipher,
    service: () => service as unknown as NihoGoogleDocsBatchServiceClient,
    queue: () => queue as unknown as GoogleDocsBatchQueue,
    now: () => NOW,
  };
  return { deps, store, service, queue, cipher, calls };
}

describe("Google Docs batch worker", () => {
  it("rejects missing OIDC before reading a task or touching DB", async () => {
    const f = fixture();
    const response = await runGoogleDocsBatchTask(request("run", { jobId: JOB, generation: 1 }, false), f.deps);
    expect(response.status).toBe(401);
    expect(f.store.claim).not.toHaveBeenCalled();
  });

  it("duplicate/old generationでclaimを取れなければpayloadやNIHOへ触れずignoredにする", async () => {
    const f = fixture({ claim: null });
    const response = await runGoogleDocsBatchTask(request("run", { jobId: JOB, generation: 99 }), f.deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ignored" });
    expect(f.cipher.decrypt).not.toHaveBeenCalled();
    expect(f.service.status).not.toHaveBeenCalled();
    expect(f.service.export).not.toHaveBeenCalled();
  });

  it("local snapshot期限をNIHO grantより先に優先し、payload/exportを使わず後続を止める", async () => {
    const f = fixture({ claim: claim({ expiresAt: "2029-12-31T23:59:59.000Z" }) });
    const response = await runGoogleDocsBatchTask(request("run", { jobId: JOB, generation: 1 }), f.deps);
    expect(await response.json()).toEqual({ status: "expired" });
    expect(f.calls).toEqual(["fail:expired:true"]);
    expect(f.cipher.decrypt).not.toHaveBeenCalled();
    expect(f.service.export).not.toHaveBeenCalled();
  });

  it("marks sent before the first export and records a completed document", async () => {
    const f = fixture();
    const response = await runGoogleDocsBatchTask(request("run", { jobId: JOB, generation: 1 }), f.deps);
    expect(response.status).toBe(200);
    expect(f.calls).toEqual(["sent", `complete:${DOCUMENT}`]);
    expect(f.service.status).not.toHaveBeenCalled();
    expect(f.service.export).toHaveBeenCalledWith({ grantId: GRANT, jobId: JOB, actorId: "synthetic-owner", exportId: EXPORT, title: PAYLOAD.title, markdown: PAYLOAD.markdown });
  });

  it("checks status first after any send and never creates again for completed or UNCERTAIN/pending receipts", async () => {
    const completed = fixture({ alreadySent: true });
    completed.service.status.mockResolvedValueOnce({ exportId: EXPORT, status: "completed", documentId: DOCUMENT, url: "safe" });
    await runGoogleDocsBatchTask(request("run", { jobId: JOB, generation: 1 }), completed.deps);
    expect(completed.service.export).not.toHaveBeenCalled();
    expect(completed.calls).toEqual([`complete:${DOCUMENT}`]);

    const uncertain = fixture({ alreadySent: true });
    uncertain.service.status.mockResolvedValueOnce({ exportId: EXPORT, status: "pending", retryable: false });
    await runGoogleDocsBatchTask(request("run", { jobId: JOB, generation: 1 }), uncertain.deps);
    expect(uncertain.service.export).not.toHaveBeenCalled();
    expect(uncertain.calls).toEqual(["requeue:receipt_pending:false"]);
  });

  it("retries the same export id only when status says not-found or retryable", async () => {
    const missing = fixture({ alreadySent: true });
    missing.service.status.mockRejectedValueOnce(new GoogleDocsBatchNihoError(404, "export_not_found"));
    await runGoogleDocsBatchTask(request("run", { jobId: JOB, generation: 1 }), missing.deps);
    expect(missing.service.export).toHaveBeenCalledWith(expect.objectContaining({ exportId: EXPORT, title: PAYLOAD.title, markdown: PAYLOAD.markdown }));
    expect(missing.calls).toEqual(["sent", `complete:${DOCUMENT}`]);

    const retryable = fixture({ alreadySent: true });
    retryable.service.status.mockResolvedValueOnce({ exportId: EXPORT, status: "pending", retryable: true });
    retryable.service.export.mockResolvedValueOnce({ exportId: EXPORT, status: "pending", retryable: true });
    await runGoogleDocsBatchTask(request("run", { jobId: JOB, generation: 1 }), retryable.deps);
    expect(retryable.calls).toEqual(["sent", "requeue:receipt_retryable:true"]);
  });

  it("statusのnetwork unknownをnot-foundと扱わずcreateへ戻さない", async () => {
    const f = fixture({ alreadySent: true });
    f.service.status.mockRejectedValueOnce(new GoogleDocsBatchNihoError(503, "network_unknown"));
    await runGoogleDocsBatchTask(request("run", { jobId: JOB, generation: 1 }), f.deps);
    expect(f.service.export).not.toHaveBeenCalled();
    expect(f.calls).toEqual(["requeue:status_unknown:false"]);
  });

  it("settles a local cancel before export and stops future items on account binding changes", async () => {
    const cancelled = fixture();
    vi.mocked(cancelled.store.markSent).mockResolvedValueOnce(false);
    await runGoogleDocsBatchTask(request("run", { jobId: JOB, generation: 1 }), cancelled.deps);
    expect(cancelled.service.export).not.toHaveBeenCalled();
    expect(cancelled.calls).toEqual(["cancelled"]);

    const changed = fixture();
    changed.service.export.mockRejectedValueOnce(new GoogleDocsBatchNihoError(409, "google_account_changed"));
    await runGoogleDocsBatchTask(request("run", { jobId: JOB, generation: 1 }), changed.deps);
    expect(changed.calls).toEqual(["sent", "fail:google_account_changed:true"]);
  });

  it("owner cancel後のinflightはpayloadを復号せずreceiptだけを回収し、exportへ戻さない", async () => {
    const f = fixture({ claim: claim({ alreadySent: true, receiptOnly: true, envelope: null, expiresAt: "2029-12-31T23:59:59.000Z" }) });
    f.service.status.mockResolvedValueOnce({ exportId: EXPORT, status: "completed", documentId: DOCUMENT, url: "safe" });
    const response = await runGoogleDocsBatchTask(request("run", { jobId: JOB, generation: 1 }), f.deps);
    expect(response.status).toBe(200);
    expect(f.cipher.decrypt).not.toHaveBeenCalled();
    expect(f.service.status).toHaveBeenCalledTimes(1);
    expect(f.service.status).toHaveBeenCalledWith({
      grantId: GRANT, jobId: JOB, actorId: "synthetic-owner", exportId: EXPORT, receiptOnly: true,
    });
    expect(f.service.export).not.toHaveBeenCalled();
    expect(f.calls).toEqual([`complete:${DOCUMENT}`]);

    const missing = fixture({ claim: claim({ alreadySent: true, receiptOnly: true, envelope: null }) });
    missing.service.status.mockRejectedValueOnce(new GoogleDocsBatchNihoError(404, "export_not_found"));
    await runGoogleDocsBatchTask(request("run", { jobId: JOB, generation: 1 }), missing.deps);
    expect(missing.service.export).not.toHaveBeenCalled();
    expect(missing.calls).toEqual(["requeue:receipt_not_found:false"]);
  });

  it("sweep recovers registered grants by lookup only, recovers leases/outbox, and never mints", async () => {
    const f = fixture({ claim: null });
    vi.mocked(f.store.prepared).mockResolvedValueOnce([{ jobId: JOB, owner: "synthetic-owner" }]);
    f.service.lookup.mockResolvedValueOnce({ version: 1, grantId: GRANT, jobId: JOB, expiresAt: "2030-01-01T23:59:00.000Z" });
    vi.mocked(f.store.recover).mockResolvedValueOnce(2);
    vi.mocked(f.store.purge).mockResolvedValueOnce(1);
    vi.mocked(f.store.outbox).mockResolvedValueOnce([{ jobId: JOB, generation: 2, dispatchAttempt: 3 }]);
    f.queue.enqueue.mockRejectedValueOnce(new Error("lost queue response"));
    const response = await sweepGoogleDocsBatchTasks(request("sweep", {}), f.deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recoveredGrants: 1, recoveredDispatches: 2, expired: 1, dispatched: 0 });
    expect(vi.mocked(f.store.purge).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.store.recover).mock.invocationCallOrder[0]!);
    expect(f.store.attachGrant).toHaveBeenCalledWith("synthetic-owner", JOB, GRANT, "2030-01-01T23:59:00.000Z");
    expect(f.store.submitted).not.toHaveBeenCalled();
    expect(Object.keys(f.service)).not.toContain("grant");
  });
});
