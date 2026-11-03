import type { Metadata } from "next";
import { headers } from "next/headers";
import { safeReturnTo } from "@/auth/return-to";
import { GoogleDocsConnectView } from "@/components/GoogleDocsConnectView";
import type { GoogleDocsConnection } from "@/google-docs/gateway";
import { GoogleDocsError } from "@/google-docs/gateway";
import { getGoogleDocsCredential, getGoogleDocsGateway } from "@/google-docs/runtime";
import { GOOGLE_DOCS_CONNECT_PATH } from "@/lib/google-docs-paths";
import { getAuthProvider } from "@/auth";
import { requireSession } from "@/server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Google ドキュメントへの書き出し" };

type SearchParams = { next?: string | string[]; error?: string | string[] };

/**
 * Google ドキュメントへ書き出す前の案内（未接続・つなぎ直しのときに「…」から案内される）。
 * 接続の状態は NIHO の API から毎回読む（editor は保存しない）。読めないときは理由を code だけ出す。
 */
export default async function GoogleDocsConnectPage(props: { searchParams: Promise<SearchParams> }) {
  const { next, error } = await props.searchParams;
  const session = await requireSession(GOOGLE_DOCS_CONNECT_PATH);
  const returnTo = safeReturnTo(typeof next === "string" ? next : null);
  const gateway = getGoogleDocsGateway();
  const credential = gateway ? await getGoogleDocsCredential(getAuthProvider(), session, { headers: await headers() }) : null;
  let connection: GoogleDocsConnection | null = null;
  let failure = typeof error === "string" ? error : null;
  if (gateway && credential) {
    try {
      connection = await gateway.connection(credential);
    } catch (thrown) {
      failure ??= thrown instanceof GoogleDocsError ? thrown.code : "google_docs_failed";
    }
  } else {
    failure ??= "google_docs_unavailable";
  }
  return <GoogleDocsConnectView connection={connection} error={failure} returnTo={returnTo} />;
}
