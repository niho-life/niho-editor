import "server-only";
import { readBoundedUtf8 } from "../server/bounded-response";
import { NIHO_API_MAX_RESPONSE_BYTES, NIHO_API_TIMEOUT_MS } from "./config";
import { documentUrl, isDocumentId, isExportId, type GoogleDocsCredential, type GoogleDocsExport } from "./gateway";

const OWNER_PREFIX = ["auth", "experience-editor-connect", "docs-drive"] as const;
const INTERNAL_PREFIX = ["internal", "editor-docs-drive"] as const;
const METADATA_IDENTITY_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const IDENTITY_MAX_BYTES = 16 * 1024;

export type GoogleDocsBatchGrantItem = { exportId: string; payloadSha256: string; payloadBytes: number };
export type GoogleDocsBatchGrant = { version: 1; grantId: string; jobId: string; expiresAt: string };

export class GoogleDocsBatchNihoError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly uncertain: boolean;
  constructor(status: number, reason: string, uncertain = false) {
    super(`google docs batch NIHO request failed: ${reason}`);
    this.name = "GoogleDocsBatchNihoError";
    this.status = status;
    this.reason = /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : "invalid_response";
    this.uncertain = uncertain;
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function target(apiBase: string, segments: readonly string[]): string {
  const url = new URL(apiBase);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${segments.map((part) => encodeURIComponent(part)).join("/")}`;
  return url.toString();
}

async function bodyOf(response: Response): Promise<unknown> {
  try {
    const text = await readBoundedUtf8(response, NIHO_API_MAX_RESPONSE_BYTES);
    return text === "" ? null : JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function reasonOf(value: unknown): string {
  if (!plain(value) || !plain(value.error) || !plain(value.error.details) || typeof value.error.details.reason !== "string") return "invalid_response";
  const reason = value.error.details.reason;
  return /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : "invalid_response";
}

function grantOf(value: unknown, jobId: string): GoogleDocsBatchGrant {
  if (!plain(value) || Object.keys(value).sort().join(",") !== "expiresAt,grantId,jobId,version" || value.version !== 1
    || typeof value.grantId !== "string" || !UUID.test(value.grantId) || value.jobId !== jobId
    || typeof value.expiresAt !== "string") throw new GoogleDocsBatchNihoError(502, "invalid_response");
  try {
    if (new Date(value.expiresAt).toISOString() !== value.expiresAt) throw new Error();
  } catch {
    throw new GoogleDocsBatchNihoError(502, "invalid_response");
  }
  return { version: 1, grantId: value.grantId.toLowerCase(), jobId: jobId.toLowerCase(), expiresAt: value.expiresAt };
}

function exportOf(value: unknown, exportId: string): GoogleDocsExport {
  if (!plain(value) || value.exportId !== exportId) throw new GoogleDocsBatchNihoError(502, "invalid_response");
  if (value.status === "completed" && isDocumentId(value.documentId)) {
    return { exportId, status: "completed", documentId: value.documentId, url: documentUrl(value.documentId) };
  }
  if (value.status === "pending" && typeof value.retryable === "boolean") return { exportId, status: "pending", retryable: value.retryable };
  throw new GoogleDocsBatchNihoError(502, "invalid_response");
}

async function callJson(fetchImpl: typeof fetch, url: string, init: RequestInit, uncertain: boolean): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(NIHO_API_TIMEOUT_MS) });
  } catch {
    throw new GoogleDocsBatchNihoError(503, "network_unknown", uncertain);
  }
  const body = await bodyOf(response);
  if (!response.ok) throw new GoogleDocsBatchNihoError(response.status, reasonOf(body));
  return { response, body };
}

function validateItems(items: readonly GoogleDocsBatchGrantItem[]): void {
  if (items.length < 1 || items.length > 200) throw new TypeError("invalid Google Docs batch grant items");
  const ids = new Set<string>();
  let totalBytes = 0;
  for (const item of items) {
    if (!isExportId(item.exportId) || ids.has(item.exportId) || !HASH.test(item.payloadSha256)
      || !Number.isSafeInteger(item.payloadBytes) || item.payloadBytes < 1 || item.payloadBytes > 4 * 1024 * 1024) {
      throw new TypeError("invalid Google Docs batch grant items");
    }
    ids.add(item.exportId);
    totalBytes += item.payloadBytes;
  }
  if (totalBytes > 32 * 1024 * 1024) throw new TypeError("invalid Google Docs batch grant items");
}

export class NihoGoogleDocsBatchOwnerGateway {
  constructor(private readonly apiBase: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async grant(credential: GoogleDocsCredential, jobId: string, items: readonly GoogleDocsBatchGrantItem[]): Promise<GoogleDocsBatchGrant> {
    if (!UUID.test(jobId)) throw new TypeError("invalid Google Docs batch job id");
    validateItems(items);
    const { body } = await callJson(this.fetchImpl, target(this.apiBase, [...OWNER_PREFIX, "batch-grants"]), {
      method: "POST",
      headers: { authorization: `Bearer ${credential.idToken()}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ jobId: jobId.toLowerCase(), items }),
    }, true);
    return grantOf(body, jobId.toLowerCase());
  }

  async revoke(credential: GoogleDocsCredential, grantId: string): Promise<void> {
    if (!UUID.test(grantId)) throw new TypeError("invalid Google Docs batch grant id");
    const { response } = await callJson(this.fetchImpl, target(this.apiBase, [...OWNER_PREFIX, "batch-grants", grantId.toLowerCase()]), {
      method: "DELETE", headers: { authorization: `Bearer ${credential.idToken()}`, accept: "application/json" },
    }, false);
    if (response.status !== 204) throw new GoogleDocsBatchNihoError(502, "invalid_response");
  }
}

export type ServiceIdentityToken = (audience: string) => Promise<string>;

export async function metadataIdentityToken(audience: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const endpoint = new URL(METADATA_IDENTITY_URL);
  endpoint.searchParams.set("audience", audience);
  endpoint.searchParams.set("format", "full");
  let response: Response;
  try {
    response = await fetchImpl(endpoint, { headers: { "metadata-flavor": "Google" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new GoogleDocsBatchNihoError(503, "service_identity_unavailable");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GoogleDocsBatchNihoError(503, "service_identity_unavailable");
  }
  let token: string;
  try { token = (await readBoundedUtf8(response, IDENTITY_MAX_BYTES)).trim(); } catch { throw new GoogleDocsBatchNihoError(503, "service_identity_unavailable"); }
  if (!JWT.test(token) || token.length > IDENTITY_MAX_BYTES) throw new GoogleDocsBatchNihoError(503, "service_identity_unavailable");
  return token;
}

export type NihoGoogleDocsBatchServiceOptions = {
  apiBase: string;
  audience: string;
  fetch?: typeof fetch;
  token?: ServiceIdentityToken;
};

export class NihoGoogleDocsBatchServiceClient {
  private readonly fetchImpl: typeof fetch;
  private readonly token: ServiceIdentityToken;
  constructor(private readonly options: NihoGoogleDocsBatchServiceOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.token = options.token ?? ((audience) => metadataIdentityToken(audience, this.fetchImpl));
  }

  private async post(path: readonly string[], body: unknown, uncertain = false): Promise<unknown> {
    const token = await this.token(this.options.audience);
    return (await callJson(this.fetchImpl, target(this.options.apiBase, [...INTERNAL_PREFIX, ...path]), {
      method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body),
    }, uncertain)).body;
  }

  async lookup(jobId: string, actorId: string): Promise<GoogleDocsBatchGrant> {
    if (!UUID.test(jobId) || !actorId || actorId.length > 256) throw new TypeError("invalid Google Docs batch lookup");
    return grantOf(await this.post(["grants", "lookup"], { jobId: jobId.toLowerCase(), actorId }), jobId.toLowerCase());
  }

  async export(input: { grantId: string; jobId: string; actorId: string; exportId: string; title: string; markdown: string }): Promise<GoogleDocsExport> {
    return exportOf(await this.post(["exports"], input, true), input.exportId);
  }

  async status(input: { grantId: string; jobId: string; actorId: string; exportId: string; receiptOnly?: boolean }): Promise<GoogleDocsExport> {
    return exportOf(await this.post(["exports", "status"], input), input.exportId);
  }
}
