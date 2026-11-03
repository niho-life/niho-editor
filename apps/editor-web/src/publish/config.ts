import { FACE_DESTS, isHttpsUrl, type FaceDest } from "@niho/editor-publish-contract";
import { resolveAuthMode, type AuthMode } from "../auth/config";

/**
 * 公開（#39）の実行時の設定。環境変数だけから決め、値はログ・応答に出さない。
 *
 * - `EDITOR_STUB_ROLES`（stub の方式だけ）: NIHO の役割の代わり。カンマ区切り。未設定なら `writer`。
 *   niho の方式では読まない（役割の契約は #42 と niho-app 側。それまでは役割なし＝面には出せない）。
 * - `EDITOR_DESTINATION_DECLARATIONS`: 面の宣言の取得先。JSON `{"exp": url, "niho": url}`（https だけ。片方だけでもよい）。
 *   未設定なら、stub の方式では同梱の dev 用の宣言、niho の方式では宣言なし（「いまは公開できません」）。
 *   設定してあって読めない（JSON でない・知らない key・https でない）ときは、どちらの方式でも宣言なし（fail closed。dev 用へ落とさない）。
 * - `EDITOR_ASSET_ORIGIN`: 写真を配る https の origin（`${origin}/assets/${sha256}.${ext}`）。未設定・不正なら null
 *   （写真のあるページの公開は失敗する。写真の無いページは出せる）。
 */

export type PublishEnv = Readonly<Record<string, string | undefined>>;

export const DEFAULT_STUB_ROLES: readonly string[] = Object.freeze(["writer"]);

/** 面の宣言をどこから読むか。dev は同梱の宣言、fetch は https の URL、none は無し（どの面も「いまは公開できません」）。 */
export type DeclarationPlan =
  | { readonly kind: "dev" }
  | { readonly kind: "fetch"; readonly urls: Readonly<Partial<Record<FaceDest, string>>> }
  | { readonly kind: "none" };

export type PublishConfig = {
  readonly mode: AuthMode;
  /** この方式で NIHO の代わりに使う役割（niho の方式では使わない）。 */
  readonly stubRoles: readonly string[];
  readonly declarations: DeclarationPlan;
  readonly assetOrigin: string | null;
};

const ROLE = /^[a-z][a-z0-9_-]{0,31}$/;

/** `EDITOR_STUB_ROLES`。未設定なら既定、空なら役割なし。形の合わないものは捨てる。 */
export function stubRolesOf(value: string | undefined): readonly string[] {
  if (value === undefined) return DEFAULT_STUB_ROLES;
  return [...new Set(value.split(",").map((role) => role.trim()).filter((role) => ROLE.test(role)))];
}

/** `EDITOR_DESTINATION_DECLARATIONS` を読む。未設定は null、読めなければ none。 */
export function declarationUrlsOf(value: string | undefined): DeclarationPlan | null {
  if (value === undefined || value.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { kind: "none" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "none" };
  const urls: Partial<Record<FaceDest, string>> = {};
  for (const [key, url] of Object.entries(parsed)) {
    if (!(FACE_DESTS as readonly string[]).includes(key) || !isHttpsUrl(url)) return { kind: "none" };
    urls[key as FaceDest] = url;
  }
  return { kind: "fetch", urls };
}

/** `EDITOR_ASSET_ORIGIN`。https の origin だけ（path・query・認証情報つきは不正）。 */
export function assetOriginOf(value: string | undefined): string | null {
  if (value === undefined || !isHttpsUrl(value)) return null;
  try {
    const url = new URL(value);
    return url.pathname === "/" && url.search === "" && url.hash === "" && value.replace(/\/$/, "") === url.origin ? url.origin : null;
  } catch {
    return null;
  }
}

export function publishConfig(env: PublishEnv = process.env): PublishConfig {
  const mode = resolveAuthMode(env);
  const declared = declarationUrlsOf(env.EDITOR_DESTINATION_DECLARATIONS);
  return {
    mode,
    stubRoles: mode === "stub" ? stubRolesOf(env.EDITOR_STUB_ROLES) : [],
    declarations: declared ?? (mode === "stub" ? { kind: "dev" } : { kind: "none" }),
    assetOrigin: assetOriginOf(env.EDITOR_ASSET_ORIGIN),
  };
}
