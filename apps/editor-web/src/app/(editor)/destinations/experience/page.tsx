import type { Metadata } from "next";
import { headers } from "next/headers";
import { getAuthProvider } from "@/auth";
import { NihoExperienceApiClient } from "@/auth/niho-experience-api";
import { AccountConnections, type AccountConnectionsState } from "@/components/AccountConnections";
import { requireSession } from "@/server/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "NIHO Experience" };

/** Experience の現在の接続と記事連携。未招待・未承諾・role なしは正常な未接続。 */
export default async function ExperienceDestinationPage() {
  const session = await requireSession("/destinations/experience");
  const request = { headers: await headers() };
  let initial: AccountConnectionsState = { status: "error" };
  try {
    const client = new NihoExperienceApiClient(getAuthProvider());
    initial = { status: "ready", ...await client.connectionState(session, request) };
  } catch { /* Upstream failure stays distinct from a normal disconnected account. */ }
  return <AccountConnections initial={initial} />;
}
