import type { Metadata } from "next";
import { StoreUnavailable } from "@/components/Notice";
import { SettingsAboutView } from "@/components/settings/SettingsAboutView";
import { settingsPageData } from "@/settings/page-data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "あなたについて" };

/** 設定 › あなたについて（AI に毎回渡す呼び名と説明。公開はされない）。 */
export default async function SettingsAboutPage() {
  const data = await settingsPageData("/settings/about");
  if (!data) return <StoreUnavailable />;
  return <SettingsAboutView key={data.userId} initial={data.settings} />;
}
