import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { NIHO_SESSION_COOKIE } from "./niho";
import { AuthTemporarilyUnavailable, type Session, type SessionRequest } from "./types";
import {
  createNihoExperienceAuthProvider,
  EXPERIENCE_EDITOR_FIREBASE_REFRESH_COOKIE,
  EXPERIENCE_EDITOR_ID_TOKEN_COOKIE,
  EXPERIENCE_EDITOR_NAME_COOKIE,
  EXPERIENCE_EDITOR_PENDING_COOKIE,
  EXPERIENCE_EDITOR_REFRESH_COOKIE,
} from "./niho-experience";

const NIHO = "https://niho.example.invalid";
const EDITOR = "https://editor.example.invalid";
const API_KEY = "A".repeat(39);
const NOW = Date.parse("2026-11-02T00:00:00.000Z");
const STATE = "state_value-12345678901234567890";
const VERIFIER = "v".repeat(43);
const CODE = "C".repeat(43);
const ID_TOKEN = "I".repeat(100);
const FIREBASE_REFRESH = "F".repeat(43);
const NIHO_REFRESH = "R".repeat(43);
const CONNECTION_ID = "synthetic-connection-id";
const USER_ID = "synthetic-niho-user";
const CONNECTION_EXPIRY = new Date(NOW + 180 * 24 * 60 * 60 * 1000).toISOString();

function loginRandomValues() {
  const values = [STATE, VERIFIER];
  return () => values.shift() ?? VERIFIER;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function provider(fetch: typeof globalThis.fetch, randomValue = () => VERIFIER) {
  return createNihoExperienceAuthProvider({
    env: () => ({ EDITOR_NIHO_ORIGIN: NIHO, EDITOR_ORIGIN: EDITOR, EDITOR_NIHO_FIREBASE_API_KEY: API_KEY }),
    fetch,
    now: () => NOW,
    randomValue,
  });
}

function formPost(origin: string, cookie: string | null, fields = { code: CODE, state: STATE }) {
  return new Request(`${EDITOR}/editor/auth/callback`, {
    method: "POST",
    headers: {
      origin,
      host: new URL(EDITOR).host,
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields),
  });
}

function pendingCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toMatch(new RegExp(`^${EXPERIENCE_EDITOR_PENDING_COOKIE}=`));
  return cookie!.split(";", 1)[0]!;
}

function connectionResponse(displayName: string | null = null) {
  return {
    customToken: "synthetic-custom-token-value-1234567890",
    refreshToken: NIHO_REFRESH,
    connectionId: CONNECTION_ID,
    connectionExpiresAt: CONNECTION_EXPIRY,
    user: { id: USER_ID, displayName, handle: null, iconImage: null },
  };
}

function exchangeFetch(displayName: string | null): typeof globalThis.fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/api/auth/experience-editor-connect/exchange")) return json(connectionResponse(displayName));
    if (url.includes("identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken")) {
      return json({ idToken: ID_TOKEN, refreshToken: FIREBASE_REFRESH, expiresIn: "3600", localId: "firebase-user" });
    }
    if (url.endsWith("/api/auth/experience-editor-connect/session")) return json(sessionResponse());
    throw new Error("unexpected upstream URL");
  };
}

function cookiePair(cookies: readonly string[], name: string): string | undefined {
  return cookies.find((cookie) => cookie.startsWith(`${name}=`))?.split(";", 1)[0];
}

function sessionResponse() {
  return {
    actor: { id: USER_ID },
    connection: { id: CONNECTION_ID, expiresAt: CONNECTION_EXPIRY },
    account: { active: true },
  };
}

describe("NIHO Experience editor auth", () => {
  it("refreshes a legacy session's missing name while keeping its NIHO actor", async () => {
    const auth = provider(exchangeFetch("Synthetic Writer"), loginRandomValues());
    const started = await auth.beginLogin({ request: new Request(`${EDITOR}/auth/login/start?sameAccount=1`, {
      headers: { cookie: `${EXPERIENCE_EDITOR_ID_TOKEN_COOKIE}=${ID_TOKEN}` },
    }), returnTo: "/settings" });
    const pair = pendingCookie(started);
    const pending = JSON.parse(Buffer.from(pair.split("=", 2)[1]!, "base64url").toString("utf8"));
    expect(pending.accountHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(pending)).not.toContain(USER_ID);
    const response = await auth.completeLogin(formPost(EDITOR, pair));
    expect(response.headers.get("location")).toBe("/settings");
    const cookies = response.headers.getSetCookie();
    const name = cookiePair(cookies, EXPERIENCE_EDITOR_NAME_COOKIE);
    const session = await auth.getSession({ headers: new Headers({ cookie: `${EXPERIENCE_EDITOR_ID_TOKEN_COOKIE}=${ID_TOKEN}; ${name}` }) });
    expect(session?.userId).toBe(USER_ID);
    expect(session?.profile?.name).toBe("Synthetic Writer");
  });

  it("rejects another actor during a same-account refresh and preserves the old cookies", async () => {
    let exchanged = false;
    const revocations: string[] = [];
    const oldRefresh = "O".repeat(43);
    const auth = provider(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/session")) {
        const value = sessionResponse();
        if (exchanged) value.actor.id = "different-synthetic-user";
        return json(value);
      }
      if (url.endsWith("/exchange")) {
        exchanged = true;
        const value = connectionResponse("Other Writer");
        value.user.id = "different-synthetic-user";
        return json(value);
      }
      if (url.includes("accounts:signInWithCustomToken")) return json({ idToken: ID_TOKEN, refreshToken: FIREBASE_REFRESH, expiresIn: "3600" });
      if (url.endsWith("/revoke")) { revocations.push(JSON.parse(String(init?.body)).refreshToken); return new Response(null, { status: 204 }); }
      throw new Error("unexpected upstream request");
    }, loginRandomValues());
    const oldCookies = `${EXPERIENCE_EDITOR_ID_TOKEN_COOKIE}=${ID_TOKEN}; ${EXPERIENCE_EDITOR_REFRESH_COOKIE}=${oldRefresh}`;
    const started = await auth.beginLogin({ request: new Request(`${EDITOR}/auth/login/start?sameAccount=1`, { headers: { cookie: oldCookies } }), returnTo: "/settings" });
    const response = await auth.completeLogin(formPost(EDITOR, `${pendingCookie(started)}; ${oldCookies}`));
    expect(response.headers.get("location")).toBe("/settings?identity=mismatch");
    expect(response.headers.getSetCookie()).toEqual([expect.stringContaining(`${EXPERIENCE_EDITOR_PENDING_COOKIE}=;`)]);
    expect(revocations).toEqual([NIHO_REFRESH]);
    expect(revocations).not.toContain(oldRefresh);
  });

  it("does not start a same-account refresh when the existing actor cannot be verified", async () => {
    const auth = provider(async () => json({}, 401), loginRandomValues());
    const response = await auth.beginLogin({ request: new Request(`${EDITOR}/auth/login/start?sameAccount=1`, {
      headers: { cookie: `${EXPERIENCE_EDITOR_ID_TOKEN_COOKIE}=${ID_TOKEN}` },
    }), returnTo: "/settings" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("error=unavailable");
    expect(response.headers.getSetCookie()).toEqual([expect.stringContaining(`${EXPERIENCE_EDITOR_PENDING_COOKIE}=;`)]);
  });

  it("POSTs PKCE login fields to the fixed NIHO start endpoint without contacting the Photo connect API", async () => {
    const auth = provider(async () => { throw new Error("no upstream request is expected"); }, loginRandomValues());
    const response = await auth.beginLogin({ request: new Request(`${EDITOR}/auth/login/start`), returnTo: "/p/new" });
    const html = await response.text();
    const challenge = createHash("sha256").update(VERIFIER, "ascii").digest("base64url");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-security-policy")).toContain(`form-action ${NIHO}`);
    expect(response.headers.get("referrer-policy")).toBe("origin");
    expect(html).toContain(`action="${NIHO}/connect/niho-editor/start"`);
    expect(html).toContain(`name="code_challenge" value="${challenge}"`);
    expect(html).toContain(`name="code_challenge_method" value="S256"`);
    expect(html).toContain(`name="state" value="${STATE}"`);
    expect(html).not.toContain("code_challenge=");
    expect(html).not.toContain("state=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax; Path=/");
  });

  it("relays NIHO's callback form to the same-origin Editor callback without URL fields", async () => {
    const auth = provider(async () => { throw new Error("callback relay does not call the API"); });
    const response = await auth.completeLogin(formPost(NIHO, null));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(html).toContain(`action="${EDITOR}/editor/auth/callback"`);
    expect(html).toContain(`name="code" value="${CODE}"`);
    expect(html).toContain(`name="state" value="${STATE}"`);
    expect(response.headers.get("location")).toBeNull();
  });

  it("exchanges the form code server-side and stores only HttpOnly cookies", async () => {
    const auth = provider(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/auth/experience-editor-connect/exchange")) return json(connectionResponse());
      if (url.includes("identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken")) {
        return json({ idToken: ID_TOKEN, refreshToken: FIREBASE_REFRESH, expiresIn: "3600", localId: "firebase-user" });
      }
      if (url.endsWith("/api/auth/experience-editor-connect/session")) return json(sessionResponse());
      throw new Error("unexpected upstream URL");
    }, loginRandomValues());
    const started = await auth.beginLogin({ request: new Request(`${EDITOR}/auth/login/start`), returnTo: "/p/new" });
    const response = await auth.completeLogin(formPost(EDITOR, pendingCookie(started)));
    expect([response.status, response.headers.get("location")]).toEqual([303, "/p/new"]);
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.startsWith(`${EXPERIENCE_EDITOR_ID_TOKEN_COOKIE}=${ID_TOKEN};`))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith(`${EXPERIENCE_EDITOR_FIREBASE_REFRESH_COOKIE}=${FIREBASE_REFRESH};`))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith(`${EXPERIENCE_EDITOR_REFRESH_COOKIE}=${NIHO_REFRESH};`))).toBe(true);
    expect(cookies.every((cookie) => cookie.includes("HttpOnly; Secure; SameSite=Lax; Path=/"))).toBe(true);
    expect(JSON.stringify(response.headers)).not.toContain(ID_TOKEN);
  });

  it("keeps NIHO's display name from the login as the session's author name, only for the same user", async () => {
    const auth = provider(exchangeFetch("  Takuya  "), loginRandomValues());
    const started = await auth.beginLogin({ request: new Request(`${EDITOR}/auth/login/start`), returnTo: "/" });
    const cookies = (await auth.completeLogin(formPost(EDITOR, pendingCookie(started)))).headers.getSetCookie();
    const name = cookiePair(cookies, EXPERIENCE_EDITOR_NAME_COOKIE);
    expect(name).toBeDefined();
    expect(cookies.find((cookie) => cookie.startsWith(`${EXPERIENCE_EDITOR_NAME_COOKIE}=`))).toContain("HttpOnly; Secure; SameSite=Lax; Path=/");
    expect(name).not.toContain("Takuya");

    const session = await auth.getSession({ headers: new Headers({ cookie: `${EXPERIENCE_EDITOR_ID_TOKEN_COOKIE}=${ID_TOKEN}; ${name}` }) });
    expect(session).toEqual({ userId: USER_ID, mode: "niho", sessionId: CONNECTION_ID, expiresAt: CONNECTION_EXPIRY, profile: { name: "Takuya" } });

    // Written for another user, malformed or repeated: no name (the publication then fails closed, as before).
    const otherUser = `${EXPERIENCE_EDITOR_NAME_COOKIE}=${Buffer.from("other-user").toString("base64url")}.${Buffer.from("Mallory").toString("base64url")}`;
    for (const cookie of [otherUser, `${EXPERIENCE_EDITOR_NAME_COOKIE}=not.a.value`, `${name}; ${name}`]) {
      const read = await auth.getSession({ headers: new Headers({ cookie: `${EXPERIENCE_EDITOR_ID_TOKEN_COOKIE}=${ID_TOKEN}; ${cookie}` }) });
      expect(read?.profile).toBeUndefined();
    }
  });

  it("reads back the longest display name the login accepts (200 four-byte characters)", async () => {
    // 200 絵文字 = UTF-8 で 800 バイト = base64url で 1067 文字（読み取り側が 1024 までだと、保存した名前を読めなかった）
    const longest = "😀".repeat(200);
    const auth = provider(exchangeFetch(longest), loginRandomValues());
    const started = await auth.beginLogin({ request: new Request(`${EDITOR}/auth/login/start`), returnTo: "/" });
    const cookies = (await auth.completeLogin(formPost(EDITOR, pendingCookie(started)))).headers.getSetCookie();
    const name = cookiePair(cookies, EXPERIENCE_EDITOR_NAME_COOKIE);
    expect(name).toBeDefined();
    const session = await auth.getSession({ headers: new Headers({ cookie: `${EXPERIENCE_EDITOR_ID_TOKEN_COOKIE}=${ID_TOKEN}; ${name}` }) });
    expect(session?.profile).toEqual({ name: longest });
    // 201 文字は、保存の側が名前なしにする（クッキーを書かない）
    const tooLong = provider(exchangeFetch("😀".repeat(201)), loginRandomValues());
    const again = await tooLong.beginLogin({ request: new Request(`${EDITOR}/auth/login/start`), returnTo: "/" });
    const clearing = (await tooLong.completeLogin(formPost(EDITOR, pendingCookie(again)))).headers.getSetCookie();
    expect(clearing).toContain(`${EXPERIENCE_EDITOR_NAME_COOKIE}=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/`);
  });

  it("clears a previous name when NIHO returns no display name", async () => {
    const auth = provider(exchangeFetch(null), loginRandomValues());
    const started = await auth.beginLogin({ request: new Request(`${EDITOR}/auth/login/start`), returnTo: "/" });
    const cookies = (await auth.completeLogin(formPost(EDITOR, pendingCookie(started)))).headers.getSetCookie();
    expect(cookies).toContain(`${EXPERIENCE_EDITOR_NAME_COOKIE}=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/`);
  });

  it("revalidates the same NIHO session before using its server-only token for the fixed account purposes", async () => {
    const auth = provider(async (input) => {
      expect(String(input)).toBe(`${NIHO}/api/auth/experience-editor-connect/session`);
      return json(sessionResponse());
    });
    const request = { headers: new Headers({ cookie: `${EXPERIENCE_EDITOR_ID_TOKEN_COOKIE}=${ID_TOKEN}` }) };
    const session = await auth.getSession(request);
    expect(session).toEqual({ userId: USER_ID, mode: "niho", sessionId: CONNECTION_ID, expiresAt: CONNECTION_EXPIRY });
    expect(await auth.apiToken?.(session!)).toBeNull();
    expect(await auth.articleApiToken?.(session!, request, "roles")).toBe(ID_TOKEN);
    expect(await auth.articleApiToken?.(session!, request, "article-links")).toBe(ID_TOKEN);
    expect(await auth.docsApiToken?.(session!, request)).toBe(ID_TOKEN);
    expect(await auth.articleApiToken?.({ ...session!, sessionId: "other-session" }, request, "roles")).toBeNull();
    expect(await auth.docsApiToken?.({ ...session!, sessionId: "other-session" }, request)).toBeNull();
    expect(await auth.articleApiToken?.(session!, { headers: new Headers({ cookie: `${NIHO_SESSION_COOKIE}=${"P".repeat(100)}` }) }, "roles")).toBeNull();
    expect(await auth.docsApiToken?.(session!, { headers: new Headers({ cookie: `${NIHO_SESSION_COOKIE}=${"P".repeat(100)}` }) })).toBeNull();
    expect(await (auth.articleApiToken as unknown as (session: Session, request: SessionRequest, purpose: string) => Promise<string | null>)(session!, request, "photo")).toBeNull();
  });

  it("does not authorize Editor with the legacy Photo cookie or a browser bearer token", async () => {
    const upstream = vi.fn(async () => json(sessionResponse()));
    const auth = provider(upstream);
    const session = await auth.getSession({ headers: new Headers({
      cookie: `${NIHO_SESSION_COOKIE}=${"P".repeat(100)}`,
      authorization: `Bearer ${ID_TOKEN}`,
    }) });
    expect(session).toBeNull();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("uses only the Editor cookie when both products have credentials", async () => {
    const auth = provider(async (input, init) => {
      expect(String(input)).toBe(`${NIHO}/api/auth/experience-editor-connect/session`);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${ID_TOKEN}`);
      return json(sessionResponse());
    });
    const session = await auth.getSession({ headers: new Headers({
      cookie: `${NIHO_SESSION_COOKIE}=${"P".repeat(100)}; ${EXPERIENCE_EDITOR_ID_TOKEN_COOKIE}=${ID_TOKEN}`,
    }) });
    expect(session?.userId).toBe(USER_ID);
  });

  it("rejects the next request after NIHO revokes an accepted connection", async () => {
    const upstream = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(sessionResponse()))
      .mockResolvedValueOnce(json({ error: "unauthenticated" }, 401));
    const auth = provider(upstream);
    const request = { headers: new Headers({ cookie: `${EXPERIENCE_EDITOR_ID_TOKEN_COOKIE}=${ID_TOKEN}` }) };
    expect((await auth.getSession(request))?.userId).toBe(USER_ID);
    expect(await auth.getSession(request)).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...sessionResponse(), account: { active: false } },
    { ...sessionResponse(), connection: { id: CONNECTION_ID, expiresAt: new Date(NOW).toISOString() } },
  ])("grants no session for an inactive account or expired connection", async (payload) => {
    const auth = provider(async () => json(payload));
    await expect(auth.getSession({ headers: new Headers({ cookie: `${EXPERIENCE_EDITOR_ID_TOKEN_COOKIE}=${ID_TOKEN}` }) }))
      .rejects.toBeInstanceOf(AuthTemporarilyUnavailable);
  });

  it("keeps an upstream outage distinct from an unauthenticated session", async () => {
    const auth = provider(async () => json({ error: "temporarily_unavailable" }, 503));
    await expect(auth.getSession({ headers: new Headers({ cookie: `${EXPERIENCE_EDITOR_ID_TOKEN_COOKIE}=${ID_TOKEN}` }) }))
      .rejects.toBeInstanceOf(AuthTemporarilyUnavailable);
  });

  it("refreshes Firebase ID tokens server-side and confirms the connection remains active", async () => {
    const auth = provider(async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://securetoken.googleapis.com/v1/token?key=")) {
        expect(init?.headers).toMatchObject({ "content-type": "application/x-www-form-urlencoded" });
        expect(String(init?.body)).toContain(`refresh_token=${FIREBASE_REFRESH}`);
        return json({ id_token: "J".repeat(100), refresh_token: "G".repeat(43), expires_in: "3600", user_id: "firebase-user" });
      }
      if (url.endsWith("/api/auth/experience-editor-connect/session")) return json(sessionResponse());
      throw new Error("unexpected upstream URL");
    });
    const expiry = String(NOW + 90 * 24 * 60 * 60 * 1000);
    const response = await auth.refresh!(new Request(`${EDITOR}/auth/refresh`, {
      method: "POST",
      headers: {
        origin: EDITOR,
        cookie: [
          `${EXPERIENCE_EDITOR_FIREBASE_REFRESH_COOKIE}=${FIREBASE_REFRESH}`,
          `${EXPERIENCE_EDITOR_REFRESH_COOKIE}=${NIHO_REFRESH}`,
          `__Host-editor-experience-expiry=${expiry}`,
        ].join("; "),
      },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join("\n")).toContain("__Host-editor-experience-id=JJJJ");
    expect(await response.text()).not.toContain("J".repeat(100));
  });

  it("rejects a callback from an untrusted origin and a state mismatch", async () => {
    const auth = provider(async () => { throw new Error("invalid callback must not call upstream"); }, loginRandomValues());
    const started = await auth.beginLogin({ request: new Request(`${EDITOR}/auth/login/start`), returnTo: "/settings" });
    const cookie = pendingCookie(started);
    expect((await auth.completeLogin(formPost("https://attacker.example.invalid", cookie))).status).toBe(400);
    expect((await auth.completeLogin(formPost(EDITOR, cookie, { code: CODE, state: "wrong_state-1234567890" }))).headers.get("location"))
      .toBe("/auth/login?next=%2Fsettings&error=unavailable");
  });

  it("logs only a callback rejection category and status", async () => {
    const auth = provider(async () => { throw new Error("rejected callback must not call upstream"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const untrustedOrigin = "https://attacker.example.invalid";
      expect((await auth.completeLogin(formPost(untrustedOrigin, null))).status).toBe(400);
      expect(log).toHaveBeenLastCalledWith("editor-web: NIHO Experience authentication failed", {
        step: "callback_origin_external",
        status: 400,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain(untrustedOrigin);

      const missingOriginRequest = new Request(`${EDITOR}/editor/auth/callback`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: CODE, state: STATE }),
      });
      expect((await auth.completeLogin(missingOriginRequest)).status).toBe(400);
      expect(log).toHaveBeenLastCalledWith("editor-web: NIHO Experience authentication failed", {
        step: "callback_origin_missing",
        status: 400,
      });

      expect((await auth.completeLogin(formPost(EDITOR, null, { code: "sensitive-code", state: "short" }))).status).toBe(400);
      expect(log).toHaveBeenLastCalledWith("editor-web: NIHO Experience authentication failed", {
        step: "callback_field_format",
        status: 400,
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive-code");
    } finally {
      log.mockRestore();
    }
  });

  it("rejects a callback request that was already aborted before its body is read", async () => {
    const auth = provider(async () => { throw new Error("aborted callback must not call upstream"); });
    const controller = new AbortController();
    controller.abort();
    const request = new Request(`${EDITOR}/editor/auth/callback`, {
      method: "POST",
      headers: { origin: NIHO, host: new URL(EDITOR).host, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: CODE, state: STATE }),
      signal: controller.signal,
    });
    expect((await auth.completeLogin(request)).status).toBe(400);
  });
});
