import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createHandler } from "../dist/app.mjs";
import { createAcceptanceServer } from "../dist/server.mjs";

const env = { NODE_ENV: "production", EDITOR_AUTH_MODE: "niho", EDITOR_NIHO_ORIGIN: "https://niho.example.invalid", EDITOR_ORIGIN: "https://candidate.example.invalid" };
const manifest = { sourceCommit: "0".repeat(40), hashes: {} };
const cookieName = "__Host-editor-niho-session";
function provider() {
  return {
    mode: "niho",
    getSession: async request => request.headers.get("cookie") ? { mode: "niho", userId: "synthetic-a", sessionId: "synthetic-session", expiresAt: new Date(Date.now() + 60_000).toISOString(), refreshRequired: false } : null,
    beginLogin: async ({ returnTo }) => new Response(null, { status: 303, headers: [["Location", returnTo], ["Set-Cookie", "a=1; HttpOnly; Secure"], ["Set-Cookie", "b=2; HttpOnly; Secure"]] }),
    completeLogin: async () => new Response(null, { status: 303, headers: { Location: "/" } }),
    logout: async () => new Response(null, { status: 303, headers: { Location: "/auth/login" } }),
  };
}
async function serve(t, auth = provider()) {
  const server = createAcceptanceServer(createHandler(env, manifest, auth), env.EDITOR_ORIGIN);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("候補はNIHO固定で設定不足・Google・stubを起動前に拒否する", () => {
  for (const config of [{ ...env, EDITOR_AUTH_MODE: "stub" }, { ...env, EDITOR_AUTH_MODE: "google" }, { ...env, EDITOR_ORIGIN: "" }, { ...env, EDITOR_NIHO_ORIGIN: "" }]) {
    assert.throws(() => createHandler(config, manifest, provider()));
  }
});
test("Docs/写真保存経路を持たず、healthはsource metadataだけを返す", async t => {
  const base = await serve(t);
  for (const route of ["/api/pages", "/api/photo/v1/library", "/api/photo/v1/uploads", "/settings"]) {
    assert.equal((await fetch(`${base}${route}`, { method: "POST" })).status, 404);
  }
  const health = await fetch(`${base}/health`);
  assert.equal(health.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await health.json(), { ok: true, ...manifest });
});
test("HTTP transportで複数Set-Cookieを保ち、本人snapshotとOrigin検査を通す", async t => {
  const base = await serve(t);
  const started = await fetch(`${base}/auth/login/start?next=%2Fapi%2Fphoto%2Fv1%2Fauth%2Fsession`, { redirect: "manual" });
  assert.equal(started.status, 303);
  assert.equal(started.headers.getSetCookie().length, 2);
  assert.equal((await fetch(`${base}/api/photo/v1/auth/session`)).status, 401);
  const snapshot = await fetch(`${base}/api/photo/v1/auth/session`, { headers: { cookie: `${cookieName}=synthetic` } });
  const payload = await snapshot.json();
  assert.equal(payload.userId, "synthetic-a");
  assert.equal(Object.hasOwn(payload, "credential"), false);
  assert.equal((await fetch(`${base}/auth/logout`, { method: "POST", redirect: "manual" })).status, 403);
  assert.equal((await fetch(`${base}/auth/logout`, { method: "POST", headers: { origin: env.EDITOR_ORIGIN }, redirect: "manual" })).status, 303);
});
test("未許可origin・大きなbodyを拒否する", async t => {
  const handler = createHandler(env, manifest, provider());
  assert.equal((await handler(new Request("https://other.example.invalid/health"))).status, 400);
  const base = await serve(t);
  assert.equal((await fetch(`${base}/auth/logout`, { method: "POST", body: "x".repeat(65_537) })).status, 413);
});

test("productionのNIHO providerを同じsourceから実行し、PKCE/cookie/snapshot/logoutを往復する", async t => {
  const { createRequire } = await import("node:module");
  const { createHash } = await import("node:crypto");
  const require = createRequire(import.meta.url);
  const { createNihoAuthProvider } = require("../dist/src/auth/niho.js");
  const attemptId = "11111111-1111-4111-8111-111111111111";
  const credential = `v1.22222222-2222-4222-8222-222222222222.${"d".repeat(43)}`;
  let challenge;
  let revoked = false;
  const actual = createNihoAuthProvider({ env: () => env, fetch: async (input, init) => {
    const url = new URL(input);
    const body = JSON.parse(init.body);
    if (url.pathname.endsWith("/begin")) {
      challenge = body.codeChallenge;
      return Response.json({ attemptId, expiresAt: new Date(Date.now() + 600_000).toISOString(), confirmationPath: `/connect/niho-editor?attempt_id=${attemptId}&state=${body.state}` });
    }
    if (url.pathname.endsWith("/revoke")) { revoked = true; return new Response(null, { status: 204 }); }
    const payload = { actor: { id: "synthetic-canonical" }, sessionId: "synthetic-session", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), clientId: "niho-editor", audience: "niho-photo", refreshRequired: false };
    if (url.pathname.endsWith("/exchange")) {
      assert.equal(createHash("sha256").update(body.codeVerifier).digest("base64url"), challenge);
      return Response.json({ ...payload, credential });
    }
    if (revoked) return new Response(null, { status: 401 });
    assert.equal(body.credential, credential);
    return Response.json(payload);
  } });
  const base = await serve(t, actual);
  const begun = await fetch(`${base}/auth/login/start`, { redirect: "manual" });
  const pending = begun.headers.getSetCookie()[0].split(";")[0];
  const state = new URL(begun.headers.get("location")).searchParams.get("state");
  const callback = await fetch(`${base}/auth/callback?code=${"c".repeat(43)}&state=${state}`, { headers: { cookie: pending }, redirect: "manual" });
  assert.equal(callback.status, 303);
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith(`${cookieName}=`)).split(";")[0];
  assert.equal((await (await fetch(`${base}/api/photo/v1/auth/session`, { headers: { cookie } })).json()).userId, "synthetic-canonical");
  assert.equal((await fetch(`${base}/auth/logout`, { method: "POST", headers: { cookie, origin: env.EDITOR_ORIGIN }, redirect: "manual" })).status, 303);
  assert.equal((await fetch(`${base}/api/photo/v1/auth/session`, { headers: { cookie } })).status, 401);
});
