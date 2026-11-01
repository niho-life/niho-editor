import {
  PHOTO_API_PREFIX,
  PHOTO_ERROR_STATUS,
  PHOTO_ROUTES,
  type PhotoOperation,
  type PhotoOperationMap,
} from "@niho/photo-library-contract";
import { CloudPhotoError } from "./errors.ts";
import { assertOperationResponse, parseErrorEnvelope } from "./validate.ts";

export type CloudPhotoScope = Readonly<{ actorId: string; libraryId: string; sessionEpoch: string | number }>;
export type AuthenticatedFetch = (input: string, init: RequestInit) => Promise<Response>;

export type PhotoApiClientOptions = {
  readonly scope: CloudPhotoScope;
  readonly currentScope: () => CloudPhotoScope | null;
  readonly authenticatedFetch: AuthenticatedFetch;
  readonly idempotencyKey?: (operation: PhotoOperation) => string;
  readonly subscribeScopeChange?: (listener: () => void) => () => void;
};

export type PhotoApiClient = {
  request<K extends Exclude<PhotoOperation, "content.get">>(
    operation: K,
    request: PhotoOperationMap[K]["request"],
    options?: { signal?: AbortSignal },
  ): Promise<PhotoOperationMap[K]["response"]>;
  readContent(
    request: PhotoOperationMap["content.get"]["request"],
    options: { signal?: AbortSignal; maxBytes: number },
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
  dispose(): void;
  assertCurrent(): void;
};

const sameScope = (left: CloudPhotoScope | null, right: CloudPhotoScope): boolean => !!left &&
  left.actorId === right.actorId && left.libraryId === right.libraryId && left.sessionEpoch === right.sessionEpoch;

export function createPhotoApiClient(options: PhotoApiClientOptions): PhotoApiClient {
  const active = new Set<AbortController>();
  let disposed = false;
  const assertCurrent = () => {
    if (disposed || !sameScope(options.currentScope(), options.scope)) throw new CloudPhotoError("scope_changed", null, null, false);
  };
  const abortChangedScope = () => {
    if (sameScope(options.currentScope(), options.scope)) return;
    for (const controller of active) controller.abort(new DOMException("Scope changed", "AbortError"));
  };
  const unsubscribeScope = options.subscribeScopeChange?.(abortChangedScope) ?? (() => {});

  const run = async <T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    assertCurrent();
    const controller = new AbortController();
    active.add(controller);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const value = await work(controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason ?? new DOMException("Aborted", "AbortError");
      assertCurrent();
      return value;
    } finally {
      signal?.removeEventListener("abort", abort);
      active.delete(controller);
    }
  };

  const fetchRoute = async (operation: PhotoOperation, request: Record<string, unknown>, signal: AbortSignal): Promise<Response> => {
    assertCurrent();
    const route = PHOTO_ROUTES[operation];
    let path: string = route.path;
    const used = new Set<string>();
    path = path.replace(/\{([^}]+)\}/g, (_, key: string) => {
      const value = request[key];
      if (typeof value !== "string") throw new CloudPhotoError("invalid_response", null, null, false);
      used.add(key);
      return encodeURIComponent(value);
    });
    const headers = new Headers({ Accept: operation === "content.get" ? "application/octet-stream" : "application/json" });
    const init: RequestInit = { method: route.method, headers, signal, cache: "no-store" };
    if (route.method === "GET") {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(request)) {
        if (used.has(key) || value === undefined) continue;
        if (key === "range" && typeof value === "string") headers.set("Range", value);
        else if (Array.isArray(value)) for (const item of value) query.append(key, String(item));
        else query.set(key, String(value));
      }
      const suffix = query.size ? `?${query.toString()}` : "";
      return safeFetch(`${PHOTO_API_PREFIX}${path}${suffix}`, init, signal);
    }
    const body = Object.fromEntries(Object.entries(request).filter(([key, value]) => !used.has(key) && value !== undefined));
    headers.set("Content-Type", "application/json");
    if (route.idempotency === "required") {
      const key = options.idempotencyKey?.(operation) ?? `${operation.replaceAll(".", "-")}-${crypto.randomUUID()}`;
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new CloudPhotoError("invalid_request", 400, null, false);
      headers.set("Idempotency-Key", key);
    }
    init.body = JSON.stringify(body);
    assertCurrent();
    return safeFetch(`${PHOTO_API_PREFIX}${path}`, init, signal);
  };

  const safeFetch = async (input: string, init: RequestInit, signal: AbortSignal): Promise<Response> => {
    try {
      const response = await options.authenticatedFetch(input, init);
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      assertCurrent();
      return response;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      if (error instanceof CloudPhotoError) throw error;
      throw new CloudPhotoError("invalid_response", null, null, false);
    }
  };

  const throwHttp = async (response: Response): Promise<never> => {
    let known = null;
    try { known = parseErrorEnvelope(await response.json()); } catch { /* discard untrusted body */ }
    assertCurrent();
    if (!known || PHOTO_ERROR_STATUS[known.code] !== response.status) throw new CloudPhotoError("invalid_response", response.status, null, false);
    throw new CloudPhotoError(known.code, response.status, known.requestId, known.retryable);
  };

  return {
    async request(operation, request, requestOptions) {
      return run(requestOptions?.signal, async (signal) => {
        const response = await fetchRoute(operation, request as Record<string, unknown>, signal);
        assertCurrent();
        if (!response.ok) return throwHttp(response);
        let value: unknown;
        try { value = await response.json(); } catch {
          throw new CloudPhotoError("invalid_response", response.status, null, false);
        }
        assertCurrent();
        assertOperationResponse(operation, value, options.scope, request);
        return value;
      });
    },
    async readContent(request, readOptions) {
      return run(readOptions.signal, async (signal) => {
        const response = await fetchRoute("content.get", request, signal);
        assertCurrent();
        if (!response.ok) return throwHttp(response);
        const declared = response.headers.get("content-length");
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > readOptions.maxBytes)) {
          throw new CloudPhotoError("content_too_large", response.status, null, false);
        }
        if (!response.body) throw new CloudPhotoError("invalid_response", response.status, null, false);
        const chunks: Uint8Array[] = [];
        let length = 0;
        const reader = response.body.getReader();
        let rejectAborted: ((reason: unknown) => void) | null = null;
        const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
        const abortReader = () => {
          const reason = signal.reason ?? new DOMException("Aborted", "AbortError");
          void reader.cancel(reason).catch(() => {});
          rejectAborted?.(reason);
        };
        signal.addEventListener("abort", abortReader, { once: true });
        if (signal.aborted) abortReader();
        try {
          while (true) {
            const result = await Promise.race([reader.read(), aborted]);
            assertCurrent();
            if (result.done) break;
            length += result.value.byteLength;
            if (length > readOptions.maxBytes) {
              void reader.cancel().catch(() => {});
              throw new CloudPhotoError("content_too_large", response.status, null, false);
            }
            chunks.push(result.value);
          }
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
          throw error;
        } finally {
          signal.removeEventListener("abort", abortReader);
          try { reader.releaseLock(); } catch { /* a signal-ignoring source may still have a pending read */ }
        }
        assertCurrent();
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return { bytes, contentType: response.headers.get("content-type") ?? "application/octet-stream" };
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeScope();
      for (const controller of active) controller.abort(new DOMException("Disposed", "AbortError"));
      active.clear();
    },
    assertCurrent,
  };
}
