import { describe, expect, it, vi } from "vitest";

import { createNihoAuthProvider, NIHO_SESSION_COOKIE } from "../../auth/niho";
import { stubAuthProvider } from "../../auth/stub";
import { AuthTemporarilyUnavailable, type AuthProvider } from "../../auth/types";
import {
  createNihoPhotoPrivateApiClient,
  NihoPhotoPrivateApiError,
  type NihoPhotoPrivateApiClientOptions,
} from "./client";

const NIHO_ORIGIN = "https://niho.example.invalid";
const EDITOR_ORIGIN = "https://editor.example.invalid";
const NOW = Date.parse("2026-11-02T00:00:00.000Z");
const EXPIRES_AT = new Date(NOW + 60 * 60_000).toISOString();
const ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const CANONICAL_ID = ID.toLowerCase();
const CREDENTIAL = `v1.33333333-3333-4333-8333-333333333333.${"D".repeat(43)}`;
const NATIVE_TOKEN = "synthetic-native-bearer";

function photo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CANONICAL_ID,
    contentSha256: "a".repeat(64),
    fileName: "鎌倉 photo.heic",
    fileExtension: "heic",
    contentType: "image/heic",
    sizeBytes: 1234,
    status: "stored",
    storedAt: "2026-11-01T10:00:00.000Z",
    developSettings: { exposure: 0.25, unknownDrawingField: { points: [1, 2, 3], label: "line 1\nline 2", empty: "" } },
    developSettingsUpdatedAt: null,
    developRevision: 2,
    hasEdits: true,
    createdAt: "2026-11-01T09:00:00.000Z",
    ...overrides,
  };
}

function browserProvider(getSession: AuthProvider["getSession"] = async () => ({
  userId: "canonical-user-a",
  mode: "niho",
  sessionId: "photo-session-a",
  expiresAt: EXPIRES_AT,
})): AuthProvider {
  return { ...stubAuthProvider, mode: "niho", getSession };
}

function browserRequest(path = "/internal/photo", init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("cookie", headers.get("cookie") ?? `${NIHO_SESSION_COOKIE}=${CREDENTIAL}`);
  return new Request(`${EDITOR_ORIGIN}${path}`, { ...init, headers });
}

function options(fetch: typeof globalThis.fetch, overrides: Partial<NihoPhotoPrivateApiClientOptions> = {}): NihoPhotoPrivateApiClientOptions {
  return {
    auth: () => stubAuthProvider,
    photoAuth: () => browserProvider(),
    env: { EDITOR_NIHO_ORIGIN: NIHO_ORIGIN, EDITOR_ORIGIN },
    allowedOrigins: [EDITOR_ORIGIN],
    fetch,
    now: () => NOW,
    ...overrides,
  };
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function error(code: string, status: number, retryable: boolean): NihoPhotoPrivateApiError {
  const value = new NihoPhotoPrivateApiError(code as ConstructorParameters<typeof NihoPhotoPrivateApiError>[0]);
  expect(value).toMatchObject({ code, status, retryable, message: "NIHO photo private API request failed" });
  expect(value).not.toHaveProperty("cause");
  return value;
}

describe("NIHO photo private API client", () => {
  it("uses the real NIHO photo provider introspection and forwards only its validated browser credential", async () => {
    const introspect = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${NIHO_ORIGIN}/api/auth/editor-connect/introspect`);
      expect(JSON.parse(String(init?.body))).toMatchObject({ credential: CREDENTIAL, audience: "niho-photo" });
      return json({
        actor: { id: "canonical-user-a" },
        sessionId: "photo-session-a",
        expiresAt: EXPIRES_AT,
        clientId: "niho-editor",
        audience: "niho-photo",
        refreshRequired: false,
      });
    });
    const photoAuth = createNihoAuthProvider({
      env: () => ({ EDITOR_NIHO_ORIGIN: NIHO_ORIGIN }),
      fetch: introspect as typeof globalThis.fetch,
      now: () => NOW,
    });
    const docsSession = vi.fn();
    const outbound = vi.fn(async (...args: Parameters<typeof globalThis.fetch>) => {
      void args;
      return json({ photos: [photo()], nextCursor: null });
    });
    const client = createNihoPhotoPrivateApiClient(options(outbound as typeof globalThis.fetch, {
      auth: () => ({ ...stubAuthProvider, mode: "google", getSession: docsSession }),
      photoAuth: () => photoAuth,
    }));

    const result = await client.list(browserRequest("/internal/photo"));

    expect(result.actor).toEqual({
      userId: "canonical-user-a", sessionId: "photo-session-a", transport: "browser-session", expiresAt: EXPIRES_AT,
    });
    expect(result.data.photos[0]?.developSettings).toEqual({
      exposure: 0.25, unknownDrawingField: { points: [1, 2, 3], label: "line 1\nline 2", empty: "" },
    });
    expect(Object.isFrozen(result.data.photos[0]?.developSettings)).toBe(true);
    expect(introspect).toHaveBeenCalledOnce();
    expect(docsSession).not.toHaveBeenCalled();
    expect(outbound).toHaveBeenCalledOnce();
    const [target, init] = outbound.mock.calls[0]!;
    expect(target).toBe(`${NIHO_ORIGIN}/api/me/photo-cloud/photos?limit=60`);
    expect(init).toMatchObject({
      method: "GET", cache: "no-store", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
    });
    expect([...new Headers(init?.headers).entries()]).toEqual([
      ["accept", "application/json"],
      ["authorization", `Bearer ${CREDENTIAL}`],
    ]);
    expect(init).not.toHaveProperty("body");
  });

  it("verifies and reuses the same original Mac bearer, never forwarding request identity or browser headers", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const target = String(input);
      if (target.endsWith("/api/auth/editor-connect/mac-session")) {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${NATIVE_TOKEN}`);
        return json({
          actor: { id: "canonical-native" }, sessionId: "native-session", expiresAt: EXPIRES_AT,
          clientId: "niho-editor", audience: "niho-photo", refreshRequired: false, sourceClientId: "niho-camera",
        });
      }
      return json({ photo: photo() });
    });
    const client = createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch));
    const request = new Request(`${EDITOR_ORIGIN}/internal/photo`, {
      headers: {
        authorization: `Bearer ${NATIVE_TOKEN}`,
        cookie: "editor_session=experience-only",
        referer: `${EDITOR_ORIGIN}/secret`,
        "x-forwarded-host": "attacker.invalid",
        "x-request-id": "client-controlled",
      },
    });

    const result = await client.photo(request, ID);

    expect(result.actor.transport).toBe("mac-bearer");
    expect(result.data.id).toBe(CANONICAL_ID);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [target, init] = fetch.mock.calls[1]!;
    expect(target).toBe(`${NIHO_ORIGIN}/api/me/photo-cloud/photos/${CANONICAL_ID}`);
    expect([...new Headers(init?.headers).entries()]).toEqual([
      ["accept", "application/json"],
      ["authorization", `Bearer ${NATIVE_TOKEN}`],
    ]);
  });

  it("reauthenticates every invocation without retaining actor or session state", async () => {
    const getSession = vi.fn(async () => ({
      userId: "canonical-user-a", mode: "niho" as const, sessionId: "session", expiresAt: EXPIRES_AT,
    }));
    const fetch = vi.fn(async (...args: Parameters<typeof globalThis.fetch>) => {
      void args;
      return json({ photos: [], nextCursor: null });
    });
    const client = createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch, {
      photoAuth: () => browserProvider(getSession),
    }));
    await client.list(browserRequest());
    await client.list(browserRequest(), { limit: 1 });
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("snapshots the original headers before asynchronous authentication", async () => {
    let continueAuth!: () => void;
    const gate = new Promise<void>((resolve) => { continueAuth = resolve; });
    const getSession = vi.fn(async ({ headers }: { headers: Pick<Headers, "get"> }) => {
      await gate;
      expect(headers.get("cookie")).toBe(`${NIHO_SESSION_COOKIE}=${CREDENTIAL}`);
      return { userId: "canonical-user-a", mode: "niho" as const, sessionId: "session", expiresAt: EXPIRES_AT };
    });
    const fetch = vi.fn(async (...args: Parameters<typeof globalThis.fetch>) => {
      void args;
      return json({ photos: [], nextCursor: null });
    });
    const client = createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch, {
      photoAuth: () => browserProvider(getSession),
    }));
    const request = browserRequest();
    const pending = client.list(request);
    request.headers.set("cookie", `${NIHO_SESSION_COOKIE}=malformed-after-entry`);
    request.headers.set("authorization", "Bearer forged-after-entry");
    continueAuth();
    await expect(pending).resolves.toMatchObject({ actor: { userId: "canonical-user-a" } });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(`Bearer ${CREDENTIAL}`);
  });

  it.each([
    ["signed out", async () => null, 401],
    ["expired", async () => ({ userId: "u", mode: "niho" as const, sessionId: "s", expiresAt: new Date(NOW).toISOString() }), 401],
    ["NIHO unavailable", async () => { throw new AuthTemporarilyUnavailable("synthetic"); }, 503],
  ])("rejects %s before the private photo call", async (_name, getSession, status) => {
    const fetch = vi.fn();
    const client = createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch, {
      photoAuth: () => browserProvider(getSession),
    }));
    await expect(client.list(browserRequest())).rejects.toMatchObject({ status });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not accept Docs/Experience-only cookies or a null/wrong-mode photo provider", async () => {
    const fetch = vi.fn();
    const docsSession = vi.fn(async () => ({ userId: "experience-user", mode: "niho" as const }));
    const docs = { ...stubAuthProvider, mode: "niho" as const, getSession: docsSession };
    const experienceOnly = new Request(`${EDITOR_ORIGIN}/internal/photo`, { headers: { cookie: "editor_session=experience-only" } });
    for (const photoAuth of [() => null, () => ({ ...stubAuthProvider, mode: "google" as const })]) {
      const client = createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch, {
        auth: () => docs,
        photoAuth,
      }));
      await expect(client.list(experienceOnly)).rejects.toMatchObject({ status: 503 });
    }
    expect(docsSession).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([undefined, "null", "https://foreign.example.invalid"])("rejects browser purge Origin %s", async (origin) => {
    const fetch = vi.fn();
    const headers: Record<string, string> = {};
    if (origin !== undefined) headers.origin = origin;
    const client = createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch));
    await expect(client.purge(browserRequest("/internal/photo", { method: "DELETE", headers }), ID))
      .rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows an absent Mac Origin, requires an allowlisted present Origin, and accepts only 204 purge", async () => {
    const macSession = () => json({
      actor: { id: "native" }, sessionId: "native-session", expiresAt: EXPIRES_AT,
      clientId: "niho-editor", audience: "niho-photo", refreshRequired: false, sourceClientId: "niho-camera",
    });
    const fetch = vi.fn(async (...args: Parameters<typeof globalThis.fetch>) => String(args[0]).endsWith("mac-session")
      ? macSession()
      : new Response(null, { status: 204 }));
    const client = createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch));
    const native = (origin?: string) => new Request(`${EDITOR_ORIGIN}/internal/photo`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${NATIVE_TOKEN}`, ...(origin ? { origin } : {}) },
    });
    await expect(client.purge(native(), ID)).resolves.toMatchObject({ actor: { transport: "mac-bearer" } });
    await expect(client.purge(native(EDITOR_ORIGIN), ID)).resolves.toMatchObject({ actor: { transport: "mac-bearer" } });
    await expect(client.purge(native("https://foreign.example.invalid"), ID)).rejects.toMatchObject({ status: 403 });
    await expect(client.purge(new Request(`${EDITOR_ORIGIN}/internal/photo`, {
      method: "GET", headers: { authorization: `Bearer ${NATIVE_TOKEN}` },
    }), ID)).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).has("content-type")).toBe(false);
    expect(fetch.mock.calls[1]?.[1]).not.toHaveProperty("body");

    const badDelete = vi.fn(async (input: string | URL | Request) => String(input).endsWith("mac-session") ? macSession() : json({ deleted: true }));
    const badClient = createNihoPhotoPrivateApiClient(options(badDelete as typeof globalThis.fetch));
    await expect(badClient.purge(native(), ID)).rejects.toEqual(error("unavailable", 503, true));
  });

  it.each([
    ["identity", { "x-owner-id": "forged" }],
    ["mixed auth", { authorization: `Bearer ${NATIVE_TOKEN}` }],
    ["duplicate cookie", { cookie: `${NIHO_SESSION_COOKIE}=${CREDENTIAL}; ${NIHO_SESSION_COOKIE}=${CREDENTIAL}` }],
    ["malformed cookie", { cookie: `${NIHO_SESSION_COOKIE}=not-a-credential` }],
  ])("rejects %s without a private photo call", async (_name, extraHeaders) => {
    const fetch = vi.fn();
    const client = createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch));
    await expect(client.list(browserRequest("/internal/photo", { headers: extraHeaders }))).rejects.toBeInstanceOf(NihoPhotoPrivateApiError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects query-bearing inbound URLs and invalid closed operation inputs before photo fetch", async () => {
    const fetch = vi.fn();
    const client = createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch));
    const cases: Array<() => Promise<unknown>> = [
      () => client.list(browserRequest("/internal/photo?owner=forged")),
      () => client.list(browserRequest(), { limit: 0 }),
      () => client.list(browserRequest(), { limit: 1.5 }),
      () => client.list(browserRequest(), { cursor: "bad+cursor" }),
      () => client.list(browserRequest(), { cursor: "a" }),
      () => client.list(browserRequest(), { cursor: "a".repeat(513) }),
      () => client.list(browserRequest(), { ownerId: "forged" } as never),
      () => client.photo(browserRequest(), "../../secret?x=1"),
      () => client.purge(browserRequest("/internal/photo", { method: "DELETE", headers: { origin: EDITOR_ORIGIN } }), `${ID}/suffix`),
    ];
    for (const invoke of cases) await expect(invoke()).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses closed list options and lowercases canonical IDs", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => String(input).includes("?limit=")
      ? json({ photos: [], nextCursor: "eyJpZCI6MX0" })
      : json({ photo: photo() }));
    const client = createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch));
    await expect(client.list(browserRequest(), { limit: 12, cursor: "eyJpZCI6MX0" })).resolves.toMatchObject({
      data: { nextCursor: "eyJpZCI6MX0" },
    });
    await client.photo(browserRequest(), ID);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${NIHO_ORIGIN}/api/me/photo-cloud/photos?limit=12&cursor=eyJpZCI6MX0`);
    expect(fetch.mock.calls[1]?.[0]).toBe(`${NIHO_ORIGIN}/api/me/photo-cloud/photos/${CANONICAL_ID}`);
  });

  it.each([
    ["extra field", { secretLocator: "private-object" }],
    ["wrong status", { status: "uploading" }],
    ["null storedAt", { storedAt: null }],
    ["noncanonical time", { createdAt: "2026-11-01T09:00:00Z" }],
    ["oversized original", { sizeBytes: 200 * 1024 * 1024 + 1 }],
    ["control filename", { fileName: "bad\u0000name" }],
    ["bad extension", { fileExtension: "heic/other" }],
    ["bad content type", { contentType: "text/plain" }],
    ["negative revision", { developRevision: -1 }],
  ])("fails closed on invalid private DTO: %s", async (_name, override) => {
    const fetch = vi.fn(async () => json({ photos: [photo(override)], nextCursor: null }));
    const client = createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch));
    await expect(client.list(browserRequest())).rejects.toEqual(error("unavailable", 503, true));
  });

  it("rejects list overflow, bad cursor, unexpected get shape, and mismatched photo metadata", async () => {
    const payloads = [
      { photos: Array.from({ length: 61 }, () => photo()), nextCursor: null },
      { photos: [], nextCursor: "bad+cursor" },
      { photo: photo(), upload: { url: "secret" } },
      { photo: photo({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }) },
    ];
    for (let index = 0; index < payloads.length; index += 1) {
      const fetch = vi.fn(async () => json(payloads[index]));
      const client = createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch));
      const call = index < 2 ? client.list(browserRequest()) : client.photo(browserRequest(), ID);
      await expect(call).rejects.toMatchObject({ status: 503 });
    }
  });

  it("bounds develop settings to a JSON object of 1 MiB and depth 32", async () => {
    let tooDeep: Record<string, unknown> = { value: 1 };
    for (let depth = 0; depth < 33; depth += 1) tooDeep = { child: tooDeep };
    const invalidSettings = ["not-an-object", [1, 2, 3], { text: "x".repeat(1024 * 1024) }, tooDeep];
    for (const developSettings of invalidSettings) {
      const fetch = vi.fn(async () => json({ photos: [photo({ developSettings })], nextCursor: null }));
      const client = createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch));
      await expect(client.list(browserRequest())).rejects.toMatchObject({ status: 503 });
    }
  });

  it.each([400, 401, 403, 404, 409, 429, 500, 502])("projects upstream status %s without parsing malicious bodies or headers", async (status) => {
    const fetch = vi.fn(async () => new Response("{provider-secret-body", {
      status,
      headers: { location: "https://secret.invalid/object", "retry-after": "private-value" },
    }));
    const client = createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch));
    const expected = status === 500 || status === 502 ? 503 : status;
    const failure = await client.list(browserRequest()).catch((caught: unknown) => caught);
    expect(failure).toMatchObject({ status: expected, message: "NIHO photo private API request failed" });
    expect(failure).not.toHaveProperty("body");
    expect(failure).not.toHaveProperty("headers");
    expect(failure).not.toHaveProperty("url");
  });

  it("rejects a synthetic redirected success without exposing Location", async () => {
    const response = json({ photos: [], nextCursor: null }, { headers: { location: "https://secret.invalid/object" } });
    Object.defineProperty(response, "redirected", { value: true });
    const client = createNihoPhotoPrivateApiClient(options(vi.fn(async () => response) as unknown as typeof globalThis.fetch));
    await expect(client.list(browserRequest())).rejects.toEqual(error("unavailable", 503, true));
  });

  it.each([
    ["declared oversized", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": String(4 * 1024 * 1024 + 1) } })],
    ["actual oversized", () => new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } })],
    ["wrong content type", () => new Response("{}", { headers: { "content-type": "text/plain" } })],
    ["fatal UTF-8", () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } })],
    ["malformed JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
  ])("bounds and validates response body: %s", async (_name, response) => {
    const client = createNihoPhotoPrivateApiClient(options(vi.fn(async () => response()) as unknown as typeof globalThis.fetch));
    await expect(client.list(browserRequest())).rejects.toMatchObject({ status: 503 });
  });

  it("settles fetch, body, P01 and external-abort stalls within the shared boundary", async () => {
    const stalledFetch = createNihoPhotoPrivateApiClient(options((() => new Promise<Response>(() => undefined)) as typeof globalThis.fetch, { timeoutMs: 10 }));
    await expect(stalledFetch.list(browserRequest())).rejects.toMatchObject({ status: 503 });

    const stalledBody = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => undefined); }, cancel() { return new Promise<void>(() => undefined); } });
    const bodyClient = createNihoPhotoPrivateApiClient(options(vi.fn(async () => new Response(stalledBody, {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch, { timeoutMs: 10 }));
    await expect(bodyClient.list(browserRequest())).rejects.toMatchObject({ status: 503 });

    const p01Client = createNihoPhotoPrivateApiClient(options(vi.fn() as unknown as typeof globalThis.fetch, {
      timeoutMs: 10,
      photoAuth: () => browserProvider(() => new Promise(() => undefined)),
    }));
    await expect(p01Client.list(browserRequest())).rejects.toMatchObject({ status: 503 });

    const controller = new AbortController();
    const abortClient = createNihoPhotoPrivateApiClient(options((() => new Promise<Response>(() => undefined)) as typeof globalThis.fetch, { timeoutMs: 30_000 }));
    const pending = abortClient.list(browserRequest("/internal/photo", { signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 503 });
  });

  it("adopts late fetch rejection and cancels a late response without delaying the caller", async () => {
    let rejectLate!: (reason: unknown) => void;
    const lateRejection = new Promise<Response>((_resolve, reject) => { rejectLate = reject; });
    const rejectionClient = createNihoPhotoPrivateApiClient(options((() => lateRejection) as typeof globalThis.fetch, { timeoutMs: 5 }));
    await expect(rejectionClient.list(browserRequest())).rejects.toMatchObject({ status: 503 });
    rejectLate(new Error("late provider secret"));
    await new Promise<void>((resolve) => setImmediate(resolve));

    let resolveLate!: (response: Response) => void;
    const lateResponse = new Promise<Response>((resolve) => { resolveLate = resolve; });
    const responseClient = createNihoPhotoPrivateApiClient(options((() => lateResponse) as typeof globalThis.fetch, { timeoutMs: 5 }));
    await expect(responseClient.list(browserRequest())).rejects.toMatchObject({ status: 503 });
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    resolveLate(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "content-type": "application/json" } }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("fails malformed origin/allowlist/timeout configuration before outbound use", async () => {
    const fetch = vi.fn();
    expect(() => createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch, { timeoutMs: 0 })))
      .toThrowError(error("unavailable", 503, true));
    expect(() => createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch, { allowedOrigins: ["http://editor.invalid"] })))
      .toThrowError(NihoPhotoPrivateApiError);
    const client = createNihoPhotoPrivateApiClient(options(fetch as typeof globalThis.fetch, {
      env: { EDITOR_NIHO_ORIGIN: "https://niho.example.invalid/path", EDITOR_ORIGIN },
    }));
    await expect(client.list(browserRequest())).rejects.toMatchObject({ status: 503 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never uses the global NIHO Experience provider when photoAuth is absent", async () => {
    const privateFetch = vi.fn<typeof globalThis.fetch>(async () => json({ photos: [], nextCursor: null }));
    const globalSession = vi.fn(async () => ({ userId: "docs-user-b", mode: "niho" as const,
      sessionId: "experience-connection-b", expiresAt: EXPIRES_AT }));
    const { photoAuth: _unused, ...withoutPhoto } = options(privateFetch as unknown as typeof globalThis.fetch);
    void _unused;
    const client = createNihoPhotoPrivateApiClient({ ...withoutPhoto,
      auth: () => browserProvider(globalSession) });
    await expect(client.list(browserRequest())).rejects.toMatchObject({ status: 503 });
    expect(globalSession).not.toHaveBeenCalled();
    expect(privateFetch).not.toHaveBeenCalled();
  });

  it("adopts an auth promise rejected in the same synchronous abort turn", async () => {
    const controller = new AbortController();
    const privateFetch = vi.fn();
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", listener);
    try {
      const client = createNihoPhotoPrivateApiClient(options(privateFetch as unknown as typeof globalThis.fetch, {
        photoAuth: () => browserProvider(() => {
          controller.abort();
          return Promise.reject(new Error("synthetic auth unavailable"));
        }),
      }));
      await expect(client.list(browserRequest("/internal/photo", { signal: controller.signal })))
        .rejects.toMatchObject({ status: 503 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(privateFetch).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", listener); }
  });

  it("does not start authentication or private I/O for an already aborted request", async () => {
    const privateFetch = vi.fn();
    const getSession = vi.fn(async () => ({ userId: "canonical-user-a", mode: "niho" as const,
      sessionId: "photo-session-a", expiresAt: EXPIRES_AT }));
    const client = createNihoPhotoPrivateApiClient(options(privateFetch as unknown as typeof globalThis.fetch, {
      photoAuth: () => browserProvider(getSession),
    }));
    await expect(client.list(browserRequest("/internal/photo", { signal: AbortSignal.abort() })))
      .rejects.toMatchObject({ status: 503 });
    expect(getSession).not.toHaveBeenCalled();
    expect(privateFetch).not.toHaveBeenCalled();
  });

  it("accepts a validated paginated list request without forwarding its inbound query", async () => {
    const privateFetch = vi.fn<typeof globalThis.fetch>(async () => json({ photos: [], nextCursor: null }));
    const client = createNihoPhotoPrivateApiClient(options(privateFetch as unknown as typeof globalThis.fetch));
    const cursor = "eyJpZCI6MX0";
    await expect(client.list(browserRequest(`/api/photo/v1/photos?limit=12&cursor=${cursor}`), { limit: 12, cursor }))
      .resolves.toMatchObject({ data: { photos: [], nextCursor: null } });
    expect(privateFetch.mock.calls[0]?.[0]).toBe(`${NIHO_ORIGIN}/api/me/photo-cloud/photos?limit=12&cursor=${cursor}`);
  });

  it.each([
    ["duplicate limit", "/api/photo/v1/photos?limit=12&limit=12", { limit: 12 }],
    ["mismatched limit", "/api/photo/v1/photos?limit=13", { limit: 12 }],
    ["duplicate cursor", "/api/photo/v1/photos?cursor=eyJpZCI6MX0&cursor=eyJpZCI6MX0", { cursor: "eyJpZCI6MX0" }],
    ["mismatched cursor", "/api/photo/v1/photos?cursor=eyJpZCI6Mn0", { cursor: "eyJpZCI6MX0" }],
    ["cursor without explicit option", "/api/photo/v1/photos?cursor=eyJpZCI6MX0", {}],
  ])("rejects invalid list query before private fetch: %s", async (_name, path, listOptions) => {
    const privateFetch = vi.fn<typeof globalThis.fetch>(async () => json({ photos: [], nextCursor: null }));
    const client = createNihoPhotoPrivateApiClient(options(privateFetch as unknown as typeof globalThis.fetch));
    await expect(client.list(browserRequest(path), listOptions)).rejects.toMatchObject({ status: 400 });
    expect(privateFetch).not.toHaveBeenCalled();
  });

  it("uses one configured origin snapshot across P01 and the private target", async () => {
    const mutableEnv: Record<string, string | undefined> = {
      EDITOR_NIHO_ORIGIN: NIHO_ORIGIN,
      EDITOR_ORIGIN,
    };
    const photoSession = vi.fn(async () => {
      mutableEnv.EDITOR_NIHO_ORIGIN = "https://changed-niho.example.invalid";
      mutableEnv.EDITOR_ORIGIN = "https://changed-editor.example.invalid";
      return { userId: "canonical-user-a", mode: "niho" as const, sessionId: "photo-session-a", expiresAt: EXPIRES_AT };
    });
    const privateFetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    const client = createNihoPhotoPrivateApiClient(options(privateFetch as unknown as typeof globalThis.fetch, {
      env: mutableEnv,
      photoAuth: () => browserProvider(photoSession),
    }));
    await expect(client.purge(browserRequest("/api/photo/v1/photos", {
      method: "DELETE", headers: { origin: EDITOR_ORIGIN },
    }), ID)).resolves.toMatchObject({ actor: { userId: "canonical-user-a" } });
    expect(privateFetch.mock.calls[0]?.[0]).toBe(`${NIHO_ORIGIN}/api/me/photo-cloud/photos/${CANONICAL_ID}`);
  });

});
