"use client";

import { useEffect, useState } from "react";
import type { SettingsTerm } from "@niho/editor-store";
import { formatVariants, mergeExtractedTerms, parseVariants, uniqueFlowName } from "@niho/docs-core";
import { EditorSettingsPage, type EditorSettingsAbout, type EditorSettingsGuideExtraction, type EditorSettingsRecipe, type EditorSettingsTermDraft } from "niho-docs-ui/shell";
import { duplicateSettingsRecipe, extractGuide, importRecipeSample, loadAiUsage, loadGuideExtraction, loadSettings, loadStorageUsage, saveSettings, type GuideExtractionPreview, type MediaStorageUsage, type SettingsDto, type SettingsPatchInput, type SettingsRecipeInput, type UsageSummary } from "@/lib/settings-client";
import type { SettingsFacts } from "@/settings/facts";
import { SETTINGS_MESSAGES } from "@/settings/messages";
import { validateRecipeDefinition } from "@/steps/recipe-validation";

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
function effective(dto: SettingsDto): SettingsRecipeInput[] {
  return dto.recipes.map(({ id, name, guide, steps, terms, samples }) => ({
    id, name, guide,
    steps: steps.map((step) => ({ ...step })),
    terms: terms.map((term) => ({ ...term, variants: [...term.variants] })),
    samples: samples.map((sample) => ({ ...sample })),
  }));
}

function recipeDraftOf(recipe: SettingsDto["recipes"][number]): EditorSettingsRecipe {
  return {
    ...recipe,
    steps: recipe.steps.map((step) => ({ ...step })),
    terms: recipe.terms.map((term) => ({ ...term, variants: formatVariants(term.variants) })),
    samples: recipe.samples.map((sample) => ({ ...sample })),
  };
}

function withoutFlags(recipe: EditorSettingsRecipe): SettingsRecipeInput {
  return {
    id: recipe.id,
    name: recipe.name,
    guide: recipe.guide,
    steps: recipe.steps.map((step) => ({ ...step })),
    terms: recipe.terms.map((term) => ({ ...term, variants: parseVariants(term.variants) })),
    samples: recipe.samples.map((sample) => ({ ...sample })),
  };
}

export type SettingsViewProps = { initial: SettingsDto; facts: SettingsFacts };

type SampleUiState = { recipeId: string | null; file: File | null; url: string; status: string };
type ExtractionUiState = { recipeId: string; sampleSetKey: string; extraction: GuideExtractionPreview; selectedTerms: string[] };

export function SettingsView({ initial, facts }: SettingsViewProps) {
  const [settings, setSettings] = useState(initial);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [termsDraft, setTermsDraft] = useState<EditorSettingsTermDraft[] | null>(null);
  const [aboutDraft, setAboutDraft] = useState<EditorSettingsAbout | null>(null);
  const [recipeDraft, setRecipeDraft] = useState<EditorSettingsRecipe | null>(null);
  const [sampleUi, setSampleUi] = useState<SampleUiState>({ recipeId: null, file: null, url: "", status: "" });
  const [sampleBusy, setSampleBusy] = useState(false);
  const [extractionUi, setExtractionUi] = useState<ExtractionUiState | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [usageNote, setUsageNote] = useState<string | null>(null);
  const [storageUsage, setStorageUsage] = useState<MediaStorageUsage | null>(null);
  const [storageUsageNote, setStorageUsageNote] = useState<string | null>(null);
  const recipeValidation = recipeDraft ? validateRecipeDefinition(recipeDraft, settings.recipes) : null;
  const recipeId = recipeDraft?.id ?? null;
  const sampleSetKey = JSON.stringify(recipeDraft?.samples.map((sample) => sample.id) ?? []);
  const activeSampleUi = sampleUi.recipeId === recipeId ? sampleUi : { recipeId, file: null, url: "", status: "" };
  const sampleFile = activeSampleUi.file;
  const sampleUrl = activeSampleUi.url;
  const sampleStatus = activeSampleUi.status;
  const extraction = extractionUi?.recipeId === recipeId && extractionUi.sampleSetKey === sampleSetKey ? extractionUi.extraction : null;
  const selectedExtractionTerms = extractionUi?.recipeId === recipeId && extractionUi.sampleSetKey === sampleSetKey ? extractionUi.selectedTerms : [];

  const resetSampleUi = (nextRecipeId: string | null) => setSampleUi({ recipeId: nextRecipeId, file: null, url: "", status: "" });
  const updateSampleUi = (targetRecipeId: string | null, patch: Partial<Pick<SampleUiState, "file" | "url" | "status">>) => {
    setSampleUi((current) => ({
      recipeId: targetRecipeId,
      file: current.recipeId === targetRecipeId ? current.file : null,
      url: current.recipeId === targetRecipeId ? current.url : "",
      status: current.recipeId === targetRecipeId ? current.status : "",
      ...patch,
    }));
  };

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

  useEffect(() => {
    if (recipeId === null) return undefined;
    const currentSampleIds = new Set(JSON.parse(sampleSetKey) as string[]);
    let alive = true;
    void loadGuideExtraction(recipeId).then((result) => {
      if (!alive) return;
      if (result.ok && result.extraction && result.extraction.sampleIds.every((id) => currentSampleIds.has(id))) {
        setExtractionUi({
          recipeId,
          sampleSetKey,
          extraction: result.extraction,
          selectedTerms: result.extraction.candidates.map((candidate, index) => `${candidate.term}:${index}`),
        });
      }
    });
    return () => { alive = false; };
  }, [recipeId, sampleSetKey]);

  /** 渡した項目だけを送る。成功したら画面の値をサーバーの答えで置き換える。 */
  const apply = async (patch: SettingsPatchInput, after?: (saved: SettingsDto) => void): Promise<void> => {
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

  const saveRecipes = (list: SettingsRecipeInput[], after?: (saved: SettingsDto) => void) => void apply({ recipes: list }, after);
  const recipeOf = (id: string) => settings.recipes.find((recipe) => recipe.id === id);

  return (
    <EditorSettingsPage
      status={status}
      busy={busy || sampleBusy}
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
      aboutName={settings.aboutName}
      about={settings.about}
      aboutDraft={aboutDraft}
      onEditAbout={() => setAboutDraft({ name: settings.aboutName, text: settings.about })}
      onAboutDraft={setAboutDraft}
      onCancelAbout={() => setAboutDraft(null)}
      onSaveAbout={() => {
        if (aboutDraft === null) return;
        void apply({ aboutName: aboutDraft.name, about: aboutDraft.text }, () => setAboutDraft(null));
      }}
      recipes={settings.recipes.map(recipeDraftOf)}
      recipeDraft={recipeDraft}
      recipeValidation={recipeValidation}
      onEditRecipe={(id) => {
        const recipe = recipeOf(id);
        if (recipe) {
          resetSampleUi(id);
          setRecipeDraft(recipeDraftOf(recipe));
        }
      }}
      onRecipeDraft={setRecipeDraft}
      onCancelRecipe={() => {
        resetSampleUi(null);
        setRecipeDraft(null);
      }}
      onSaveRecipe={() => {
        if (!recipeDraft) return;
        const saved = withoutFlags(recipeDraft);
        saveRecipes(
          effective(settings).map((entry) => (entry.id === saved.id ? saved : entry)),
          () => {
            resetSampleUi(null);
            setRecipeDraft(null);
          },
        );
      }}
      onDuplicateRecipe={(id) => {
        if (busy || sampleBusy || !recipeOf(id)) return;
        setBusy(true);
        setStatus(SETTINGS_MESSAGES.saving);
        void duplicateSettingsRecipe(id).then((result) => {
          setBusy(false);
          if (!result.ok) { setStatus(result.message); return; }
          setSettings(result.settings);
          setStatus(SETTINGS_MESSAGES.saved);
        });
      }}
      onResetRecipe={(id) => {
        const recipe = recipeOf(id);
        if (!recipe?.defaults) return;
        // 一覧から外すのではなく、既定の定義（応答の `defaults`）で置き換えて送る
        // （PATCH は既定の 3 つが揃っていることを求める。サーバーは既定と同じ中身の写しを保存しないので、これで既定に戻る）
        const reset: SettingsRecipeInput = { id, ...recipe.defaults, steps: recipe.defaults.steps.map((step) => ({ ...step })), terms: recipe.defaults.terms.map((term) => ({ ...term, variants: [...term.variants] })), samples: recipe.defaults.samples.map((sample) => ({ ...sample })) };
        saveRecipes(
          effective(settings).map((entry) => (entry.id === id ? reset : entry)),
          () => {
            if (recipeDraft?.id === id) {
              resetSampleUi(null);
              setRecipeDraft(null);
            }
          },
        );
      }}
      onRemoveRecipe={(id) => {
        saveRecipes(
          effective(settings).filter((entry) => entry.id !== id),
          () => {
            if (recipeDraft?.id === id) {
              resetSampleUi(null);
              setRecipeDraft(null);
            }
          },
        );
      }}
      onAddRecipe={() => {
        const added: SettingsRecipeInput = { id: newId("r"), name: uniqueFlowName("新しい手順", settings.recipes), guide: "", steps: [{ id: newId("s"), name: "まとめ", instruction: "", profile: "standard" }], terms: [], samples: [] };
        saveRecipes([...effective(settings), added], (saved) => {
          const stored = saved.recipes.find((recipe) => recipe.id === added.id);
          if (stored) {
            resetSampleUi(stored.id);
            setRecipeDraft(recipeDraftOf(stored));
          }
        });
      }}
      newStepId={() => newId("s")}
      maxRecipeTerms={settings.limits.glossary}
      sampleFile={sampleFile}
      sampleUrl={sampleUrl}
      sampleBusy={sampleBusy}
      sampleStatus={sampleStatus}
      extraction={extraction as EditorSettingsGuideExtraction | null}
      selectedExtractionTerms={selectedExtractionTerms}
      onSampleFile={(file) => updateSampleUi(recipeId, { file })}
      onSampleUrl={(url) => updateSampleUi(recipeId, { url })}
      onImportSampleFile={() => {
        if (!recipeDraft || !sampleFile || sampleBusy) return;
        const recipeId = recipeDraft.id;
        setSampleBusy(true);
        updateSampleUi(recipeId, { status: "お手本文書を取り込んでいます…" });
        void importRecipeSample(recipeId, { file: sampleFile }).then(async (result) => {
          setSampleBusy(false);
          if (!result.ok) { updateSampleUi(recipeId, { status: result.message }); return; }
          setRecipeDraft((current) => current?.id === recipeId ? { ...current, samples: [...current.samples, result.sample] } : current);
          updateSampleUi(recipeId, { file: null, status: "お手本文書を追加しました。保存するとこの手順に反映されます。" });
          const refreshed = await loadSettings();
          if (refreshed.ok) setSettings(refreshed.settings);
          else setSettings((current) => ({ ...current, recipes: current.recipes.map((recipe) => recipe.id === recipeId ? { ...recipe, samples: [...recipe.samples, result.sample] } : recipe) }));
        });
      }}
      onImportSampleUrl={() => {
        if (!recipeDraft || !sampleUrl.trim() || sampleBusy) return;
        const recipeId = recipeDraft.id;
        setSampleBusy(true);
        updateSampleUi(recipeId, { status: "URLからお手本文書を取り込んでいます…" });
        void importRecipeSample(recipeId, { url: sampleUrl.trim() }).then(async (result) => {
          setSampleBusy(false);
          if (!result.ok) { updateSampleUi(recipeId, { status: result.message }); return; }
          setRecipeDraft((current) => current?.id === recipeId ? { ...current, samples: [...current.samples, result.sample] } : current);
          updateSampleUi(recipeId, { url: "", status: "お手本文書を追加しました。保存するとこの手順に反映されます。" });
          const refreshed = await loadSettings();
          if (refreshed.ok) setSettings(refreshed.settings);
          else setSettings((current) => ({ ...current, recipes: current.recipes.map((recipe) => recipe.id === recipeId ? { ...recipe, samples: [...recipe.samples, result.sample] } : recipe) }));
        });
      }}
      onExtractGuide={() => {
        if (!recipeDraft || sampleBusy) return;
        const recipeId = recipeDraft.id;
        setSampleBusy(true);
        const sampleSetAtStart = sampleSetKey;
        updateSampleUi(recipeId, { status: "文書ガイドと固有名詞候補を抽出しています…" });
        void extractGuide(recipeId).then((result) => {
          setSampleBusy(false);
          if (!result.ok) { updateSampleUi(recipeId, { status: result.message }); return; }
          setExtractionUi({
            recipeId,
            sampleSetKey: sampleSetAtStart,
            extraction: result.extraction,
            selectedTerms: result.extraction.candidates.map((candidate, index) => `${candidate.term}:${index}`),
          });
          updateSampleUi(recipeId, { status: "抽出案を保存しました。内容を確認して反映してください。" });
        });
      }}
      onToggleExtractionTerm={(key, selected) => {
        if (recipeId === null) return;
        setExtractionUi((current) => {
          if (!current || current.recipeId !== recipeId || current.sampleSetKey !== sampleSetKey) return current;
          const selectedTerms = selected
            ? [...new Set([...current.selectedTerms, key])]
            : current.selectedTerms.filter((entry) => entry !== key);
          return { ...current, selectedTerms };
        });
      }}
      onApplyExtractedGuide={() => {
        if (!recipeDraft || !extraction) return;
        setRecipeDraft({ ...recipeDraft, guide: extraction.guide });
        updateSampleUi(recipeDraft.id, { status: "文書ガイド案を下書きに反映しました。手順の保存で確定します。" });
      }}
      onApplyExtractedTerms={() => {
        if (!recipeDraft || !extraction) return;
        const selected = extraction.candidates.filter((candidate, index) => selectedExtractionTerms.includes(`${candidate.term}:${index}`));
        const existing: SettingsTerm[] = [
          ...settings.glossary.map((term) => ({ ...term, variants: [...term.variants] })),
          ...recipeDraft.terms.map((term) => ({ ...term, variants: parseVariants(term.variants) })),
        ];
        const merged = mergeExtractedTerms(existing, selected);
        const additions = merged.terms.slice(existing.length, existing.length + Math.max(0, settings.limits.glossary - recipeDraft.terms.length));
        setRecipeDraft({ ...recipeDraft, terms: [...recipeDraft.terms, ...additions.map((term) => ({ ...term, variants: formatVariants(term.variants) }))] });
        updateSampleUi(recipeDraft.id, { status: additions.length ? `固有名詞候補を${additions.length}件、下書きに追加しました。手順の保存で確定します。` : "選んだ候補は既存の固有名詞と重複しています。" });
      }}
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
