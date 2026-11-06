import type { Metadata } from "next";
import { StoreUnavailable } from "@/components/Notice";
import { SettingsAuthorView } from "@/components/settings/SettingsAuthorView";
import { settingsPageData } from "@/settings/page-data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "公開用の著者紹介" };

/** 設定 › 公開用の著者紹介（公開した記事に名前と一緒に載る肩書と紹介文。公開した時点の内容が記事に残る）。 */
export default async function SettingsAuthorPage() {
  const data = await settingsPageData("/settings/author");
  if (!data) return <StoreUnavailable />;
  return <SettingsAuthorView key={data.userId} initial={data.settings} />;
}
