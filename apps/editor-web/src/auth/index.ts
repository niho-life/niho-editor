import "server-only";
import { resolveAuthMode, type AuthEnv, type AuthMode } from "./config";
import { googleAuthProvider } from "./google";
import { nihoAuthProvider } from "./niho";
import { stubAuthProvider } from "./stub";
import type { AuthProvider } from "./types";

const PROVIDERS: Readonly<Record<AuthMode, AuthProvider>> = {
  stub: stubAuthProvider,
  niho: nihoAuthProvider,
  google: googleAuthProvider,
};

/**
 * 要求ごとに方式を選ぶ。起動時の検査（src/instrumentation.ts）をすり抜けても、本番で stub は返らない
 * （resolveAuthMode が throw し、要求は 500 の汎用エラーになる）。
 */
export function getAuthProvider(env: AuthEnv = process.env): AuthProvider {
  return PROVIDERS[resolveAuthMode(env)];
}

export { AuthTemporarilyUnavailable } from "./types";
export type { AuthProvider, Session, SessionRequest } from "./types";
