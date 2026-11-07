import type { Metadata } from "next";
import { headers } from "next/headers";
import { StoreUnavailable } from "@/components/Notice";
import { SettingsHubView } from "@/components/settings/SettingsHubView";
import { settingsFacts } from "@/settings/facts";
import { settingsPageData } from "@/settings/page-data";
import { frameMe } from "@/server/frame";
import { requireSession } from "@/server/session";
import { connectionsDeps } from "@/server/connections-deps";
import { destinationsFor } from "@/server/connections-api";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "設定" };

/**
 * 設定の一覧（#108。2026-11-05 から 3 層: 一覧 → 詳細ページ → 集中編集のシート）。
 * 変えられる物だけを行にし、詳細は /settings/about・/settings/terms・/settings/recipes/{id} に分ける。
 * 最初の値はここで読む（画面を開いたときに空から始めない）。AI とメディアの使用量は画面が各 API を読む。
 * 音声の上限と保持日数は「データ」の ⓘ に出す（エンジン名・時間切れは設定に出さない）。
 * 先頭の「アカウント」に本人情報を統合し、名前を取得できない NIHO session にだけ再取得の入口を出す。
 */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ identity?: string }> }) {
  const data = await settingsPageData("/settings");
  if (!data) return <StoreUnavailable />;
  const { audio } = settingsFacts().transcription;
  const [session, requestHeaders, query] = await Promise.all([requireSession("/settings"), headers(), searchParams]);
  const wiring = connectionsDeps.ports(session, { headers: requestHeaders });
  const counts = connectionsDeps.counts();
  if (!wiring || !counts) return <StoreUnavailable />;
  const destinations = await destinationsFor(wiring, session.userId, counts);
  return (
    <SettingsHubView
      key={data.userId}
      initial={data.settings}
      audio={{ maxBytes: audio.maxBytes, maxDurationSec: audio.maxDurationSec, retentionDays: audio.retentionDays }}
      account={frameMe(session)}
      refreshIdentity={session.mode === "niho" && !session.profile?.name.trim()}
      identityMismatch={query.identity === "mismatch"}
      destinations={destinations}
    />
  );
}
