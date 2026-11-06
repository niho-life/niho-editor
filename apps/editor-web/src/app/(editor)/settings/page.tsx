import type { Metadata } from "next";
import { StoreUnavailable } from "@/components/Notice";
import { SettingsHubView } from "@/components/settings/SettingsHubView";
import { settingsFacts } from "@/settings/facts";
import { settingsPageData } from "@/settings/page-data";
import { frameMe } from "@/server/frame";
import { requireSession } from "@/server/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "設定" };

/**
 * 設定の一覧（#108。2026-11-05 から 3 層: 一覧 → 詳細ページ → 集中編集のシート）。
 * 変えられる物だけを行にし、詳細は /settings/about・/settings/terms・/settings/recipes/{id} に分ける。
 * 最初の値はここで読む（画面を開いたときに空から始めない）。AI とメディアの使用量は画面が各 API を読む。
 * 音声の上限と保持日数は「データ」の ⓘ に出す（エンジン名・時間切れは設定に出さない）。
 * 先頭は「アカウント」（役割とつながり・発信先）、いちばん下にログアウト（左下のメニューをやめた。オーナー決定 2026-11-06）。
 */
export default async function SettingsPage() {
  const data = await settingsPageData("/settings");
  if (!data) return <StoreUnavailable />;
  const { audio } = settingsFacts().transcription;
  // 「アカウント」の群の本人の行（左の枠の frameMe と同じ名前・1 文字）
  const { name, initial } = frameMe(await requireSession("/settings"));
  return (
    <SettingsHubView
      key={data.userId}
      initial={data.settings}
      audio={{ maxBytes: audio.maxBytes, maxDurationSec: audio.maxDurationSec, retentionDays: audio.retentionDays }}
      account={{ name, initial }}
    />
  );
}
