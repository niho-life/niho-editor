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

function fakeNiho(options: { fail?: string; invalid?: string; confirmationPath?: string; sessionExpiresAt?: string } = {}) {
  const calls: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> }> = [];
  const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, init, body });
    if (options.fail === path) return Response.json({ error: { code: "SERVICE_UNAVAILABLE" } }, { status: 503 });
    if (path.endsWith("/begin")) {
      return Response.json(options.invalid === path ? { unexpected: true } : {
        attemptId: ATTEMPT,
        expiresAt: new Date(NOW + 600_000).toISOString(),
        confirmationPath: options.confirmationPath ?? `/connect/niho-editor?attempt_id=${ATTEMPT}&state=${body.state}`,
      });
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
      env: () => ({ EDITOR_NIHO_ORIGIN: NIHO }),
      fetch: fake.fetch,
      now,
      randomValue: () => values.shift() ?? "Z".repeat(43),
    }),
    fake,
  };
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
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${NIHO}/connect/niho-editor?attempt_id=${ATTEMPT}&state=${STATE}`);
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${NIHO_PENDING_COOKIE}=`)) ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=610");
    expect(fake.calls[0]?.body).toMatchObject({ clientId: "niho-editor", state: STATE, codeChallengeMethod: "S256" });
    expect(fake.calls[0]?.body).not.toHaveProperty("codeVerifier");
    expect(fake.calls[0]?.init).toMatchObject({ redirect: "error", cache: "no-store" });
  });

  it("rejects an absolute confirmation URL even when it has the trusted origin", async () => {
    const fake = fakeNiho({
      confirmationPath: `${NIHO}/connect/niho-editor?attempt_id=${ATTEMPT}&state=${STATE}`,
    });
    const { auth } = provider(fake);
    const response = await begin(auth);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/auth/login?next=%2Fsettings&error=unavailable");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("exchanges only a strict matching callback and does not clear a newer pending cookie on stale callbacks", async () => {
    const { auth, fake } = provider();
    const started = await begin(auth);
    const pending = cookieValue(started, NIHO_PENDING_COOKIE);
    const stale = await auth.completeLogin(new Request(`${ORIGIN}/auth/callback?code=${CODE}&state=${"X".repeat(43)}`, {
      headers: { cookie: `${NIHO_PENDING_COOKIE}=${pending}` },
    }));
    expect(stale.headers.get("set-cookie")).toBeNull();
    expect(fake.calls.some((call) => call.url.endsWith("/exchange"))).toBe(false);

    const completed = await auth.completeLogin(new Request(`${ORIGIN}/auth/callback?code=${CODE}&state=${STATE}`, {
      headers: { cookie: `${NIHO_PENDING_COOKIE}=${pending}` },
    }));
    expect(completed.status).toBe(303);
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

    const lateCallback = await first.auth.completeLogin(new Request(`${ORIGIN}/auth/callback?code=${CODE}&state=${STATE}`, {
      headers: { cookie: `${NIHO_PENDING_COOKIE}=${pending}` },
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
});
