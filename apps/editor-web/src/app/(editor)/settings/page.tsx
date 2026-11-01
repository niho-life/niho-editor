import type { Metadata } from "next";
import { getEditorSettings } from "@niho/editor-store";
import { StoreUnavailable } from "@/components/Notice";
import { SettingsView } from "@/components/SettingsView";
import { getPool } from "@/server/db";
import { ownerRecipes } from "@/server/recipe-source";
import { requireSession } from "@/server/session";
import { settingsDto } from "@/server/settings-api";
import { settingsFacts } from "@/settings/facts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "設定" };

/**
 * 設定（#108）。AI の提案の言語・固有名詞・手順は変えられ（`PATCH /api/settings`）、
 * 文字起こしのエンジンはサーバー側の設定を読む。保存先はNIHOクラウド固定。
 * 最初の値はここで読む（画面を開いたときに空から始めない）。AI とメディアの使用量は画面が各 API を読む。
 */
export default async function SettingsPage() {
  const session = await requireSession("/settings");
  const pool = getPool();
  if (!pool) return <StoreUnavailable />;
  const [settings, recipes, facts] = await Promise.all([
    getEditorSettings(pool, session.userId),
    ownerRecipes(pool, session.userId),
    settingsFacts(),
  ]);
  return <SettingsView key={session.userId} initial={settingsDto(settings, recipes)} facts={facts} />;
}
