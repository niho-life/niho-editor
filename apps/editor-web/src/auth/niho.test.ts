import { describe, expect, it, vi } from "vitest";

import { AuthTemporarilyUnavailable } from "./types";
import { createNihoAuthProvider, NIHO_PENDING_COOKIE, NIHO_SESSION_COOKIE } from "./niho";

const ORIGIN = "https://editor.example.invalid";
const NIHO = "https://niho.example.invalid";
const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const STATE = "A".repeat(43);
const VERIFIER = "B".repeat(43);
const CODE = "C".repeat(43);
const CREDENTIAL = `v1.33333333-3333-4333-8333-333333333333.${"D".repeat(43)}`;
const NOW = Date.parse("2026-11-01T00:00:00.000Z");

function cookieValue(response: Response, name: string): string {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  return cookie?.split(";")[0]?.slice(name.length + 1) ?? "";
}

function fakeNiho(options: { fail?: string; invalid?: string; confirmationPath?: string; sessionExpiresAt?: string; beginPayload?: unknown } = {}) {
  const calls: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = [];
  const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, init, body });
    if (options.fail === path) return Response.json({ error: { code: "SERVICE_UNAVAILABLE" } }, { status: 503 });
    if (path.endsWith("/begin")) {
      return Response.json(options.beginPayload ?? (options.invalid === path ? { unexpected: true } : {
        attemptId: ATTEMPT,
        expiresAt: new Date(NOW + 600_000).toISOString(),
        confirmationPath: options.confirmationPath ?? "/api/auth/editor-connect/request",
      }));
    }
    if (path.endsWith("/exchange") || path.endsWith("/refresh")) {
      return Response.json({
        credential: CREDENTIAL,
        actor: { id: "canonical-user-a", displayName: "合成ユーザー" },
        sessionId: SESSION,
        expiresAt: options.sessionExpiresAt ?? new Date(NOW + 30 * 86_400_000).toISOString(),
        clientId: "niho-editor",
        audience: "niho-photo",
        refreshRequired: false,
      });
    }
    if (path.endsWith("/introspect")) {
      return Response.json({
        actor: { id: "canonical-user-a" },
        sessionId: SESSION,
        expiresAt: options.sessionExpiresAt ?? new Date(NOW + 30 * 86_400_000).toISOString(),
        clientId: "niho-editor",
        audience: "niho-photo",
        refreshRequired: false,
      });
    }
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function provider(fake = fakeNiho(), now: () => number = () => NOW) {
  const values = [STATE, VERIFIER];
  return {
    auth: createNihoAuthProvider({
      env: () => ({ EDITOR_NIHO_ORIGIN: NIHO, EDITOR_ORIGIN: ORIGIN }),
      fetch: fake.fetch,
      now,
      randomValue: () => values.shift() ?? "Z".repeat(43),
    }),
    fake,
  };
}

function callbackRequest(options: {
  origin?: string;
  cookie?: string;
  body?: string | ReadableStream<Uint8Array>;
  contentType?: string | null;
  url?: string;
  signal?: AbortSignal;
} = {}): Request {
  const headers = new Headers();
  if (options.origin !== undefined) headers.set("origin", options.origin);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.contentType !== null) headers.set("content-type", options.contentType ?? "application/x-www-form-urlencoded");
  return new Request(options.url ?? `${ORIGIN}/auth/callback`, {
    method: "POST",
    headers,
    body: options.body ?? `code=${CODE}&state=${STATE}`,
    signal: options.signal,
    ...(options.body instanceof ReadableStream ? { duplex: "half" } as RequestInit : {}),
  });
}

async function begin(auth: ReturnType<typeof provider>["auth"], cookie?: string) {
  return auth.beginLogin({
    request: new Request(`${ORIGIN}/auth/login/start`, cookie ? { headers: { cookie } } : undefined),
    returnTo: "/settings",
  });
}

describe("NIHO auth provider", () => {
  it("begins with PKCE and a Secure __Host pending cookie, using hardened server fetch", async () => {
    const { auth, fake } = provider();
    const response = await begin(auth);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    const html = await response.text();
    expect(html).toContain(`action="${NIHO}/api/auth/editor-connect/request"`);
    expect(html).toContain(`name="attemptId" value="${ATTEMPT}"`);
    expect(html).toContain(`name="state" value="${STATE}"`);
    expect([...html.matchAll(/<input type="hidden" name="([^"]+)"/g)].map((match) => match[1]).sort()).toEqual(["attemptId", "state"]);
    expect(html).not.toContain(VERIFIER);
    expect(response.headers.get("content-security-policy")).toMatch(/^default-src 'none'; script-src 'nonce-[A-Za-z0-9_-]+'; form-action https:\/\/niho\.example\.invalid; base-uri 'none'; frame-ancestors 'none'; object-src 'none'$/);
    expect(response.headers.get("referrer-policy")).toBe("origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${NIHO_PENDING_COOKIE}=`)) ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=610");
    expect(fake.calls[0]?.body).toEqual({
      clientId: "niho-editor",
      state: STATE,
      codeChallenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      codeChallengeMethod: "S256",
      protocolVersion: 2,
      responseMode: "form_post",
    });
    expect(fake.calls[0]?.body).not.toHaveProperty("codeVerifier");
    expect(new URL(fake.calls[0]!.url).search).toBe("");
    expect(fake.calls[0]?.init).toMatchObject({ redirect: "error", cache: "no-store" });
  });

  it("accepts only the fixed v2 confirmation path", async () => {
    const fake = fakeNiho({
      confirmationPath: `${NIHO}/api/auth/editor-connect/request`,
    });
    const { auth } = provider(fake);
    const response = await begin(auth);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/auth/login?next=%2Fsettings&error=unavailable");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    { attemptId: ATTEMPT, expiresAt: new Date(NOW + 600_000).toISOString(), confirmationPath: "/api/auth/editor-connect/request", extra: true },
    { attemptId: ATTEMPT, expiresAt: "2026-11-01", confirmationPath: "/api/auth/editor-connect/request" },
    { attemptId: "not-an-attempt", expiresAt: new Date(NOW + 600_000).toISOString(), confirmationPath: "/api/auth/editor-connect/request" },
    { attemptId: ATTEMPT, expiresAt: new Date(NOW + 600_000).toISOString(), confirmationPath: "/api/auth/editor-connect/request?state=hidden" },
  ])("rejects a non-exact v2 begin response: %j", async (beginPayload) => {
    const { auth } = provider(fakeNiho({ beginPayload }));
    const response = await begin(auth);
    expect(response.headers.get("location")).toBe("/auth/login?next=%2Fsettings&error=unavailable");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("relays the cross-site POST without cookies or exchange, then exchanges only the same-origin POST", async () => {
    const { auth, fake } = provider();
    const started = await begin(auth);
    const pending = cookieValue(started, NIHO_PENDING_COOKIE);
    const relay = await auth.completeLogin(callbackRequest({ origin: NIHO }));
    expect(relay.status).toBe(200);
    expect(relay.headers.get("set-cookie")).toBeNull();
    expect(relay.headers.get("referrer-policy")).toBe("origin");
    expect(relay.headers.get("content-security-policy")).toMatch(/form-action 'self'/);
    const relayHtml = await relay.text();
    expect(relayHtml).toContain(`action="${ORIGIN}/auth/callback"`);
    expect(relayHtml).toContain(`name="code" value="${CODE}"`);
    expect(relayHtml).toContain(`name="state" value="${STATE}"`);
    expect(relayHtml).not.toContain(VERIFIER);
    expect(relayHtml).not.toContain(CREDENTIAL);
    expect(relayHtml).not.toContain(NIHO_PENDING_COOKIE);
    expect(fake.calls.some((call) => call.url.endsWith("/exchange"))).toBe(false);

    const relayWithCookies = await auth.completeLogin(callbackRequest({
      origin: NIHO,
      cookie: `${NIHO_PENDING_COOKIE}=${pending}; ${NIHO_SESSION_COOKIE}=${CREDENTIAL}`,
    }));
    expect(relayWithCookies.status).toBe(200);
    expect(relayWithCookies.headers.get("set-cookie")).toBeNull();
    expect(fake.calls.some((call) => call.url.endsWith("/exchange"))).toBe(false);

    const stale = await auth.completeLogin(callbackRequest({
      origin: ORIGIN,
      cookie: `${NIHO_PENDING_COOKIE}=${pending}`,
      body: `code=${CODE}&state=${"X".repeat(43)}`,
    }));
    expect(stale.headers.get("set-cookie")).toBeNull();
    expect(fake.calls.some((call) => call.url.endsWith("/exchange"))).toBe(false);

    const completedRequest = callbackRequest({
      origin: ORIGIN,
      cookie: `${NIHO_PENDING_COOKIE}=${pending}`,
    });
    const completed = await auth.completeLogin(completedRequest);
    expect(completed.status).toBe(303);
    expect(completedRequest.body?.locked).toBe(false);
    expect(completed.headers.get("location")).toBe("/settings");
    expect(cookieValue(completed, NIHO_SESSION_COOKIE)).toBe(CREDENTIAL);
    expect(completed.headers.getSetCookie().find((value) => value.startsWith(`${NIHO_PENDING_COOKIE}=`))).toContain("Max-Age=0");
    const exchange = fake.calls.find((call) => call.url.endsWith("/exchange"));
    expect(exchange?.body).toMatchObject({ attemptId: ATTEMPT, code: CODE, codeVerifier: VERIFIER });
  });

  it("introspects every request and returns canonical safe metadata without an apiToken", async () => {
    const { auth } = provider();
    const session = await auth.getSession({ headers: new Headers({ cookie: `${NIHO_SESSION_COOKIE}=${CREDENTIAL}` }) });
    expect(session).toMatchObject({
      userId: "canonical-user-a", sessionId: SESSION, mode: "niho", refreshRequired: false,
    });
    expect(await auth.apiToken?.(session!)).toBeNull();
  });

  it("rotates an existing session credential during exchange", async () => {
    const { auth, fake } = provider();
    const pending = cookieValue(await begin(auth), NIHO_PENDING_COOKIE);
    const response = await auth.completeLogin(callbackRequest({
      origin: ORIGIN,
      cookie: `${NIHO_PENDING_COOKIE}=${pending}; ${NIHO_SESSION_COOKIE}=${CREDENTIAL}`,
    }));
    expect(response.status).toBe(303);
    const exchange = fake.calls.find((call) => call.url.endsWith("/exchange"));
    expect(exchange?.body.replaceCredential).toBe(CREDENTIAL);
  });

  it("keeps refresh rotation and its safe response metadata", async () => {
    const { auth, fake } = provider();
    const response = await auth.refresh!(new Request(`${ORIGIN}/auth/refresh`, {
      method: "POST",
      headers: { cookie: `${NIHO_SESSION_COOKIE}=${CREDENTIAL}` },
    }));
    expect(response.status).toBe(200);
    expect(cookieValue(response, NIHO_SESSION_COOKIE)).toBe(CREDENTIAL);
    expect(await response.json()).toEqual({
      sessionId: SESSION,
      userId: "canonical-user-a",
      expiresAt: new Date(NOW + 30 * 86_400_000).toISOString(),
      refreshRequired: false,
    });
    expect(fake.calls.find((call) => call.url.endsWith("/refresh"))?.body.credential).toBe(CREDENTIAL);
  });

  it("keeps temporary upstream failure typed instead of turning it into signed-out", async () => {
    const fake = fakeNiho({ fail: "/api/auth/editor-connect/introspect" });
    const { auth } = provider(fake);
    await expect(auth.getSession({ headers: new Headers({ cookie: `${NIHO_SESSION_COOKIE}=${CREDENTIAL}` }) }))
      .rejects.toBeInstanceOf(AuthTemporarilyUnavailable);
  });

  it("does not fake logout success or clear retryable cookies when remote revoke is unavailable", async () => {
    const fake = fakeNiho({ fail: "/api/auth/editor-connect/revoke" });
    const { auth } = provider(fake);
    const response = await auth.logout(new Request(`${ORIGIN}/auth/logout`, {
      method: "POST", headers: { cookie: `${NIHO_SESSION_COOKIE}=${CREDENTIAL}` },
    }));
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toEqual({ error: "temporarily_unavailable", retryable: true });
  });

  it("keeps expired pending proof through the timeout margin so callback stays expired while logout/new begin still cancel it", async () => {
    let clock = NOW;
    const first = provider(fakeNiho(), () => clock);
    const started = await begin(first.auth);
    const pending = cookieValue(started, NIHO_PENDING_COOKIE);
    clock = NOW + 600_000;

    const lateCallback = await first.auth.completeLogin(callbackRequest({
      origin: ORIGIN,
      cookie: `${NIHO_PENDING_COOKIE}=${pending}`,
    }));
    expect(lateCallback.headers.get("location")).toBe("/auth/login?error=unavailable");
    expect(first.fake.calls.some((call) => call.url.endsWith("/exchange"))).toBe(false);

    const logout = await first.auth.logout(new Request(`${ORIGIN}/auth/logout`, {
      method: "POST", headers: { cookie: `${NIHO_PENDING_COOKIE}=${pending}` },
    }));
    expect(logout.status).toBe(303);
    expect(first.fake.calls.some((call) => call.url.endsWith("/cancel") && call.body.attemptId === ATTEMPT)).toBe(true);

    clock = NOW;
    const second = provider(fakeNiho(), () => clock);
    const secondStarted = await begin(second.auth);
    const secondPending = cookieValue(secondStarted, NIHO_PENDING_COOKIE);
    clock = NOW + 600_000;
    await begin(second.auth, `${NIHO_PENDING_COOKIE}=${secondPending}`);
    expect(second.fake.calls.some((call) => call.url.endsWith("/cancel") && call.body.attemptId === ATTEMPT)).toBe(true);
  });

  it.each([
    new Date(NOW).toISOString(),
    new Date(NOW + 32 * 86_400_000).toISOString(),
  ])("rejects an expired or unexpectedly long upstream session lifetime: %s", async (sessionExpiresAt) => {
    const { auth } = provider(fakeNiho({ sessionExpiresAt }));
    await expect(auth.getSession({ headers: new Headers({ cookie: `${NIHO_SESSION_COOKIE}=${CREDENTIAL}` }) }))
      .rejects.toBeInstanceOf(AuthTemporarilyUnavailable);
  });

  it("rejects duplicate cookies before using any credential", async () => {
    const { auth, fake } = provider();
    expect(await auth.getSession({
      headers: new Headers({ cookie: `${NIHO_SESSION_COOKIE}=${CREDENTIAL}; ${NIHO_SESSION_COOKIE}=${CREDENTIAL}` }),
    })).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    ["missing origin", callbackRequest()],
    ["null origin", callbackRequest({ origin: "null" })],
    ["foreign origin", callbackRequest({ origin: "https://foreign.example.invalid" })],
    ["query", callbackRequest({ origin: ORIGIN, url: `${ORIGIN}/auth/callback?code=hidden` })],
    ["hash", callbackRequest({ origin: ORIGIN, url: `${ORIGIN}/auth/callback#hidden` })],
    ["wrong path", callbackRequest({ origin: ORIGIN, url: `${ORIGIN}/auth/callback/extra` })],
    ["wrong content type", callbackRequest({ origin: ORIGIN, contentType: "application/json" })],
    ["missing content type", callbackRequest({ origin: ORIGIN, contentType: null })],
    ["wrong configured URL origin", callbackRequest({ origin: ORIGIN, url: "https://other-editor.example.invalid/auth/callback" })],
    ["duplicate", callbackRequest({ origin: ORIGIN, body: `code=${CODE}&state=${STATE}&state=${STATE}` })],
    ["extra", callbackRequest({ origin: ORIGIN, body: `code=${CODE}&state=${STATE}&extra=x` })],
    ["bad escape", callbackRequest({ origin: ORIGIN, body: `code=${CODE}&state=%GG` })],
    ["bad utf8", callbackRequest({ origin: ORIGIN, body: `code=${CODE}&state=%C3%28` })],
  ])("rejects an invalid callback without exchange: %s", async (_name, request) => {
    const { auth, fake } = provider();
    const response = await auth.completeLogin(request);
    expect(response.status).toBe(400);
    expect(request.body?.locked).toBe(false);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects the legacy NIHO GET callback at the provider boundary", async () => {
    const { auth, fake } = provider();
    const response = await auth.completeLogin(new Request(`${ORIGIN}/auth/callback?code=${CODE}&state=${STATE}`));
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it("returns 413 promptly and unlocks an oversized body even when cancel never settles", async () => {
    const oversized = provider();
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`code=${CODE}&state=${"A".repeat(4096)}`));
      },
      cancel() { return new Promise<void>(() => undefined); },
    });
    const oversizedRequest = callbackRequest({
      origin: ORIGIN,
      body: oversizedStream,
    });
    const tooLarge = await oversized.auth.completeLogin(oversizedRequest);
    expect(tooLarge.status).toBe(413);
    expect(oversizedRequest.body?.locked).toBe(false);
    expect(oversized.fake.calls).toHaveLength(0);
  }, 500);

  it("rejects a pre-aborted or in-flight aborted body promptly, unlocks it, and never exchanges", async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = provider();
    const preAbortedRequest = callbackRequest({ origin: ORIGIN, signal: controller.signal });
    const abortedResponse = await aborted.auth.completeLogin(preAbortedRequest);
    expect(abortedResponse.status).toBe(400);
    expect(preAbortedRequest.body?.locked).toBe(false);
    expect(aborted.fake.calls).toHaveLength(0);

    const inFlightController = new AbortController();
    const inFlight = provider();
    const inFlightStream = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => undefined); },
      cancel() { return new Promise<void>(() => undefined); },
    });
    const inFlightRequest = callbackRequest({ origin: ORIGIN, body: inFlightStream, signal: inFlightController.signal });
    const inFlightResponsePromise = inFlight.auth.completeLogin(inFlightRequest);
    inFlightController.abort();
    const inFlightResponse = await inFlightResponsePromise;
    expect(inFlightResponse.status).toBe(400);
    expect(inFlightRequest.body?.locked).toBe(false);
    expect(inFlight.fake.calls).toHaveLength(0);
  }, 500);

  it("enforces the two-second deadline and unlocks a stalled body even when pull and cancel never settle", async () => {
    vi.useFakeTimers();
    try {
      const stalled = provider();
      const stream = new ReadableStream<Uint8Array>({
        pull() { return new Promise<void>(() => undefined); },
        cancel() { return new Promise<void>(() => undefined); },
      });
      const stalledRequest = callbackRequest({ origin: ORIGIN, body: stream });
      const responsePromise = stalled.auth.completeLogin(stalledRequest);
      await vi.advanceTimersByTimeAsync(2_001);
      const response = await responsePromise;
      expect(response.status).toBe(400);
      expect(stalledRequest.body?.locked).toBe(false);
      expect(stalled.fake.calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails before begin or callback processing when NIHO and editor origins are equal", async () => {
    const fake = fakeNiho();
    const values = [STATE, VERIFIER];
    const auth = createNihoAuthProvider({
      env: () => ({ EDITOR_NIHO_ORIGIN: ORIGIN, EDITOR_ORIGIN: ORIGIN }),
      fetch: fake.fetch,
      now: () => NOW,
      randomValue: () => values.shift() ?? "Z".repeat(43),
    });
    const started = await begin(auth);
    expect(started.status).toBe(303);
    expect(started.headers.get("location")).toBe("/auth/login?next=%2Fsettings&error=unavailable");
    expect(started.headers.get("set-cookie")).toBeNull();

    const callback = callbackRequest({ origin: ORIGIN });
    const completed = await auth.completeLogin(callback);
    expect(completed.status).toBe(400);
    expect(completed.headers.get("content-type")).toContain("application/json");
    const failureBody = await completed.text();
    expect(JSON.parse(failureBody)).toEqual({ error: "bad_request" });
    expect(failureBody).not.toContain("auth-form");
    expect(failureBody).not.toContain("submit()");
    expect(callback.body?.locked).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects duplicate pending or session cookies on the same-origin leg without exchange", async () => {
    const { auth, fake } = provider();
    const pending = cookieValue(await begin(auth), NIHO_PENDING_COOKIE);
    for (const cookie of [
      `${NIHO_PENDING_COOKIE}=${pending}; ${NIHO_PENDING_COOKIE}=${pending}`,
      `${NIHO_PENDING_COOKIE}=${pending}; ${NIHO_SESSION_COOKIE}=${CREDENTIAL}; ${NIHO_SESSION_COOKIE}=${CREDENTIAL}`,
    ]) {
      const response = await auth.completeLogin(callbackRequest({ origin: ORIGIN, cookie }));
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(fake.calls.filter((call) => call.url.endsWith("/exchange"))).toHaveLength(0);
  });
});


it.each(["malformed-json", "wrong-content-type", "read-error", "oversized-body"])(
  "normalizes a successful upstream response body failure: %s", async (failure) => {
    const fetch = vi.fn(async () => {
      if (failure === "read-error") return new Response(new ReadableStream({
        start(controller) { controller.error(new Error("untrusted provider detail")); },
      }), { headers: { "content-type": "application/json" } });
      if (failure === "wrong-content-type") return new Response("upstream html", { headers: { "content-type": "text/html" } });
      if (failure === "oversized-body") return new Response("x".repeat(16 * 1024 + 1), { headers: { "content-type": "application/json" } });
      return new Response("{broken-json", { headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const auth = createNihoAuthProvider({ env: () => ({ EDITOR_NIHO_ORIGIN: NIHO, EDITOR_ORIGIN: ORIGIN }), fetch, now: () => NOW });
    await expect(auth.getSession({ headers: new Headers({ cookie: `${NIHO_SESSION_COOKIE}=${CREDENTIAL}` }) }))
      .rejects.toBeInstanceOf(AuthTemporarilyUnavailable);
  },
);
