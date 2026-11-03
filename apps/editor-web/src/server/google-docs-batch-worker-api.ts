import { hashGoogleDocsPayload, parseGoogleDocsBatchPayload } from "../google-docs/batch-payload";
import { GoogleDocsBatchNihoError, type NihoGoogleDocsBatchServiceClient } from "../google-docs/batch-niho";
import type { GoogleDocsBatchConfig } from "../google-docs/batch-config";
import type { GoogleDocsBatchQueue } from "../google-docs/batch-queue";
import type { ClaimedGoogleDocsBatchItem, GoogleDocsBatchOutboxEntry } from "@niho/editor-store";
import type { PrivateJobPayloadCipher } from "../storage/private-job-payload";
import type { OidcVerifyResult } from "./google-oidc";
import { errorResponse, guarded, jsonResponse, notFoundResponse, readJsonBody } from "./http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BEARER = /^Bearer ([A-Za-z0-9._-]{1,8192})$/i;

export type GoogleDocsBatchWorkerStore = {
  claim(jobId: string, generation: number): Promise<ClaimedGoogleDocsBatchItem | null>;
  markSent(claim: ClaimedGoogleDocsBatchItem): Promise<boolean>;
  complete(claim: ClaimedGoogleDocsBatchItem, documentId: string): Promise<boolean>;
  requeue(claim: ClaimedGoogleDocsBatchItem, input: { errorCode: string; retryable: boolean; delaySeconds: number }): Promise<boolean>;
  fail(claim: ClaimedGoogleDocsBatchItem, input: { errorCode: string; retryable: boolean; stopFuture?: boolean }): Promise<boolean>;
  settleCancelled(claim: ClaimedGoogleDocsBatchItem): Promise<boolean>;
  prepared(limit?: number): Promise<Array<{ jobId: string; owner: string }>>;
  attachGrant(owner: string, jobId: string, grantId: string, expiresAt: string): Promise<boolean>;
  recover(): Promise<number>;
  purge(): Promise<number>;
  outbox(limit?: number): Promise<GoogleDocsBatchOutboxEntry[]>;
  submitted(entry: GoogleDocsBatchOutboxEntry): Promise<boolean>;
};

export type GoogleDocsBatchWorkerDeps = {
  config: () => GoogleDocsBatchConfig | null;
  verify: (token: string, expected: { audience: string; allowedEmail: string }) => Promise<OidcVerifyResult>;
  store: () => GoogleDocsBatchWorkerStore | null;
  cipher: () => PrivateJobPayloadCipher | null;
  service: () => NihoGoogleDocsBatchServiceClient | null;
  queue: () => GoogleDocsBatchQueue | null;
  now?: () => number;
};

type Gate = { ok: true; config: Extract<GoogleDocsBatchConfig, { mode: "cloud-tasks" }> } | { ok: false; response: Response };

async function gate(request: Request, deps: GoogleDocsBatchWorkerDeps): Promise<Gate> {
  const config = deps.config();
  if (!config || config.mode !== "cloud-tasks") return { ok: false, response: notFoundResponse() };
  const match = BEARER.exec(request.headers.get("authorization") ?? "");
  if (!match) return { ok: false, response: errorResponse("unauthorized") };
  const verified = await deps.verify(match[1]!, { audience: config.queue.workerUrl, allowedEmail: config.queue.invokerServiceAccount });
  if (!verified.ok) return { ok: false, response: errorResponse("unauthorized") };
  if (request.headers.get("origin") !== null) return { ok: false, response: errorResponse("forbidden") };
  return { ok: true, config };
}

function runInput(value: unknown): { jobId: string; generation: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "generation,jobId" || typeof record.jobId !== "string" || !UUID.test(record.jobId)
    || !Number.isSafeInteger(record.generation) || (record.generation as number) < 1) return null;
  return { jobId: record.jobId.toLowerCase(), generation: record.generation as number };
}

function serviceInput(claim: ClaimedGoogleDocsBatchItem) {
  return { grantId: claim.grantId, jobId: claim.jobId, actorId: claim.owner, exportId: claim.exportId };
}

function terminalReason(reason: string): boolean {
  return [
    "grant_revoked", "grant_expired", "editor_connection_changed", "drive_connection_changed", "google_account_changed", "drive_not_connected",
    "export_payload_conflict", "drive_export_rejected", "credential_invalid", "auth_revoked",
  ].includes(reason);
}

async function statusFirst(
  store: GoogleDocsBatchWorkerStore,
  service: NihoGoogleDocsBatchServiceClient,
  claim: ClaimedGoogleDocsBatchItem,
  receiptOnly = false,
): Promise<"export" | "done"> {
  try {
    // The revoke request may still be in flight. Never let a local cancellation
    // trigger OAuth or a Google lookup through an otherwise active NIHO grant.
    const status = await service.status({ ...serviceInput(claim), ...(receiptOnly ? { receiptOnly: true } : {}) });
    if (status.status === "completed") {
      await store.complete(claim, status.documentId);
      return "done";
    }
    if (!status.retryable || receiptOnly) {
      await store.requeue(claim, { errorCode: "receipt_pending", retryable: false, delaySeconds: 10 });
      return "done";
    }
    return "export";
  } catch (error) {
    if (error instanceof GoogleDocsBatchNihoError && error.reason === "export_not_found") {
      if (!receiptOnly) return "export";
      await store.requeue(claim, { errorCode: "receipt_not_found", retryable: false, delaySeconds: 15 });
      return "done";
    }
    if (error instanceof GoogleDocsBatchNihoError && terminalReason(error.reason)) {
      await store.fail(claim, { errorCode: error.reason, retryable: false, stopFuture: true });
      return "done";
    }
    await store.requeue(claim, { errorCode: "status_unknown", retryable: false, delaySeconds: 15 });
    return "done";
  }
}

async function dispatchOutbox(store: GoogleDocsBatchWorkerStore, queue: GoogleDocsBatchQueue): Promise<number> {
  let dispatched = 0;
  for (const entry of await store.outbox(100)) {
    try {
      await queue.enqueue(entry);
      await store.submitted(entry);
      dispatched += 1;
    } catch {
      // pending row remains durable
    }
  }
  return dispatched;
}

/** POST /api/internal/google-docs/run — one task claims exactly the current item. */
export function runGoogleDocsBatchTask(request: Request, deps: GoogleDocsBatchWorkerDeps): Promise<Response> {
  return guarded("POST /api/internal/google-docs/run", async () => {
    const checked = await gate(request, deps);
    if (!checked.ok) return checked.response;
    const store = deps.store(); const cipher = deps.cipher(); const service = deps.service(); const queue = deps.queue();
    if (!store || !cipher || !service || !queue) return errorResponse("unavailable");
    const body = await readJsonBody(request, 1024);
    if (!body.ok) return body.response;
    const input = runInput(body.value);
    if (!input) return errorResponse("bad_request");
    const claim = await store.claim(input.jobId, input.generation);
    if (!claim) return jsonResponse(200, { status: "ignored" });
    // Owner cancel 後の inflight は、同じ exportId の receipt を読むだけ。payload の復号や export は行わない。
    if (claim.receiptOnly) {
      await statusFirst(store, service, claim, true);
      await dispatchOutbox(store, queue);
      return jsonResponse(200, { status: "receipt_checked" });
    }
    if ((deps.now?.() ?? Date.now()) >= Date.parse(claim.expiresAt)) {
      await store.fail(claim, { errorCode: "expired", retryable: false, stopFuture: true });
      return jsonResponse(200, { status: "expired" });
    }
    let payload;
    try {
      payload = parseGoogleDocsBatchPayload(cipher.decrypt(claim.envelope!, {
        owner: claim.owner, jobId: claim.jobId, itemId: claim.itemId, purpose: "google-docs", expiresAt: claim.expiresAt,
      }));
    } catch {
      payload = null;
    }
    if (!payload) {
      await store.fail(claim, { errorCode: "payload_unavailable", retryable: false, stopFuture: true });
      return jsonResponse(200, { status: "failed" });
    }
    const canonical = hashGoogleDocsPayload(payload.title, payload.markdown);
    if (canonical.payloadSha256 !== claim.payloadSha256 || canonical.payloadBytes !== claim.payloadBytes) {
      await store.fail(claim, { errorCode: "payload_mismatch", retryable: false, stopFuture: true });
      return jsonResponse(200, { status: "failed" });
    }
    if (claim.alreadySent && await statusFirst(store, service, claim) === "done") {
      await dispatchOutbox(store, queue);
      return jsonResponse(200, { status: "checked" });
    }
    if (!await store.markSent(claim)) {
      await store.settleCancelled(claim);
      return jsonResponse(200, { status: "cancelled" });
    }
    try {
      const result = await service.export({ ...serviceInput(claim), title: payload.title, markdown: payload.markdown });
      if (result.status === "completed") await store.complete(claim, result.documentId);
      else await store.requeue(claim, { errorCode: result.retryable ? "receipt_retryable" : "receipt_pending", retryable: result.retryable, delaySeconds: result.retryable ? 3 : 10 });
    } catch (error) {
      if (error instanceof GoogleDocsBatchNihoError && terminalReason(error.reason)) {
        await store.fail(claim, { errorCode: error.reason, retryable: false, stopFuture: true });
      } else {
        // A POST may have reached NIHO. Next generation always performs status first because sent_at is durable.
        await store.requeue(claim, { errorCode: "export_unknown", retryable: false, delaySeconds: 15 });
      }
    }
    await dispatchOutbox(store, queue);
    return jsonResponse(200, { status: "processed" });
  });
}

/** POST /api/internal/google-docs/sweep — lookup-only grant recovery, lease/outbox recovery and common expiry cleanup. */
export function sweepGoogleDocsBatchTasks(request: Request, deps: GoogleDocsBatchWorkerDeps): Promise<Response> {
  return guarded("POST /api/internal/google-docs/sweep", async () => {
    const checked = await gate(request, deps);
    if (!checked.ok) return checked.response;
    const store = deps.store(); const service = deps.service(); const queue = deps.queue();
    if (!store || !service || !queue || !deps.cipher()) return errorResponse("unavailable");
    const body = await readJsonBody(request, 1024);
    if (!body.ok) return body.response;
    if (typeof body.value !== "object" || body.value === null || Array.isArray(body.value) || Object.keys(body.value as object).length !== 0) return errorResponse("bad_request");
    let recoveredGrants = 0;
    for (const prepared of await store.prepared(100)) {
      try {
        const grant = await service.lookup(prepared.jobId, prepared.owner);
        if (await store.attachGrant(prepared.owner, prepared.jobId, grant.grantId, grant.expiresAt)) recoveredGrants += 1;
      } catch {
        // lookup 404 is not proof that mint failed and never authorizes this background worker to mint.
      }
    }
    const expired = await store.purge();
    // expiryでreceipt-onlyへ移したitemも、この同じsweepでlease/outbox回復する。
    const recoveredDispatches = await store.recover();
    const dispatched = await dispatchOutbox(store, queue);
    return jsonResponse(200, { recoveredGrants, recoveredDispatches, expired, dispatched });
  });
}
