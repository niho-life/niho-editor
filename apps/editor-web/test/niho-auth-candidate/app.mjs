import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { resolveAuthMode, isTrustedNihoOrigin } = require("./src/auth/config.js");
const { createNihoAuthProvider } = require("./src/auth/niho.js");
const routes = require("./src/server/auth-routes.js");
const { verifyPhotoActor, PhotoAuthError } = require("./src/server/photo-auth/index.js");

const page = '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>NIHO 認証確認</title><main><h1>NIHO 認証確認</h1><p>認証だけを確認する候補環境です。</p><a href="/auth/login/start?next=%2Fapi%2Fphoto%2Fv1%2Fauth%2Fsession">NIHOで接続する</a></main></html>';

export function createHandler(env, manifest, provider) {
  if (env.EDITOR_AUTH_MODE !== "niho" || resolveAuthMode(env) !== "niho" || !isTrustedNihoOrigin(env.EDITOR_ORIGIN)) {
    throw new Error("NIHO mode and exact trusted origins are required");
  }
  const auth = provider ?? createNihoAuthProvider({ env: () => env });
  if (auth.mode !== "niho") throw new Error("NIHO provider is required");
  const deps = { auth: () => auth, env };
  return async request => {
    const url = new URL(request.url);
    let response;
    if (url.origin !== env.EDITOR_ORIGIN) response = new Response(null, { status: 400 });
    else if (request.method === "GET" && ["/", "/auth/login"].includes(url.pathname)) {
      response = new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    } else if (request.method === "GET" && url.pathname === "/health") response = Response.json({ ok: true, ...manifest });
    else if (request.method === "GET" && url.pathname === "/auth/login/start") response = await routes.startLogin(request, deps);
    else if (request.method === "POST" && url.pathname === "/auth/callback") response = await routes.finishLogin(request, deps);
    else if (request.method === "POST" && url.pathname === "/auth/logout") response = await routes.logout(request, deps);
    else if (request.method === "POST" && url.pathname === "/auth/refresh") response = await routes.refresh(request, deps);
    else if (request.method === "GET" && url.pathname === "/api/photo/v1/auth/session") {
      try {
        const { actor, refreshRequired } = await verifyPhotoActor(request, deps);
        response = Response.json({ userId: actor.userId, sessionId: actor.sessionId, expiresAt: actor.expiresAt, refreshRequired });
      } catch (error) {
        response = Response.json({ error: error instanceof PhotoAuthError ? error.code : "internal", retryable: error instanceof PhotoAuthError && error.retryable }, { status: error instanceof PhotoAuthError ? error.status : 500 });
      }
    } else response = new Response(null, { status: 404 });
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    if (!response.headers.has("Referrer-Policy")) response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  };
}
