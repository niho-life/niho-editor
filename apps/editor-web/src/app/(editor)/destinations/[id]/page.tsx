import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { StoreUnavailable } from "@/components/Notice";
import { SiteView } from "@/components/SiteView";
import { connectionsDeps } from "@/server/connections-deps";
import { siteDetailFor } from "@/server/connections-api";
import { requireSession } from "@/server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "自分のサイト" };

/**
 * 自分のサイト（#41）。別の人の接続・存在しない id・不正な id・解除した接続はどれも同じ 404。
 * 鍵は伏せ字だけを渡す（平文は再発行の応答にだけ入る）。
 */
export default async function SitePage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await requireSession(`/destinations/${id}`);
  const wiring = connectionsDeps.ports(session, { headers: await headers() });
  if (!wiring) return <StoreUnavailable />;
  const detail = await siteDetailFor(wiring, session.userId, id);
  if (!detail || detail.site.removedAt !== null) notFound();
  return <SiteView id={id} initial={detail} />;
}
