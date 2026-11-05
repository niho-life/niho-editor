import "server-only";
import { cache } from "react";
import { getEditorSettings } from "@niho/editor-store";
import { getPool } from "@/server/db";
import { ownerRecipes } from "@/server/recipe-source";
import { requireSession } from "@/server/session";
import { settingsDto, type SettingsDto } from "@/server/settings-api";

/**
 * 設定のページ（一覧・あなたについて・固有名詞・手順。オーナー決定 2026-11-05）が最初に描く値。
 * ログインを確かめ、本人の設定と効いている手順を読む。DB が無ければ null（画面は StoreUnavailable）。
 * 1 回の描画の中では 1 度だけ読む（手順のページは題名と本文の両方で使う）。
 */
export const settingsPageData = cache(async (path: string): Promise<{ userId: string; settings: SettingsDto } | null> => {
  const session = await requireSession(path);
  const pool = getPool();
  if (!pool) return null;
  const [settings, recipes] = await Promise.all([getEditorSettings(pool, session.userId), ownerRecipes(pool, session.userId)]);
  return { userId: session.userId, settings: settingsDto(settings, recipes) };
});
