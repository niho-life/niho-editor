import type { Metadata } from "next";
import { AccountView } from "@/components/AccountView";
import { requireSession } from "@/server/session";
import { frameMe } from "@/server/frame";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "アカウント" };

/** session から読んだ本人情報。表示名を認可には使わない。 */
export default async function AccountPage({ searchParams }: { searchParams: Promise<{ identity?: string }> }) {
  const session = await requireSession("/account");
  const query = await searchParams;
  return <AccountView account={frameMe(session)} refreshIdentity={session.mode === "niho"} identityMismatch={query.identity === "mismatch"} />;
}
