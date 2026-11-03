import type { Metadata } from "next";
import { AccountConnections } from "@/components/AccountConnections";
import { requireSession } from "@/server/session";
import { headers } from "next/headers";
import { getAuthProvider } from "@/auth";
import { NihoExperienceApiClient } from "@/auth/niho-experience-api";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "役割とつながり" };

/** 役割とつながり（題名だけ。中身は #42）。 */
export default async function AccountPage() {
  const session = await requireSession("/account");
  const request = { headers: await headers() };
  let initial = null;
  try {
    const client = new NihoExperienceApiClient(getAuthProvider());
    const [roles, links] = await Promise.all([client.roles(session, request), client.links(session, request)]);
    initial = { roles, links };
  } catch { /* The recovery UI is intentional; upstream failures never become permission. */ }
  return <AccountConnections initial={initial} />;
}
