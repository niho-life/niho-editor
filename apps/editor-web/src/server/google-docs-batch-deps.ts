import "server-only";
import {
  attachGoogleDocsBatchGrant,
  cancelGoogleDocsBatch,
  claimGoogleDocsBatchItem,
  completeGoogleDocsBatchItem,
  failGoogleDocsBatchItem,
  getGoogleDocsBatch,
  getLatestGoogleDocsBatchForRoot,
  listGoogleDocsBatchOutbox,
  listPreparedGoogleDocsBatches,
  markGoogleDocsBatchItemSent,
  markGoogleDocsBatchGrantRevoked,
  markGoogleDocsBatchOutboxSubmitted,
  prepareGoogleDocsBatch,
  purgeExpiredGoogleDocsBatches,
  readGoogleDocsBatchSource,
  readGoogleDocsBatchTree,
  recoverGoogleDocsBatchDispatches,
  requeueGoogleDocsBatchItem,
  retryGoogleDocsBatchItem,
  settleCancelledGoogleDocsBatchClaim,
} from "@niho/editor-store";
import { getAuthProvider } from "../auth";
import { resolveGoogleDocsBatchConfig, type GoogleDocsBatchConfig } from "../google-docs/batch-config";
import { NihoGoogleDocsBatchOwnerGateway, NihoGoogleDocsBatchServiceClient } from "../google-docs/batch-niho";
import { GoogleDocsBatchQueue } from "../google-docs/batch-queue";
import { getGoogleDocsCredential } from "../google-docs/runtime";
import { createPrivateJobPayloadCipher } from "../storage/private-job-payload";
import { verifyGoogleOidc } from "./google-oidc";
import { getPool } from "./db";
import type { GoogleDocsBatchApiDeps, GoogleDocsBatchStore } from "./google-docs-batch-api";
import type { GoogleDocsBatchWorkerDeps, GoogleDocsBatchWorkerStore } from "./google-docs-batch-worker-api";

function config(): GoogleDocsBatchConfig | null {
  try { return resolveGoogleDocsBatchConfig(process.env); } catch { return null; }
}

function cipher() {
  return process.env.EDITOR_PRIVATE_JOBS_MAINTENANCE_ENABLED === "true"
    ? createPrivateJobPayloadCipher({ EDITOR_PRIVATE_JOBS_KEY_RING: process.env.EDITOR_PRIVATE_JOBS_KEY_RING }) : null;
}

function batchStore(): GoogleDocsBatchStore | null {
  const pool = getPool();
  if (!pool) return null;
  return {
    tree: (owner, rootPageId) => readGoogleDocsBatchTree(pool, owner, rootPageId),
    source: (owner, page, options) => readGoogleDocsBatchSource(pool, owner, page, options),
    prepare: (owner, input) => prepareGoogleDocsBatch(pool, owner, input),
    get: (owner, jobId) => getGoogleDocsBatch(pool, owner, jobId),
    latest: (owner, rootPageId) => getLatestGoogleDocsBatchForRoot(pool, owner, rootPageId),
    attachGrant: (owner, jobId, grantId, expiresAt) => attachGoogleDocsBatchGrant(pool, owner, jobId, grantId, expiresAt),
    markGrantRevoked: (owner, jobId, grantId) => markGoogleDocsBatchGrantRevoked(pool, owner, jobId, grantId),
    outbox: (limit) => listGoogleDocsBatchOutbox(pool, limit),
    submitted: (entry) => markGoogleDocsBatchOutboxSubmitted(pool, entry),
    retry: (owner, jobId, ordinal) => retryGoogleDocsBatchItem(pool, owner, jobId, ordinal),
    cancel: (owner, jobId) => cancelGoogleDocsBatch(pool, owner, jobId),
  };
}

function workerStore(): GoogleDocsBatchWorkerStore | null {
  const pool = getPool();
  if (!pool) return null;
  return {
    claim: (jobId, generation) => claimGoogleDocsBatchItem(pool, jobId, generation),
    markSent: (claim) => markGoogleDocsBatchItemSent(pool, claim),
    complete: (claim, documentId) => completeGoogleDocsBatchItem(pool, claim, documentId),
    requeue: (claim, input) => requeueGoogleDocsBatchItem(pool, claim, input),
    fail: (claim, input) => failGoogleDocsBatchItem(pool, claim, input),
    settleCancelled: (claim) => settleCancelledGoogleDocsBatchClaim(pool, claim),
    prepared: (limit) => listPreparedGoogleDocsBatches(pool, limit),
    attachGrant: (owner, jobId, grantId, expiresAt) => attachGoogleDocsBatchGrant(pool, owner, jobId, grantId, expiresAt),
    recover: () => recoverGoogleDocsBatchDispatches(pool),
    purge: () => purgeExpiredGoogleDocsBatches(pool),
    outbox: (limit) => listGoogleDocsBatchOutbox(pool, limit),
    submitted: (entry) => markGoogleDocsBatchOutboxSubmitted(pool, entry),
  };
}

function ownerGateway(): NihoGoogleDocsBatchOwnerGateway | null {
  const resolved = config();
  return resolved?.mode === "cloud-tasks" ? new NihoGoogleDocsBatchOwnerGateway(resolved.nihoApiBase) : null;
}
function service(): NihoGoogleDocsBatchServiceClient | null {
  const resolved = config();
  return resolved?.mode === "cloud-tasks" ? new NihoGoogleDocsBatchServiceClient({ apiBase: resolved.nihoApiBase, audience: resolved.nihoAudience }) : null;
}
function queue(): GoogleDocsBatchQueue | null {
  const resolved = config();
  return resolved?.mode === "cloud-tasks" ? new GoogleDocsBatchQueue(resolved.queue) : null;
}

export const googleDocsBatchApiDeps: GoogleDocsBatchApiDeps = {
  auth: () => getAuthProvider(),
  store: batchStore,
  cipher,
  ownerGateway,
  service,
  queue,
  credential: (session, request) => getGoogleDocsCredential(getAuthProvider(), session, request),
  maintenanceReady: () => process.env.EDITOR_PRIVATE_JOBS_MAINTENANCE_ENABLED === "true",
};

export const googleDocsBatchWorkerDeps: GoogleDocsBatchWorkerDeps = {
  config,
  verify: (token, expected) => verifyGoogleOidc(token, expected),
  store: workerStore,
  cipher,
  service,
  queue,
};
