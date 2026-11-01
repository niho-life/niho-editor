"use client";

import { useEffect, useState } from "react";
import type { EditorSettingsPatch, SettingsRecipe, SettingsTerm } from "@niho/editor-store";
import { formatVariants, parseVariants } from "@niho/docs-core";
import { EditorSettingsPage, type EditorSettingsRecipe, type EditorSettingsTermDraft } from "niho-docs-ui/shell";
import { loadAiUsage, loadStorageUsage, saveSettings, type MediaStorageUsage, type SettingsDto, type UsageSummary } from "@/lib/settings-client";
import type { SettingsFacts } from "@/settings/facts";
import { SETTINGS_MESSAGES } from "@/settings/messages";

/**
 * 設定（`/settings`。Issue #108）。画面は docs-ui の `EditorSettingsPage`（モック v6 の V.settings）で、
 * ここは状態・下書き・`PATCH /api/settings`・使用量 API の読み出しを持つ。
 *
 * 保存は項目ごとに送り、応答の設定で画面を置き換える（サーバーが整えた値・既定に戻った手順がそのまま出る）。
 * 失敗したときは設定を変えず、一言だけ出す（`role="status"` は EditorSettingsPage が持つ）。
 */

/** 手順と段階の新しい id（owner の中で一意ならよい。形は editor-store の SETTINGS_ID_PATTERN）。 */
function newId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  return `${prefix}-${random.replace(/[^a-z0-9]/g, "").slice(0, 16)}`;
}

/** 効いている手順の並び（PATCH はこの形の全部を送る）。 */
function effective(dto: SettingsDto): SettingsRecipe[] {
  return dto.recipes.map(({ id, name, guide, steps }) => ({ id, name, guide, steps: steps.map((step) => ({ ...step })) }));
}

function withoutFlags(recipe: EditorSettingsRecipe): SettingsRecipe {
  return { id: recipe.id, name: recipe.name, guide: recipe.guide, steps: recipe.steps.map((step) => ({ ...step })) };
}

export type SettingsViewProps = { initial: SettingsDto; facts: SettingsFacts };

export function SettingsView({ initial, facts }: SettingsViewProps) {
  const [settings, setSettings] = useState(initial);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [termsDraft, setTermsDraft] = useState<EditorSettingsTermDraft[] | null>(null);
  const [aboutDraft, setAboutDraft] = useState<string | null>(null);
  const [recipeDraft, setRecipeDraft] = useState<EditorSettingsRecipe | null>(null);
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

  /** 渡した項目だけを送る。成功したら画面の値をサーバーの答えで置き換える。 */
  const apply = async (patch: EditorSettingsPatch, after?: (saved: SettingsDto) => void): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setStatus(SETTINGS_MESSAGES.saving);
    const result = await saveSettings(patch);
    setBusy(false);
    if (!result.ok) {
      setStatus(result.message);
      return;
    }
    setSettings(result.settings);
    setStatus(SETTINGS_MESSAGES.saved);
    after?.(result.settings);
  };

  const saveRecipes = (list: SettingsRecipe[], after?: (saved: SettingsDto) => void) => void apply({ recipes: list }, after);
  const recipeOf = (id: string) => settings.recipes.find((recipe) => recipe.id === id);

  return (
    <EditorSettingsPage
      status={status}
      busy={busy}
      aiLang={settings.aiLang}
      onAiLang={(aiLang) => void apply({ aiLang })}
      glossary={settings.glossary}
      termsDraft={termsDraft}
      // 誤りやすい表記は 1 つの欄に「・」で並べて打つ（打っている間は文字列のまま。配列にするのは保存のとき）
      onEditTerms={() => setTermsDraft(settings.glossary.map((entry) => ({ ...entry, variants: formatVariants(entry.variants) })))}
      onTermsDraft={setTermsDraft}
      onCancelTerms={() => setTermsDraft(null)}
      onSaveTerms={() => {
        if (!termsDraft) return;
        const glossary: SettingsTerm[] = termsDraft.map((entry) => ({ ...entry, variants: parseVariants(entry.variants) }));
        void apply({ glossary }, () => setTermsDraft(null));
      }}
      about={settings.about}
      aboutDraft={aboutDraft}
      onEditAbout={() => setAboutDraft(settings.about)}
      onAboutDraft={setAboutDraft}
      onCancelAbout={() => setAboutDraft(null)}
      onSaveAbout={() => {
        if (aboutDraft === null) return;
        void apply({ about: aboutDraft }, () => setAboutDraft(null));
      }}
      recipes={settings.recipes}
      recipeDraft={recipeDraft}
      onEditRecipe={(id) => {
        const recipe = recipeOf(id);
        if (recipe) setRecipeDraft({ ...recipe, steps: recipe.steps.map((step) => ({ ...step })) });
      }}
      onRecipeDraft={setRecipeDraft}
      onCancelRecipe={() => setRecipeDraft(null)}
      onSaveRecipe={() => {
        if (!recipeDraft) return;
        const saved = withoutFlags(recipeDraft);
        saveRecipes(
          effective(settings).map((entry) => (entry.id === saved.id ? saved : entry)),
          () => setRecipeDraft(null),
        );
      }}
      onDuplicateRecipe={(id) => {
        const recipe = recipeOf(id);
        if (!recipe) return;
        const copy: SettingsRecipe = {
          id: newId("r"),
          name: `${recipe.name}のコピー`,
          guide: recipe.guide,
          // 既定の手順の写しは、段階の id を新しくする（既定の id はその手順のものとして残す）
          steps: recipe.steps.map((step) => ({ ...step, id: recipe.isDefault ? newId("s") : step.id })),
        };
        saveRecipes([...effective(settings), copy]);
      }}
      onResetRecipe={(id) => {
        const recipe = recipeOf(id);
        if (!recipe?.defaults) return;
        // 一覧から外すのではなく、既定の定義（応答の `defaults`）で置き換えて送る
        // （PATCH は既定の 3 つが揃っていることを求める。サーバーは既定と同じ中身の写しを保存しないので、これで既定に戻る）
        const reset: SettingsRecipe = { id, ...recipe.defaults, steps: recipe.defaults.steps.map((step) => ({ ...step })) };
        saveRecipes(
          effective(settings).map((entry) => (entry.id === id ? reset : entry)),
          () => setRecipeDraft((draft) => (draft?.id === id ? null : draft)),
        );
      }}
      onRemoveRecipe={(id) => {
        saveRecipes(
          effective(settings).filter((entry) => entry.id !== id),
          () => setRecipeDraft((draft) => (draft?.id === id ? null : draft)),
        );
      }}
      onAddRecipe={() => {
        const added: SettingsRecipe = { id: newId("r"), name: "新しい手順", guide: "", steps: [{ id: newId("s"), name: "まとめ", instruction: "" }] };
        saveRecipes([...effective(settings), added], (saved) => {
          const stored = saved.recipes.find((recipe) => recipe.id === added.id);
          if (stored) setRecipeDraft({ ...stored, steps: stored.steps.map((step) => ({ ...step })) });
        });
      }}
      newStepId={() => newId("s")}
      usage={usage}
      usageNote={usageNote}
      storageUsage={storageUsage}
      storageUsageNote={storageUsageNote}
      transcription={{
        engine: facts.transcription.engine,
        timeoutSec: facts.transcription.timeoutSec,
        maxBytes: facts.transcription.audio.maxBytes,
        maxDurationSec: facts.transcription.audio.maxDurationSec,
        retentionDays: facts.transcription.audio.retentionDays,
        extensions: [...facts.transcription.audio.extensions],
      }}
      limits={settings.limits}
    />
  );
}
