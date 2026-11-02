import "server-only";

import type { VerifiedPhotoActor } from "../../../../../packages/photo-library-contract/src/v1";
import { isTrustedNihoOrigin } from "../../auth/config";
import { readNihoPhotoApiCredential } from "../../auth/niho";
import { PhotoAuthError, type PhotoAuthDeps, verifyPhotoActor } from "../photo-auth";
import { authorize, PhotoTransferError } from "../photo-transfer/http";
import { isPrivatePhotoCursor, parsePrivatePhotoEnvelope, parsePrivatePhotoList } from "./parser";
import type {
  NihoPhotoPrivateApiPurgeResult,
  NihoPhotoPrivateApiResult,
  NihoPrivatePhoto,
  NihoPrivatePhotoList,
} from "./types";

const LIST_PATH = "/api/me/photo-cloud/photos";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 40;
const DEFAULT_TIMEOUT_MS = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NihoPhotoPrivateApiErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "unavailable";

const ERROR_STATUS = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  unavailable: 503,
} as const;

export class NihoPhotoPrivateApiError extends Error {
  readonly status: (typeof ERROR_STATUS)[NihoPhotoPrivateApiErrorCode];
  readonly retryable: boolean;

  constructor(readonly code: NihoPhotoPrivateApiErrorCode) {
    super("NIHO photo private API request failed");
    this.name = "NihoPhotoPrivateApiError";
    this.status = ERROR_STATUS[code];
    this.retryable = this.status === 429 || this.status === 503;
  }
}

export type NihoPhotoPrivateApiClientOptions = PhotoAuthDeps & Readonly<{
  allowedOrigins: readonly string[];
  timeoutMs?: number;
}>;

export type NihoPhotoPrivateApiListOptions = Readonly<{
  cursor?: string;
  limit?: number;
}>;

export interface NihoPhotoPrivateApiClient {
  list(request: Request, options?: NihoPhotoPrivateApiListOptions): Promise<NihoPhotoPrivateApiResult<NihoPrivatePhotoList>>;
  photo(request: Request, photoId: string): Promise<NihoPhotoPrivateApiResult<NihoPrivatePhoto>>;
  purge(request: Request, photoId: string): Promise<NihoPhotoPrivateApiPurgeResult>;
}

type Snapshot = Readonly<{ url: string; method: string; headers: Headers; signal: AbortSignal }>;

function unavailable(): NihoPhotoPrivateApiError {
  return new NihoPhotoPrivateApiError("unavailable");
}

function cancelBody(response: Response): void {
  const cancellation = response.body?.cancel();
  if (cancellation) void cancellation.catch(() => undefined);
}

function canonicalPhotoId(value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new NihoPhotoPrivateApiError("invalid_request");
  return value.toLowerCase();
}

function parseListOptions(value: unknown): { cursor?: string; limit: number } {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || Object.getOwnPropertySymbols(value).length !== 0) throw new NihoPhotoPrivateApiError("invalid_request");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.some((key) => key !== "cursor" && key !== "limit")
      || keys.some((key) => !("value" in descriptors[key]!))) throw new NihoPhotoPrivateApiError("invalid_request");
    const cursor = descriptors.cursor?.value as unknown;
    const rawLimit = descriptors.limit?.value as unknown;
    const limit = rawLimit === undefined ? 60 : rawLimit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 60
      || (cursor !== undefined && !isPrivatePhotoCursor(cursor))) throw new NihoPhotoPrivateApiError("invalid_request");
    return cursor === undefined ? { limit: limit as number } : { cursor, limit: limit as number };
  } catch (error) {
    if (error instanceof NihoPhotoPrivateApiError) throw error;
    throw new NihoPhotoPrivateApiError("invalid_request");
  }
}

function mapStatus(status: number): NihoPhotoPrivateApiError {
  if (status === 400) return new NihoPhotoPrivateApiError("invalid_request");
  if (status === 401) return new NihoPhotoPrivateApiError("unauthorized");
  if (status === 403) return new NihoPhotoPrivateApiError("forbidden");
  if (status === 404) return new NihoPhotoPrivateApiError("not_found");
  if (status === 409) return new NihoPhotoPrivateApiError("conflict");
  if (status === 429) return new NihoPhotoPrivateApiError("rate_limited");
  return unavailable();
}

function mapAuthError(error: unknown): NihoPhotoPrivateApiError {
  if (error instanceof NihoPhotoPrivateApiError) return error;
  if (error instanceof PhotoAuthError) return mapStatus(error.status);
  if (error instanceof PhotoTransferError) {
    if (error.code === "unauthenticated") return new NihoPhotoPrivateApiError("unauthorized");
    if (error.code === "origin_rejected") return new NihoPhotoPrivateApiError("forbidden");
    if (error.code === "invalid_request") return new NihoPhotoPrivateApiError("invalid_request");
  }
  return unavailable();
}

function raceAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // taskは呼出側で既に作られている場合がある。即時abortでもlate rejectionを必ず観測する。
    task.then(() => undefined, () => undefined);
    return Promise.reject(unavailable());
  }
  let rejectAbort!: () => void;
  const gate = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(unavailable());
  });
  signal.addEventListener("abort", rejectAbort, { once: true });
  if (signal.aborted) rejectAbort();
  return Promise.race([task, gate]).finally(() => signal.removeEventListener("abort", rejectAbort));
}

function combineSignals(signals: readonly AbortSignal[]): AbortSignal {
  return AbortSignal.any([...signals]);
}

function wrapAuthResponseBody(response: Response, signal: AbortSignal): Response {
  if (!response.body) return response;
  const source = response.body.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    try {
      source.releaseLock();
      released = true;
    } catch {
      // pending readの完了時に再試行する。
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal.aborted) throw unavailable();
        const item = await raceAbort(source.read(), signal);
        if (item.done) {
          controller.close();
          release();
        } else controller.enqueue(item.value);
      } catch (error) {
        controller.error(error);
        const cancellation = source.cancel();
        void cancellation.catch(() => undefined).finally(release);
      }
    },
    cancel() {
      const cancellation = source.cancel();
      void cancellation.catch(() => undefined).finally(release);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function maxDepth(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.depth > MAX_JSON_DEPTH) return false;
    if (item.value !== null && typeof item.value === "object") {
      for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return true;
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    cancelBody(response);
    throw unavailable();
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") ?? "")) {
    cancelBody(response);
    throw unavailable();
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    cancelBody(response);
    throw unavailable();
  }
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let released = false;
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  const release = () => {
    if (released) return;
    try {
      reader.releaseLock();
      released = true;
    } catch {
      // pending readの完了時に再試行する。
    }
  };
  try {
    for (;;) {
      pendingRead = reader.read();
      const item = await raceAbort(pendingRead, signal);
      pendingRead = undefined;
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw unavailable();
      chunks.push(item.value);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const value: unknown = JSON.parse(text);
    if (!maxDepth(value)) throw unavailable();
    return value;
  } catch (error) {
    if (error instanceof NihoPhotoPrivateApiError) throw error;
    throw unavailable();
  } finally {
    const cancellation = reader.cancel();
    void cancellation.catch(() => undefined).finally(release);
    if (pendingRead) void pendingRead.finally(release).catch(() => undefined);
    release();
  }
}

function frozenActor(actor: VerifiedPhotoActor): VerifiedPhotoActor {
  return Object.freeze({
    userId: actor.userId,
    sessionId: actor.sessionId,
    transport: actor.transport,
    expiresAt: actor.expiresAt,
  });
}

function validateListQuery(url: URL, options: { cursor?: string; limit: number } | undefined): void {
  if (!options) {
    if (url.search !== "") throw new NihoPhotoPrivateApiError("invalid_request");
    return;
  }
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "limit" && key !== "cursor")
    || url.searchParams.getAll("limit").length > 1
    || url.searchParams.getAll("cursor").length > 1) throw new NihoPhotoPrivateApiError("invalid_request");
  const queryLimit = url.searchParams.get("limit");
  if (queryLimit !== null && queryLimit !== String(options.limit)) throw new NihoPhotoPrivateApiError("invalid_request");
  const queryCursor = url.searchParams.get("cursor");
  if (queryCursor !== null && (!isPrivatePhotoCursor(queryCursor) || queryCursor !== options.cursor)) {
    throw new NihoPhotoPrivateApiError("invalid_request");
  }
}

export function createNihoPhotoPrivateApiClient(options: NihoPhotoPrivateApiClientOptions): NihoPhotoPrivateApiClient {
  let timeoutMs: number;
  let allowedOrigins: readonly string[];
  let baseFetch: typeof fetch;
  try {
    timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
      || !Array.isArray(options.allowedOrigins)
      || options.allowedOrigins.some((origin) => !isTrustedNihoOrigin(origin))) throw unavailable();
    allowedOrigins = Object.freeze([...options.allowedOrigins]);
    baseFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  } catch (error) {
    if (error instanceof NihoPhotoPrivateApiError) throw error;
    throw unavailable();
  }

  async function run<T>(
    request: Request,
    mutation: boolean,
    operation: (input: { origin: string; actor: VerifiedPhotoActor; authorization: string; signal: AbortSignal }) => Promise<T>,
    listOptions?: { cursor?: string; limit: number },
  ): Promise<Readonly<{ actor: VerifiedPhotoActor; data: T }>> {
    const snapshot: Snapshot = Object.freeze({
      url: request.url,
      method: request.method,
      headers: new Headers(request.headers),
      signal: request.signal,
    });
    let parsed: URL;
    try {
      parsed = new URL(snapshot.url);
    } catch {
      throw new NihoPhotoPrivateApiError("invalid_request");
    }
    if (parsed.username || parsed.password || parsed.hash) throw new NihoPhotoPrivateApiError("invalid_request");
    validateListQuery(parsed, listOptions);
    if (mutation && (snapshot.method === "GET" || snapshot.method === "HEAD")) {
      throw new NihoPhotoPrivateApiError("invalid_request");
    }
    if (snapshot.signal.aborted) throw unavailable();
    let configuredOrigin: string | undefined;
    let configuredEditorOrigin: string | undefined;
    try {
      const providedEnv = options.env;
      configuredOrigin = providedEnv?.EDITOR_NIHO_ORIGIN ?? process.env.EDITOR_NIHO_ORIGIN;
      configuredEditorOrigin = providedEnv?.EDITOR_ORIGIN ?? process.env.EDITOR_ORIGIN;
    } catch {
      throw unavailable();
    }
    if (!isTrustedNihoOrigin(configuredOrigin)) throw unavailable();
    const origin = configuredOrigin as string;
    const configuredEnv = Object.freeze({
      EDITOR_NIHO_ORIGIN: origin,
      EDITOR_ORIGIN: configuredEditorOrigin,
    });

    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = combineSignals([snapshot.signal, deadline]);
    const authFetch: typeof fetch = async (input, init) => {
      const fetchSignal = init?.signal ? combineSignals([signal, init.signal]) : signal;
      if (fetchSignal.aborted) throw unavailable();
      const task = Promise.resolve(baseFetch(input, { ...init, signal: fetchSignal })).then((response) => {
        if (fetchSignal.aborted) {
          cancelBody(response);
          throw unavailable();
        }
        return wrapAuthResponseBody(response, fetchSignal);
      });
      return raceAbort(task, fetchSignal);
    };
    // P01には元のURL/query/header/method snapshotをそのまま渡す。
    const authRequest = new Request(snapshot.url, { method: snapshot.method, headers: snapshot.headers, signal });
    let verified;
    try {
      if (signal.aborted) throw unavailable();
      verified = await raceAbort(verifyPhotoActor(authRequest, {
        auth: options.auth,
        // dedicated providerが無ければP01を503へ閉じ、Docs/global authへfallbackさせない。Mac bearerはproviderを使わない。
        photoAuth: () => options.photoAuth?.() ?? null,
        env: configuredEnv,
        fetch: authFetch,
        now: options.now,
      }), signal);
      // shared authorizeのquery拒否は他caller向けに維持する。closed list query検証後だけqueryを除いた同一requestを使う。
      const authorizeUrl = new URL(snapshot.url);
      authorizeUrl.search = "";
      const authorizeRequest = new Request(authorizeUrl, { method: snapshot.method, headers: snapshot.headers, signal });
      const actor = authorize(authorizeRequest, verified.actor, allowedOrigins, options.now?.() ?? Date.now(), mutation);
      signal.throwIfAborted();
      let credential: string | null;
      if (actor.transport === "browser-session") credential = readNihoPhotoApiCredential({ headers: snapshot.headers });
      else {
        const authorization = snapshot.headers.get("authorization");
        credential = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
      }
      if (!credential) throw new NihoPhotoPrivateApiError("unauthorized");
      const frozen = frozenActor(actor);
      const data = await raceAbort(operation({ origin, actor: frozen, authorization: `Bearer ${credential}`, signal }), signal);
      return Object.freeze({ actor: frozen, data });
    } catch (error) {
      throw mapAuthError(error);
    }
  }

  async function fetchJson(
    input: { origin: string; authorization: string; signal: AbortSignal },
    path: string,
    method: "GET" | "DELETE",
  ): Promise<unknown> {
    if (input.signal.aborted) throw unavailable();
    const task = Promise.resolve(baseFetch(`${input.origin}${path}`, {
      method,
      headers: { accept: "application/json", authorization: input.authorization },
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: input.signal,
    })).then((response) => {
      if (input.signal.aborted) {
        cancelBody(response);
        throw unavailable();
      }
      return response;
    });
    const response = await raceAbort(task, input.signal);
    if (response.redirected) {
      cancelBody(response);
      throw unavailable();
    }
    if (method === "DELETE") {
      if (response.status === 204) {
        cancelBody(response);
        return undefined;
      }
      cancelBody(response);
      if (!response.ok) throw mapStatus(response.status);
      throw unavailable();
    }
    if (!response.ok) {
      cancelBody(response);
      throw mapStatus(response.status);
    }
    return readJson(response, input.signal);
  }

  const client: NihoPhotoPrivateApiClient = {
    async list(request: Request, rawOptions: NihoPhotoPrivateApiListOptions = {}) {
      const { cursor, limit } = parseListOptions(rawOptions);
      return run(request, false, async (input) => {
        const path = `${LIST_PATH}?limit=${limit}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
        const value = await fetchJson(input, path, "GET");
        const list = parsePrivatePhotoList(value);
        if (!list) throw unavailable();
        return list;
      }, cursor === undefined ? { limit } : { cursor, limit });
    },

    async photo(request: Request, rawPhotoId: string) {
      const photoId = canonicalPhotoId(rawPhotoId);
      return run(request, false, async (input) => {
        const value = await fetchJson(input, `${LIST_PATH}/${photoId}`, "GET");
        const photo = parsePrivatePhotoEnvelope(value, photoId);
        if (!photo) throw unavailable();
        return photo;
      });
    },

    async purge(request: Request, rawPhotoId: string) {
      const photoId = canonicalPhotoId(rawPhotoId);
      const result = await run(request, true, async (input) => {
        await fetchJson(input, `${LIST_PATH}/${photoId}`, "DELETE");
        return undefined;
      });
      return Object.freeze({ actor: result.actor });
    },
  };
  return Object.freeze(client);
}

export type {
  NihoPhotoPrivateApiPurgeResult,
  NihoPhotoPrivateApiResult,
  NihoPrivatePhoto,
  NihoPrivatePhotoList,
  PrivatePhotoDevelopSettings,
  PrivatePhotoJsonValue,
} from "./types";
