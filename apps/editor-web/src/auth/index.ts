import "server-only";
import { isTrustedNihoOrigin, resolveAuthMode, type AuthEnv, type AuthMode } from "./config";
import { googleAuthProvider } from "./google";
import { nihoAuthProvider } from "./niho";
import { nihoExperienceAuthProvider } from "./niho-experience";
import { stubAuthProvider } from "./stub";
import type { AuthProvider } from "./types";

const PROVIDERS: Readonly<Record<AuthMode, AuthProvider>> = {
  stub: stubAuthProvider,
  niho: nihoExperienceAuthProvider,
  google: googleAuthProvider,
};

/**
 * 要求ごとに方式を選ぶ。起動時の検査（src/instrumentation.ts）をすり抜けても、本番で stub は返らない
 * （resolveAuthMode が throw し、要求は 500 の汎用エラーになる）。
 */
export function getAuthProvider(env: AuthEnv = process.env): AuthProvider {
  return PROVIDERS[resolveAuthMode(env)];
}

/**
 * 写真専用の旧 NIHO provider。Docs の global provider は Experience editor contract を使い、Photo の Cookie と callback は分離する。
 * global mode の検査は getAuthProvider と同じまま通し、NIHO 接続先が明示されたときだけ写真の接続口を開く。
 */
export function getPhotoAuthProvider(env: AuthEnv = process.env): AuthProvider | null {
  const mode = resolveAuthMode(env);
  if (mode === "niho") return nihoAuthProvider;
  return isTrustedNihoOrigin(env.EDITOR_NIHO_ORIGIN) ? nihoAuthProvider : null;
}

export { AuthTemporarilyUnavailable } from "./types";
export type { AuthProvider, Session, SessionRequest } from "./types";
