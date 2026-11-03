import "server-only";
import type { AuthProvider, Session, SessionRequest } from "../auth/types";
import { resolveGoogleDocsConfig, type GoogleDocsEnv } from "./config";
import type { GoogleDocsCredential, GoogleDocsGateway } from "./gateway";
import { createNihoGoogleDocsGateway } from "./niho";

/**
 * 要求ごとに書き出しの口を作る（`EDITOR_GOOGLE_DOCS_MODE` などを毎回読む）。使えないときは null
 * （API は 503 `google_docs_unavailable`）: `off`・未設定・設定の誤り。
 * 設定の誤りは起動時の検査（src/startup-check.ts）が先に止めるので、ここは後ろの守り（値を出さずに null）。
 */
export function getGoogleDocsGateway(env: GoogleDocsEnv = process.env): GoogleDocsGateway | null {
  let config;
  try {
    config = resolveGoogleDocsConfig(env);
  } catch {
    return null;
  }
  if (config.mode === "off") return null;
  return createNihoGoogleDocsGateway({ apiBase: config.apiBase, returnTo: config.returnTo, timeoutMs: config.timeoutMs });
}

/**
 * 本人の資格情報（NIHO の ID token）。方式が token を出せないあいだは null（503）。
 * token は関数の中にだけ持つ（戻り値を文字列にしても出ない）。ここから先へ値を渡さない。
 */
export async function getGoogleDocsCredential(auth: AuthProvider, session: Session, request: SessionRequest): Promise<GoogleDocsCredential | null> {
  if (!auth.docsApiToken) return null;
  let token: string | null;
  try {
    token = await auth.docsApiToken(session, request);
  } catch {
    return null;
  }
  if (typeof token !== "string" || token.trim() === "") return null;
  const value = token;
  return { idToken: () => value };
}
