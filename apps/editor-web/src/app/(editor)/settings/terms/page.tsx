import type { Metadata } from "next";
import { StoreUnavailable } from "@/components/Notice";
import { SettingsTermsView } from "@/components/settings/SettingsTermsView";
import { settingsPageData } from "@/settings/page-data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "固有名詞" };

/** 設定 › 固有名詞（アカウント共通。AI の提案と文字起こし修正に渡す表記）。 */
export default async function SettingsTermsPage() {
  const data = await settingsPageData("/settings/terms");
  if (!data) return <StoreUnavailable />;
  return <SettingsTermsView key={data.userId} initial={data.settings} />;
}
