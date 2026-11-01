import { safeReturnTo } from "../auth/return-to";
import type { AuthProvider } from "../auth/types";
import { errorResponse, guarded, isSameOriginRequest } from "./http";

/** `/auth/*` の route が使うもの。route から渡す（テストでは差し替える）。 */
export type AuthRoutesDeps = {
  auth: () => AuthProvider;
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

/** GET /auth/callback — NIHO から戻ったところ。 */
export function finishLogin(request: Request, deps: AuthRoutesDeps): Promise<Response> {
  return guarded("GET /auth/callback", async () => noStore(await deps.auth().completeLogin(request)));
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
