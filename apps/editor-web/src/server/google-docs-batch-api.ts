import { createHash, randomUUID } from "node:crypto";
import {
  GOOGLE_DOCS_BATCH_MAX_BYTES,
  GOOGLE_DOCS_BATCH_MAX_PAGES,
  GOOGLE_DOCS_BATCH_TTL_MINUTES,
  GoogleDocsBatchStoreError,
  type GoogleDocsBatchCancellation,
  type GoogleDocsBatchJob,
  type GoogleDocsBatchOptions,
  type GoogleDocsBatchOutboxEntry,
  type GoogleDocsBatchSourceResult,
  type GoogleDocsBatchTreePageMetadata,
  type GoogleDocsBatchView,
  type OwnerId,
  type PrepareGoogleDocsBatchInput,
} from "@niho/editor-store";
import type { AuthProvider, Session, SessionRequest } from "../auth/types";
import { planGoogleDocsBatchPayload } from "../google-docs/batch-payload";
import { GoogleDocsBatchNihoError, type GoogleDocsBatchGrant, type GoogleDocsBatchGrantItem, type NihoGoogleDocsBatchOwnerGateway, type NihoGoogleDocsBatchServiceClient } from "../google-docs/batch-niho";
import type { GoogleDocsBatchQueue } from "../google-docs/batch-queue";
import type { GoogleDocsCredential } from "../google-docs/gateway";
import type { PrivateJobPayloadCipher } from "../storage/private-job-payload";
import { errorResponse, guarded, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type GoogleDocsBatchStore = {
  tree(owner: OwnerId, rootPageId: string): Promise<GoogleDocsBatchTreePageMetadata[] | null>;
  source(owner: OwnerId, page: GoogleDocsBatchTreePageMetadata, options: GoogleDocsBatchOptions): Promise<GoogleDocsBatchSourceResult | null>;
  prepare(owner: OwnerId, input: PrepareGoogleDocsBatchInput): Promise<{ job: GoogleDocsBatchJob; created: boolean }>;
  get(owner: OwnerId, jobId: string): Promise<GoogleDocsBatchView | null>;
  latest(owner: OwnerId, rootPageId: string): Promise<GoogleDocsBatchView | null>;
  attachGrant(owner: OwnerId, jobId: string, grantId: string, expiresAt: string): Promise<boolean>;
  markGrantRevoked(owner: OwnerId, jobId: string, grantId: string): Promise<boolean>;
  outbox(limit?: number): Promise<GoogleDocsBatchOutboxEntry[]>;
  submitted(entry: GoogleDocsBatchOutboxEntry): Promise<boolean>;
  retry(owner: OwnerId, jobId: string, ordinal: number): Promise<boolean>;
  cancel(owner: OwnerId, jobId: string): Promise<GoogleDocsBatchCancellation | null>;
};

export type GoogleDocsBatchApiDeps = {
  auth: () => AuthProvider;
  store: () => GoogleDocsBatchStore | null;
  cipher: () => PrivateJobPayloadCipher | null;
  ownerGateway: () => NihoGoogleDocsBatchOwnerGateway | null;
  service: () => NihoGoogleDocsBatchServiceClient | null;
  queue: () => GoogleDocsBatchQueue | null;
  credential: (session: Session, request: SessionRequest) => Promise<GoogleDocsCredential | null>;
  maintenanceReady: () => boolean;
  now?: () => Date;
  newId?: () => string;
  env?: Readonly<Record<string, string | undefined>>;
};

type BatchStart = {
  rootPageId: string;
  operationId: string;
  selections: Array<{ pageId: string; expectedRevision: number }>;
  options: GoogleDocsBatchOptions;
};

class PreparationError extends Error {
  constructor(readonly code: "empty" | "unsupported_markdown" | "payload_too_large") { super(code); }
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function optionsOf(value: unknown): GoogleDocsBatchOptions | null {
  if (!plain(value) || !exact(value, ["includeBackground", "includeTranscript"])
    || typeof value.includeBackground !== "boolean" || typeof value.includeTranscript !== "boolean") return null;
  return { includeBackground: value.includeBackground, includeTranscript: value.includeTranscript };
}
function startOf(value: unknown): BatchStart | null {
  if (!plain(value) || !exact(value, ["rootPageId", "operationId", "selections", "options"])
    || typeof value.rootPageId !== "string" || !UUID.test(value.rootPageId)
    || typeof value.operationId !== "string" || !UUID.test(value.operationId) || !Array.isArray(value.selections)) return null;
  const options = optionsOf(value.options);
  if (!options || value.selections.length < 1 || value.selections.length > GOOGLE_DOCS_BATCH_MAX_PAGES) return null;
  const seen = new Set<string>();
  const selections: BatchStart["selections"] = [];
  for (const item of value.selections) {
    if (!plain(item) || !exact(item, ["pageId", "expectedRevision"]) || typeof item.pageId !== "string" || !UUID.test(item.pageId)
      || !Number.isSafeInteger(item.expectedRevision) || (item.expectedRevision as number) < 1) return null;
    const pageId = item.pageId.toLowerCase();
    if (seen.has(pageId)) return null;
    seen.add(pageId);
    selections.push({ pageId, expectedRevision: item.expectedRevision as number });
  }
  return { rootPageId: value.rootPageId.toLowerCase(), operationId: value.operationId.toLowerCase(), selections, options };
}
function previewOf(value: unknown): { rootPageId: string; options: GoogleDocsBatchOptions } | null {
  if (!plain(value) || !exact(value, ["rootPageId", "options"]) || typeof value.rootPageId !== "string" || !UUID.test(value.rootPageId)) return null;
  const options = optionsOf(value.options);
  return options ? { rootPageId: value.rootPageId.toLowerCase(), options } : null;
}

function requestHash(input: BatchStart): string {
  return createHash("sha256").update(JSON.stringify({ rootPageId: input.rootPageId, selections: input.selections, options: input.options }), "utf8").digest("hex");
}

function dto(view: GoogleDocsBatchView): unknown {
  return {
    job: {
      id: view.job.id, rootPageId: view.job.rootPageId, operationId: view.job.operationId, status: view.job.status, options: view.job.options,
      nextOrdinal: view.job.nextOrdinal, errorCode: view.job.errorCode, expiresAt: view.job.expiresAt,
      createdAt: view.job.createdAt, cancelledAt: view.job.cancelledAt, completedAt: view.job.completedAt,
    },
    items: view.items.map((item) => ({
      ordinal: item.ordinal, pageId: item.pageId, pageRevision: item.pageRevision, title: item.title, status: item.status,
      omissions: item.omissions, sent: item.sentAt !== null, documentId: item.documentId,
      url: item.documentId ? `https://docs.google.com/document/d/${item.documentId}/edit` : null,
      retryable: item.retryable, errorCode: item.errorCode,
    })),
    revokePending: ["cancelling", "cancelled"].includes(view.job.status) && view.job.grantAttached && !view.job.grantRevoked,
  };
}

function storeFailure(error: unknown): Response | null {
  if (error instanceof PreparationError) return jsonResponse(error.code === "payload_too_large" ? 413 : 422, { error: error.code });
  if (!(error instanceof GoogleDocsBatchStoreError)) return null;
  if (error.code === "not_found") return notFoundResponse();
  const status = error.code === "source_too_large" || error.code === "payload_too_large" || error.code === "too_many_pages" ? 413 : 409;
  return jsonResponse(status, { error: error.code });
}

function nihoFailure(error: unknown, caller: "owner" | "service" = "owner"): Response {
  if (!(error instanceof GoogleDocsBatchNihoError)) return jsonResponse(503, { error: "google_docs_unavailable" });
  if (error.reason === "grant_not_found") return jsonResponse(503, { error: "grant_not_registered" });
  // runtime service identityの拒否を、現在のbrowser本人の未認証へ降格しない。
  if (caller === "service" && (error.status === 401 || error.status === 403)) return jsonResponse(503, { error: "google_docs_unavailable" });
  if (error.status === 401) return errorResponse("unauthorized");
  if (error.status === 404) return notFoundResponse();
  if (error.status === 409) return jsonResponse(409, { error: error.reason });
  return jsonResponse(503, { error: error.reason === "invalid_response" ? "google_docs_unavailable" : error.reason });
}

async function sessionOf(request: Request, deps: GoogleDocsBatchApiDeps): Promise<Session | Response> {
  const session = await deps.auth().getSession(request);
  return session ?? errorResponse("unauthorized");
}

async function dispatch(deps: GoogleDocsBatchApiDeps, onlyJobId?: string): Promise<void> {
  const store = deps.store();
  const queue = deps.queue();
  if (!store || !queue) return;
  const entries = await store.outbox(100);
  for (const entry of entries) {
    if (onlyJobId && entry.jobId !== onlyJobId) continue;
    try {
      await queue.enqueue(entry);
      // ALREADY_EXISTS only proves this task name exists/recently existed. The item remains queued until its lease CAS runs.
      await store.submitted(entry);
    } catch {
      // Durable outbox remains pending. Sweep creates another dispatch attempt if a submitted task is lost.
    }
  }
}

/** POST /api/google-docs/batches/preview */
export function previewGoogleDocsBatch(request: Request, deps: GoogleDocsBatchApiDeps): Promise<Response> {
  return guarded("POST /api/google-docs/batches/preview", async () => {
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const session = await sessionOf(request, deps);
    if (session instanceof Response) return session;
    const body = await readJsonBody(request, 4096);
    if (!body.ok) return body.response;
    const input = previewOf(body.value);
    if (!input) return errorResponse("bad_request");
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    let tree: GoogleDocsBatchTreePageMetadata[] | null;
    try { tree = await store.tree(session.userId, input.rootPageId); } catch (error) { return storeFailure(error) ?? errorResponse("unavailable"); }
    if (!tree) return notFoundResponse();
    let totalBytes = 0;
    const pages = [];
    for (const metadata of tree) {
      let source: GoogleDocsBatchSourceResult | null;
      try { source = await store.source(session.userId, metadata, input.options); } catch { return errorResponse("unavailable"); }
      if (!source) return notFoundResponse();
      const plan = source.ok
        ? planGoogleDocsBatchPayload(source.page, input.options)
        : { ok: false as const, reason: source.reason, omissions: [] };
      if (plan.ok) totalBytes += plan.payloadBytes;
      pages.push({
        pageId: metadata.id, title: metadata.title, revision: metadata.revision, depth: metadata.depth,
        exportable: plan.ok, payloadBytes: plan.ok ? plan.payloadBytes : 0, omissions: plan.omissions,
        problem: plan.ok ? null : plan.reason,
      });
    }
    return jsonResponse(200, {
      rootPageId: input.rootPageId, options: input.options, pages, totalBytes,
      limits: { pages: GOOGLE_DOCS_BATCH_MAX_PAGES, bytes: GOOGLE_DOCS_BATCH_MAX_BYTES },
      canStart: pages.some((page) => page.exportable) && totalBytes <= GOOGLE_DOCS_BATCH_MAX_BYTES,
    });
  });
}

/** POST /api/google-docs/batches */
export function startGoogleDocsBatch(request: Request, deps: GoogleDocsBatchApiDeps): Promise<Response> {
  return guarded("POST /api/google-docs/batches", async () => {
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const session = await sessionOf(request, deps);
    if (session instanceof Response) return session;
    const body = await readJsonBody(request, 64 * 1024);
    if (!body.ok) return body.response;
    const input = startOf(body.value);
    if (!input) return errorResponse("bad_request");
    const store = deps.store();
    const cipher = deps.cipher();
    const gateway = deps.ownerGateway();
    const service = deps.service();
    const queue = deps.queue();
    if (!store || !cipher || !gateway || !service || !queue || !deps.maintenanceReady()) return errorResponse("unavailable");
    const credential = await deps.credential(session, request);
    if (!credential) return jsonResponse(503, { error: "google_docs_unavailable" });
    const now = deps.now?.() ?? new Date();
    const expiresAt = new Date(now.getTime() + GOOGLE_DOCS_BATCH_TTL_MINUTES * 60_000).toISOString();
    const newId = deps.newId ?? randomUUID;
    const jobId = newId().toLowerCase();
    const ids = new Map(input.selections.map((selection) => [selection.pageId, { itemId: newId().toLowerCase(), exportId: newId().toLowerCase() }]));
    let prepared;
    try {
      prepared = await store.prepare(session.userId, {
        jobId, rootPageId: input.rootPageId, operationId: input.operationId, requestSha256: requestHash(input), options: input.options, expiresAt,
        selections: input.selections.map((selection) => ({ ...selection, ...ids.get(selection.pageId)! })),
        prepare(page, identity) {
          const plan = planGoogleDocsBatchPayload(page, input.options);
          if (!plan.ok) throw new PreparationError(plan.reason);
          return {
            title: plan.payload.title, markdown: plan.payload.markdown, payloadSha256: plan.payloadSha256, payloadBytes: plan.payloadBytes,
            omissions: plan.omissions,
            envelope: cipher.encrypt(plan.payload, { owner: session.userId, jobId: identity.jobId, itemId: identity.itemId, purpose: "google-docs", expiresAt: identity.expiresAt }),
          };
        },
      });
    } catch (error) {
      return storeFailure(error) ?? errorResponse("unavailable");
    }
    let view = await store.get(session.userId, prepared.job.id);
    if (!view) return errorResponse("unavailable");
    if (!view.job.grantAttached) {
      const grantItems: GoogleDocsBatchGrantItem[] = view.items.map((item) => ({ exportId: item.exportId, payloadSha256: item.payloadSha256, payloadBytes: item.payloadBytes }));
      let grant: GoogleDocsBatchGrant;
      try {
        grant = await gateway.grant(credential, view.job.id, grantItems);
      } catch (error) {
        if (!(error instanceof GoogleDocsBatchNihoError) || !error.uncertain) return nihoFailure(error);
        try { grant = await service.lookup(view.job.id, session.userId); }
        catch (lookupError) { return nihoFailure(lookupError, "service"); }
      }
      if (!await store.attachGrant(session.userId, view.job.id, grant.grantId, grant.expiresAt)) return jsonResponse(409, { error: "grant_conflict" });
      view = await store.get(session.userId, view.job.id);
      if (!view) return errorResponse("unavailable");
    }
    await dispatch(deps, view.job.id);
    return jsonResponse(202, dto(view));
  });
}

export function getGoogleDocsBatchRoute(request: Request, jobId: string, deps: GoogleDocsBatchApiDeps): Promise<Response> {
  return guarded("GET /api/google-docs/batches/[jobId]", async () => {
    const session = await sessionOf(request, deps);
    if (session instanceof Response) return session;
    if (!UUID.test(jobId)) return notFoundResponse();
    const view = await deps.store()?.get(session.userId, jobId.toLowerCase());
    return view ? jsonResponse(200, dto(view)) : notFoundResponse();
  });
}

export function getLatestGoogleDocsBatchRoute(request: Request, rootPageId: string, deps: GoogleDocsBatchApiDeps): Promise<Response> {
  return guarded("GET /api/google-docs/batches/root/[rootPageId]", async () => {
    const session = await sessionOf(request, deps);
    if (session instanceof Response) return session;
    if (!UUID.test(rootPageId)) return notFoundResponse();
    const store = deps.store();
    if (!store) return errorResponse("unavailable");
    const view = await store.latest(session.userId, rootPageId.toLowerCase());
    return view ? jsonResponse(200, dto(view)) : notFoundResponse();
  });
}

export function retryGoogleDocsBatchRoute(request: Request, jobId: string, deps: GoogleDocsBatchApiDeps): Promise<Response> {
  return guarded("POST /api/google-docs/batches/[jobId]/retry", async () => {
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const session = await sessionOf(request, deps);
    if (session instanceof Response) return session;
    const body = await readJsonBody(request, 1024);
    if (!body.ok) return body.response;
    if (!plain(body.value) || !exact(body.value, ["ordinal"]) || !Number.isSafeInteger(body.value.ordinal) || (body.value.ordinal as number) < 0) return errorResponse("bad_request");
    const store = deps.store();
    if (!store || !UUID.test(jobId)) return notFoundResponse();
    if (!await store.retry(session.userId, jobId.toLowerCase(), body.value.ordinal as number)) return jsonResponse(409, { error: "state_conflict" });
    await dispatch(deps, jobId.toLowerCase());
    const view = await store.get(session.userId, jobId.toLowerCase());
    return view ? jsonResponse(202, dto(view)) : notFoundResponse();
  });
}

export function cancelGoogleDocsBatchRoute(request: Request, jobId: string, deps: GoogleDocsBatchApiDeps): Promise<Response> {
  return guarded("DELETE /api/google-docs/batches/[jobId]", async () => {
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const session = await sessionOf(request, deps);
    if (session instanceof Response) return session;
    const store = deps.store();
    if (!store || !UUID.test(jobId)) return notFoundResponse();
    // 外部 revoke が一時的にできなくても、まず local future item と payload を止める。
    const cancelled = await store.cancel(session.userId, jobId.toLowerCase());
    if (!cancelled) return notFoundResponse();
    if (cancelled.grantId) {
      const gateway = deps.ownerGateway();
      const credential = gateway ? await deps.credential(session, request) : null;
      if (!gateway || !credential) {
        const view = await store.get(session.userId, jobId.toLowerCase());
        return jsonResponse(202, { ...(view ? dto(view) as object : {}), revokePending: true, error: "google_docs_unavailable" });
      }
      try {
        await gateway.revoke(credential, cancelled.grantId);
        if (!await store.markGrantRevoked(session.userId, jobId.toLowerCase(), cancelled.grantId)) {
          return jsonResponse(409, { error: "state_conflict" });
        }
      }
      catch (error) {
        const view = await store.get(session.userId, jobId.toLowerCase());
        return jsonResponse(202, { ...(view ? dto(view) as object : {}), revokePending: true, error: error instanceof GoogleDocsBatchNihoError ? error.reason : "temporarily_unavailable" });
      }
    }
    const view = await store.get(session.userId, jobId.toLowerCase());
    return view ? jsonResponse(200, { ...dto(view) as object, inflightMayComplete: cancelled.inflight }) : notFoundResponse();
  });
}
