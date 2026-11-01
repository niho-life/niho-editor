import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthProvider, getPhotoAuthProvider, type Session } from "../auth";
import { loginPath, photoLoginPath, safePhotoReturnTo, safeReturnTo } from "../auth/return-to";
import { EDITOR_PATH_HEADER } from "../lib/editor-path";

/** server component から今の本人を読む（要求の header だけを使う）。 */
export async function currentSession(): Promise<Session | null> {
  return getAuthProvider().getSession({ headers: await headers() });
}

/** 写真専用のNIHO本人を読む。DocsのGoogle/stub sessionへはフォールバックしない。 */
export async function currentPhotoSession(): Promise<Session | null> {
  const provider = getPhotoAuthProvider();
  return provider?.mode === "niho" ? provider.getSession({ headers: await headers() }) : null;
}

/**
 * 本人を読み、未ログインなら `/auth/login?next=…` へ redirect する。
 * path を渡さないときは src/proxy.ts が付けた今の path を戻り先にする（どちらも safeReturnTo を通す）。
 */
export async function requireSession(path?: string): Promise<Session> {
  const requestHeaders = await headers();
  const session = await getAuthProvider().getSession({ headers: requestHeaders });
  if (session) return session;
  redirect(loginPath(safeReturnTo(path ?? requestHeaders.get(EDITOR_PATH_HEADER))));
}

/** 写真のNIHO本人を読み、未ログインなら写真専用ログインへ移す。 */
export async function requirePhotoSession(path?: string): Promise<Session> {
  const requestHeaders = await headers();
  const provider = getPhotoAuthProvider();
  const session = provider?.mode === "niho" ? await provider.getSession({ headers: requestHeaders }) : null;
  if (session) return session;
  redirect(photoLoginPath(safePhotoReturnTo(path ?? requestHeaders.get(EDITOR_PATH_HEADER))));
}
