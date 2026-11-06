"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { uniqueFlowName } from "@niho/docs-core";
import { EDITOR_SETTINGS_HREF, EditorSettingsHub, type EditorSettingsAudioFacts } from "niho-docs-ui/shell";
import { logoutAndLeave } from "@/lib/logout";
import { loadAiUsage, loadStorageUsage, type MediaStorageUsage, type SettingsDto, type SettingsRecipeInput, type UsageSummary } from "@/lib/settings-client";
import { effectiveRecipes, newSettingsId, useSettingsState } from "./settings-state";

/**
 * 設定の一覧（`/settings`。オーナー決定 2026-11-05）。変えられる物だけを行にし、行から詳細のページへ進む。
 * 提案の言語と「Web を検索する」はその場で保存する。AI とメディアの使用量はここで各 API を読む（読めなければその一言を出す）。
 */
export function SettingsHubView({ initial, audio, account }: { initial: SettingsDto; audio: EditorSettingsAudioFacts; account: { name: string; initial: string } }) {
  const router = useRouter();
  const { settings, status, busy, apply } = useSettingsState(initial);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [usageNote, setUsageNote] = useState<string | null>(null);
  const [storageUsage, setStorageUsage] = useState<MediaStorageUsage | null>(null);
  const [storageUsageNote, setStorageUsageNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadAiUsage().then((result) => {
      if (!alive) return;
      if (result.ok) setUsage(result.usage);
      else setUsageNote(result.message);
    });
    void loadStorageUsage().then((result) => {
      if (!alive) return;
      if (result.ok) setStorageUsage(result.usage);
      else setStorageUsageNote(result.message);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <EditorSettingsHub
      status={status}
      busy={busy}
      aiLang={settings.aiLang}
      onAiLang={(aiLang) => void apply({ aiLang })}
      webSearch={settings.webSearch}
      onWebSearch={(webSearch) => void apply({ webSearch })}
      aboutName={settings.aboutName}
      about={settings.about}
      author={{ role: settings.authorRole, bio: settings.authorBio }}
      glossary={settings.glossary}
      recipes={settings.recipes}
      canAddRecipe={settings.recipes.length < settings.limits.recipes}
      onAddRecipe={() => {
        const added: SettingsRecipeInput = { id: newSettingsId("r"), name: uniqueFlowName("新しい手順", settings.recipes), guide: "", steps: [{ id: newSettingsId("s"), name: "まとめ", instruction: "", profile: "standard" }], terms: [], samples: [] };
        void apply({ recipes: [...effectiveRecipes(settings), added] }, (saved) => {
          if (saved.recipes.some((recipe) => recipe.id === added.id)) router.push(EDITOR_SETTINGS_HREF.recipe(added.id));
        });
      }}
      usage={usage}
      usageNote={usageNote}
      storageUsage={storageUsage}
      storageUsageNote={storageUsageNote}
      audio={audio}
      account={account}
      onLogout={logoutAndLeave}
      onNavigate={(href) => router.push(href)}
    />
  );
}
