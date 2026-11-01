import { loginErrorOf, photoLoginPath, safePhotoReturnTo, safeReturnTo, seeOther } from "../auth/return-to";
import type { AuthProvider } from "../auth/types";
import { errorResponse, guarded, isSameOriginRequest } from "./http";

/** `/auth/*` の route が使うもの。route から渡す（テストでは差し替える）。 */
export type AuthRoutesDeps = {
  auth: () => AuthProvider;
  photoAuth?: () => AuthProvider | null;
  env?: Readonly<Record<string, string | undefined>>;
};

/** 方式が返した応答を cache させない（Set-Cookie などの header はそのまま残す）。 */
function noStore(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.set("Cache-Control", "no-store");
  return copy;
}

/** GET /auth/login/start?next= — ログインを始める。戻り先は editor の中の path だけ（safeReturnTo）。 */
export function startLogin(request: Request, deps: AuthRoutesDeps): Promise<Response> {
  return guarded("GET /auth/login/start", async () => {
    const returnTo = safeReturnTo(new URL(request.url).searchParams.get("next"));
    return noStore(await deps.auth().beginLogin({ request, returnTo }));
  });
}

function methodNotAllowed(allow: "GET" | "POST"): Response {
  return new Response(null, { status: 405, headers: { Allow: allow, "Cache-Control": "no-store" } });
}

function unavailable(): Response {
  return errorResponse("unavailable");
}

/** 明示 seam があればそれだけを使う。候補serviceの旧depsはNIHOの既定providerだけを許す。 */
function photoProvider(deps: AuthRoutesDeps): AuthProvider | null {
  const provider = deps.photoAuth ? deps.photoAuth() : deps.auth();
  return provider?.mode === "niho" ? provider : null;
}

/** NIHO provider が返す既存の `/auth/login` だけを写真ログインへ移す。外部Locationや成功先は触らない。 */
function rewritePhotoLogin(response: Response, requirePhotoReturnTo = false): Response {
  const location = response.headers.get("Location");
  if (!location || (location !== "/auth/login" && !location.startsWith("/auth/login?"))) return response;
  let parsed: URL;
  try {
    parsed = new URL(location, "https://editor.invalid");
  } catch {
    return response;
  }
  if (parsed.origin !== "https://editor.invalid" || parsed.pathname !== "/auth/login") return response;
  const returnTo = safeReturnTo(parsed.searchParams.get("next"));
  // callbackはDocsと共用。providerが保持した戻り先で写真フローだけを選び、Docsの失敗先を変えない。
  if (requirePhotoReturnTo && safePhotoReturnTo(returnTo) !== returnTo) return response;
  const next = safePhotoReturnTo(returnTo);
  const error = loginErrorOf(parsed.searchParams.get("error") ?? undefined) ?? undefined;
  const copy = new Response(response.body, response);
  copy.headers.set("Location", photoLoginPath(next, error));
  return copy;
}

/** GET（Google）/ POST（NIHO） /auth/callback。方式と異なる transport は provider へ渡さない。 */
export function finishLogin(request: Request, deps: AuthRoutesDeps): Promise<Response> {
  return guarded(`${request.method} /auth/callback`, async () => {
    if (request.method === "POST" && deps.photoAuth) {
      const provider = photoProvider(deps);
      if (!provider) return unavailable();
      return noStore(rewritePhotoLogin(await provider.completeLogin(request), true));
    }
    const provider = deps.auth();
    if (request.method === "GET" && provider.mode === "niho") return methodNotAllowed("POST");
    if (request.method === "POST" && provider.mode !== "niho") return methodNotAllowed("GET");
    if (request.method !== "GET" && request.method !== "POST") return methodNotAllowed(provider.mode === "niho" ? "POST" : "GET");
    return noStore(await provider.completeLogin(request));
  });
}

/** GET /photo/auth/start — 写真のNIHOログインだけを始める。 */
export function startPhotoLogin(request: Request, deps: AuthRoutesDeps): Promise<Response> {
  return guarded("GET /photo/auth/start", async () => {
    const returnTo = safePhotoReturnTo(new URL(request.url).searchParams.get("next"));
    const provider = photoProvider(deps);
    if (!provider) return seeOther(photoLoginPath(returnTo, "unavailable"));
    return noStore(rewritePhotoLogin(await provider.beginLogin({ request, returnTo })));
  });
}

/** POST /auth/logout — 同じ origin の画面からだけ（それ以外は 403）。 */
export function logout(request: Request, deps: AuthRoutesDeps): Promise<Response> {
  return guarded("POST /auth/logout", async () => {
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    return noStore(await deps.auth().logout(request));
  });
}

/** POST /auth/refresh — cookie更新は同じoriginのRoute Handlerからだけ。未対応providerは204のno-op。 */
export function refresh(request: Request, deps: AuthRoutesDeps): Promise<Response> {
  return guarded("POST /auth/refresh", async () => {
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const provider = deps.auth();
    if (!provider.refresh) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    return noStore(await provider.refresh(request));
  });
}

/** POST /photo/auth/logout — NIHO写真cookieだけを失効する。 */
export function logoutPhoto(request: Request, deps: AuthRoutesDeps): Promise<Response> {
  return guarded("POST /photo/auth/logout", async () => {
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const provider = photoProvider(deps);
    if (!provider) return unavailable();
    return noStore(rewritePhotoLogin(await provider.logout(request)));
  });
}

/** POST /photo/auth/refresh — NIHO写真cookieだけを更新する。 */
export function refreshPhoto(request: Request, deps: AuthRoutesDeps): Promise<Response> {
  return guarded("POST /photo/auth/refresh", async () => {
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const provider = photoProvider(deps);
    if (!provider?.refresh) return unavailable();
    return noStore(await provider.refresh(request));
  });
}
