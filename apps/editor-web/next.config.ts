import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { API_CSP } from "./src/security/csp";

// manifestはCSS変数を解決しないため、共有の面tokenをbuild時だけ読み、色だけをbundleへ埋め込む。
const editorTokens = readFileSync(new URL("../../packages/ui/src/styles/editor-tokens.css", import.meta.url), "utf8");
const photoCanvasColor = /^\s*--ed-canvas:\s*(#[0-9a-f]{6});/im.exec(editorTokens)?.[1];
if (!photoCanvasColor) throw new Error("shared editor canvas token is missing");

/**
 * editor.niho.life は全ページ・全 API の応答を索引に載せない（設計 §2）。
 * header は build のときに固まるので、環境ごとに変わる値（認証の方式・DB）はここに置かず、要求のときに読む。
 */
export const ROBOTS_HEADERS = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];

/**
 * 公開 API v1（`/v1/*`。#40）を除く全ての path。`/` も含む（`/:path*` と同じ範囲から `/v1/` の下だけを外す）。
 * Next は同じ名前の header が既にあると route の応答の値を捨てる（config の値が勝つ）ので、契約が値を決める header
 * （`X-Robots-Tag: noindex`・`Cache-Control`・`Vary`・`Content-Type`）を `/v1` には config から付けない。値は src/public-api/handler.ts が付ける。
 */
export const ALL_BUT_PUBLIC_API = "/:path((?!v1/).*)";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  // 更新系の要求の Origin 検査のため same-origin（no-referrer だと Origin: null になる画面がある）
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=()" },
  // 常に https で開く（http で来た要求は Cloud Run の手前で https に回される）。サブドメインは他の用途があるので preload はしない
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

/**
 * 共有リンク（`/s/{token}`。#34）。全体の規則の後に置く: 同じ名前の header は後の規則の値で置き換わる（値は 1 つだけ）。
 * token は path にあるので、リンク先へ Referer で渡さない（no-referrer。このページに更新系の要求は無い）。
 * 共有の停止・作り直しがすぐ効くよう、ブラウザにも途中の cache にも保存させない。
 */
export const SHARED_PAGE_HEADERS = [
  { key: "Cache-Control", value: "private, no-store" },
  { key: "Referrer-Policy", value: "no-referrer" },
];

/** standalone auto-form handlers own CSP and need a non-null Origin on their POST. */
export const AUTH_FORM_HEADERS = [{ key: "Referrer-Policy", value: "origin" }];

const nextConfig: NextConfig = {
  env: { PHOTO_PWA_CANVAS_COLOR: photoCanvasColor },
  // Cloud Run の container 用の自己完結の server（Dockerfile）
  output: "standalone",
  // packages/* は TypeScript のまま（install-links で node_modules に複製される）
  transpilePackages: ["@niho/docs-core", "@niho/editor-publish", "@niho/editor-publish-contract", "@niho/editor-store", "niho-docs-ui", "niho-ui"],
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingRoot: process.cwd(),
  experimental: {
    // docs-core は TypeScript の NodeNext の書き方（`./types.js` で `./types.ts` を指す）。Turbopack は node_modules の中の
    // この書き方を解決しないので、bundler は webpack にし（package.json の `--webpack`）、`.js` を `.ts` にも当てる。
    extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
  },
  async headers() {
    // ALL_BUT_PUBLIC_API は `/` も含む全ての path（ページ・API・404・robots.txt・静的ファイル）から `/v1/` の下を除いたもの。
    // ページの CSP は nonce が要るので src/proxy.ts が付ける。API は何も読み込まないので固定の CSP。
    return [
      { source: ALL_BUT_PUBLIC_API, headers: [...ROBOTS_HEADERS, ...securityHeaders] },
      { source: "/api/:path*", headers: [{ key: "Content-Security-Policy", value: API_CSP }] },
      // 公開 API（#40）。契約の header と重ならないものだけ（noindex・Cache-Control・Vary は handler が契約どおりに付ける）
      { source: "/v1/:path*", headers: [...securityHeaders, { key: "Content-Security-Policy", value: API_CSP }] },
      // service worker は更新がすぐ届くよう、ブラウザの HTTP cache に残さない（#49）
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }] },
      { source: "/photo-sw.js", headers: [{ key: "Cache-Control", value: "no-cache, must-revalidate" }] },
      // 写真APIのprivate応答をcatch-allのsame-originへ戻さず、handlerのno-referrer契約を保つ。
      { source: "/api/photo/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      // catch-all の same-origin より後で standalone form の exact handler 3 箇所だけを上書きする
      { source: "/auth/login/start", headers: AUTH_FORM_HEADERS },
      { source: "/auth/callback", headers: AUTH_FORM_HEADERS },
      { source: "/photo/auth/start", headers: AUTH_FORM_HEADERS },
      // 共有リンクのページ（#34）。private・no-store・no-referrer。全体の規則のあとに置いて、同じ key（Referrer-Policy）を上書きする
      { source: "/s/:token*", headers: SHARED_PAGE_HEADERS },
    ];
  },
};

export default nextConfig;
