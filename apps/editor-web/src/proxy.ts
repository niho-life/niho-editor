import { NextResponse, type NextRequest } from "next/server";
import { EDITOR_PATH_HEADER } from "./lib/editor-path";
import { buildCsp, newNonce } from "@/security/csp";

/**
 * 画面の要求に 2 つを付ける（認証は読まない）。Next の proxy は 1 つだけなので、ここにまとめる。
 * 1. 要求ごとの nonce を持つ CSP（#44）。要求と応答の両方に付ける（Next は要求側の CSP から nonce を取り出して自分の script に付ける）。
 *    client が送ってきた CSP の header は信用せず、必ず上書きする。本文を描く route は動的に描く（layout.tsx）。静的に作った HTML には nonce を入れられない。
 * 2. 今の path と search（#32）。(editor) の layout が未ログインのときの戻り先に使う。要求に同じ名前の header があっても上書きする
 *    （外から戻り先を差し込ませない。戻り先は layout でも safeReturnTo を通す）。
 */
export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  // この2つのRoute Handlerだけが、独立nonceと送信先限定CSPを持つform HTMLを返す。
  // 通常のNext文書用CSPで上書きせず、外から来たCSP/pathも下流へ信用させない。
  if (request.nextUrl.pathname === "/auth/login/start" || request.nextUrl.pathname === "/auth/callback") {
    requestHeaders.delete("Content-Security-Policy");
    requestHeaders.delete(EDITOR_PATH_HEADER);
    return NextResponse.next({ request: { headers: requestHeaders } });
  }
  const csp = buildCsp({ nonce: newNonce(), dev: process.env.NODE_ENV === "development" });
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.set(EDITOR_PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // API（`/api`・公開 API の `/v1/`）は JSON だけなので next.config.ts の固定の CSP を使う。静的ファイルと prefetch には要らない。
      // `/v1/` を通さないので、プレビューの `pv_` token を含む path を戻り先の header に写さない（認証もしない。ログインへ移すのは (editor) の layout だけ）
      source: "/((?!api|v1/|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
