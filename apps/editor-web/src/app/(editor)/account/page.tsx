import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** 旧ブックマークと配備前に始めた名前の再取得は、本人情報を統合した設定へ戻す。 */
export default async function AccountPage({ searchParams }: { searchParams: Promise<{ identity?: string }> }) {
  const query = await searchParams;
  redirect(query.identity === "mismatch" ? "/settings?identity=mismatch" : "/settings");
}
