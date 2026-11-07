import { isHttpsUrl } from "@niho/editor-publish-contract";

/**
 * 公開（#39）の実行時の設定。環境変数だけから決め、値はログ・応答に出さない。
 *
 * - `EDITOR_ASSET_ORIGIN`: 写真を配る https の origin（`${origin}/assets/${sha256}.${ext}`）。未設定・不正なら null
 *   （写真のあるページの公開は失敗する。写真の無いページは出せる）。
 */

export type PublishEnv = Readonly<Record<string, string | undefined>>;

export type PublishConfig = {
  readonly assetOrigin: string | null;
};

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
  return { assetOrigin: assetOriginOf(env.EDITOR_ASSET_ORIGIN) };
}
