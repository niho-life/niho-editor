"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SettingsTerm } from "@niho/editor-store";
import { mergeExtractedTerms } from "@niho/docs-core";
import { EDITOR_SETTINGS_HREF, EditorSettingsRecipePage, type EditorRecipeSheet, type EditorSettingsStep } from "niho-docs-ui/shell";
import { duplicateSettingsRecipe, extractGuide, importRecipeSample, loadGuideExtraction, loadSettings, type GuideExtractionPreview, type SettingsDto, type SettingsRecipeInput } from "@/lib/settings-client";
import { SETTINGS_MESSAGES } from "@/settings/messages";
import { validateRecipeDefinition } from "@/steps/recipe-validation";
import { effectiveRecipes, newSettingsId, recipeInput, resetRecipeInput, useSettingsState, useTermRows, withRecipe } from "./settings-state";

/** お手本の上限（editor-store の RECIPE_SAMPLE_MAX_COUNT と同じ。超えるとサーバーが sample_limit で断る）。 */
const MAX_SAMPLES = 5;

type ExtractionUi = { sampleSetKey: string; extraction: GuideExtractionPreview; selectedTerms: string[] };

const allCandidates = (extraction: GuideExtractionPreview) => extraction.candidates.map((candidate, index) => `${candidate.term}:${index}`);

/**
 * 手順の詳細（`/settings/recipes/{id}`。オーナー決定 2026-11-05）。押した操作ごとにすぐ保存する
 * （名前・段階の並べ替え／複製／削除・段階のシート・文書ガイドのシート・お手本を外す・固有名詞の 1 行）。
 * 送るのは効いている手順の全部で、この手順だけを置き換える（既定の手順の段階 id はそのまま）。
 * お手本の取り込みはサーバーが手順に足す（`POST …/samples`）ので、ここは読み直すだけ。抽出の案は押すまで反映しない。
 */
export function SettingsRecipeView({ initial, recipeId }: { initial: SettingsDto; recipeId: string }) {
  const router = useRouter();
  const { settings, setSettings, status, setStatus, busy, begin, end, apply } = useSettingsState(initial);
  const recipe = settings.recipes.find((entry) => entry.id === recipeId) ?? null;
  const [nameDraft, setNameDraft] = useState(recipe?.name ?? "");
  const [sheet, setSheet] = useState<EditorRecipeSheet | null>(null);
  const [extractionUi, setExtractionUi] = useState<ExtractionUi | null>(null);
  const sampleSetKey = JSON.stringify(recipe?.samples.map((sample) => sample.id) ?? []);
  const extraction = extractionUi?.sampleSetKey === sampleSetKey ? extractionUi.extraction : null;
  const selectedTerms = extractionUi?.sampleSetKey === sampleSetKey ? extractionUi.selectedTerms : [];

  const saveRecipe = (next: SettingsRecipeInput, after?: (saved: SettingsDto) => void) => apply({ recipes: withRecipe(settings, next) }, after);
  const terms = useTermRows(recipe?.terms ?? [], settings.limits.glossary, busy, (next) => (recipe ? saveRecipe({ ...recipeInput(recipe), terms: next }) : Promise.resolve(false)));

  // 保存済みの抽出案は、今のお手本の組で作ったものだけを出す
  useEffect(() => {
    const currentSampleIds = new Set(JSON.parse(sampleSetKey) as string[]);
    let alive = true;
    void loadGuideExtraction(recipeId).then((result) => {
      if (!alive) return;
      if (result.ok && result.extraction && result.extraction.sampleIds.every((id) => currentSampleIds.has(id))) {
        setExtractionUi({ sampleSetKey, extraction: result.extraction, selectedTerms: allCandidates(result.extraction) });
      }
    });
    return () => {
      alive = false;
    };
  }, [recipeId, sampleSetKey]);

  if (!recipe) {
    return (
      <div className="es-page es-page--set">
        <h1>手順</h1>
        <p role="status" className="es-set-status">
          {status || "この手順は見つかりません"}
        </p>
      </div>
    );
  }

  const input = recipeInput(recipe);
  const nameKey = nameDraft.normalize("NFKC").trim();
  const nameError = nameKey === "" ? "手順の名前を入れてください。" : validateRecipeDefinition({ ...recipe, name: nameDraft }, settings.recipes).recipeName;

  const stepCandidate = (current: Extract<EditorRecipeSheet, { kind: "step" }>): EditorSettingsStep[] =>
    current.index === null ? [...recipe.steps, current.draft] : recipe.steps.map((step, index) => (index === current.index ? current.draft : step));
  const stepErrors = (() => {
    if (sheet?.kind !== "step") return null;
    const issues = validateRecipeDefinition({ ...recipe, steps: stepCandidate(sheet) }, settings.recipes);
    const name = sheet.draft.name.trim() === "" ? "段階の名前を入れてください。" : issues.stepNames[sheet.draft.id];
    const instruction = issues.instructions[sheet.draft.id];
    return name || instruction ? { ...(name ? { name } : {}), ...(instruction ? { instruction } : {}) } : null;
  })();

  const importSample = async (current: Extract<EditorRecipeSheet, { kind: "import" }>) => {
    const url = current.url.trim();
    const source = current.file ? { file: current.file } : url ? { url } : null;
    if (!source || !begin(current.file ? "お手本文書を取り込んでいます…" : "URLからお手本文書を取り込んでいます…")) return;
    const result = await importRecipeSample(recipe.id, source);
    if (!result.ok) {
      end();
      setStatus(result.message);
      return;
    }
    // サーバーが手順に足している。読み直せなければ、答えのお手本を手元の手順に足しておく
    const refreshed = await loadSettings();
    end();
    if (refreshed.ok) setSettings(refreshed.settings);
    else setSettings((now) => ({ ...now, recipes: now.recipes.map((entry) => (entry.id === recipe.id ? { ...entry, samples: [...entry.samples, result.sample] } : entry)) }));
    setStatus("お手本文書を追加しました");
    setSheet(null);
  };

  const extract = async () => {
    const keyAtStart = sampleSetKey;
    if (!begin("文書ガイドと固有名詞候補を抽出しています…")) return;
    const result = await extractGuide(recipe.id);
    end();
    if (!result.ok) {
      setStatus(result.message);
      return;
    }
    setExtractionUi({ sampleSetKey: keyAtStart, extraction: result.extraction, selectedTerms: allCandidates(result.extraction) });
    setStatus("抽出案を保存しました。内容を確かめて反映してください");
    setSheet({ kind: "extract" });
  };

  const duplicate = async () => {
    if (!begin(SETTINGS_MESSAGES.saving)) return;
    const before = new Set(settings.recipes.map((entry) => entry.id));
    const result = await duplicateSettingsRecipe(recipe.id);
    end();
    if (!result.ok) {
      setStatus(result.message);
      return;
    }
    setSettings(result.settings);
    setStatus(SETTINGS_MESSAGES.saved);
    const copy = result.settings.recipes.find((entry) => !before.has(entry.id));
    if (copy) router.push(EDITOR_SETTINGS_HREF.recipe(copy.id));
  };

  return (
    <EditorSettingsRecipePage
      status={status}
      busy={busy}
      recipe={recipe}
      canDuplicate={settings.recipes.length < settings.limits.recipes}
      maxSteps={settings.limits.steps}
      maxSamples={MAX_SAMPLES}
      nameDraft={nameDraft}
      nameError={nameDraft === recipe.name ? null : nameError}
      onNameDraft={setNameDraft}
      onCommitName={() => {
        if (nameDraft === recipe.name || nameError) return;
        void saveRecipe({ ...input, name: nameDraft }, (saved) => setNameDraft(saved.recipes.find((entry) => entry.id === recipe.id)?.name ?? nameDraft));
      }}
      onDuplicate={() => void duplicate()}
      onReset={() => {
        const reset = resetRecipeInput(recipe);
        if (!reset) return;
        void saveRecipe(reset, (saved) => setNameDraft(saved.recipes.find((entry) => entry.id === recipe.id)?.name ?? reset.name));
      }}
      onRemove={() => {
        if (recipe.isDefault) return;
        void apply({ recipes: effectiveRecipes(settings).filter((entry) => entry.id !== recipe.id) }, () => router.push(EDITOR_SETTINGS_HREF.hub));
      }}
      onSteps={(steps) => void saveRecipe({ ...input, steps: steps.map((step) => ({ ...step })) })}
      newStepId={() => newSettingsId("s")}
      sheet={sheet}
      onSheet={setSheet}
      stepErrors={stepErrors}
      onSaveStep={() => {
        if (sheet?.kind !== "step" || stepErrors) return;
        void saveRecipe({ ...input, steps: stepCandidate(sheet) }, () => setSheet(null));
      }}
      onSaveGuide={() => {
        if (sheet?.kind !== "guide") return;
        void saveRecipe({ ...input, guide: sheet.draft }, () => setSheet(null));
      }}
      onImport={() => {
        if (sheet?.kind === "import") void importSample(sheet);
      }}
      onExtract={() => void extract()}
      extraction={extraction}
      selectedExtractionTerms={selectedTerms}
      onToggleExtractionTerm={(key, selected) =>
        setExtractionUi((current) => {
          if (!current || current.sampleSetKey !== sampleSetKey) return current;
          return { ...current, selectedTerms: selected ? [...new Set([...current.selectedTerms, key])] : current.selectedTerms.filter((entry) => entry !== key) };
        })
      }
      onApplyExtractedGuide={() => {
        if (!extraction) return;
        void saveRecipe({ ...input, guide: extraction.guide }, () => setSheet(null));
      }}
      onApplyExtractedTerms={() => {
        if (!extraction) return;
        const chosen = extraction.candidates.filter((candidate, index) => selectedTerms.includes(`${candidate.term}:${index}`));
        const existing: SettingsTerm[] = [...settings.glossary, ...recipe.terms].map((term) => ({ ...term, variants: [...term.variants] }));
        const merged = mergeExtractedTerms(existing, chosen);
        const additions = merged.terms.slice(existing.length, existing.length + Math.max(0, settings.limits.glossary - recipe.terms.length));
        if (additions.length === 0) {
          setStatus("選んだ候補は既存の固有名詞と重複しています");
          return;
        }
        void saveRecipe({ ...input, terms: [...input.terms!, ...additions] }, () => setStatus(`固有名詞候補を${additions.length}件、この手順に追加しました`));
      }}
      onRemoveSample={(id) => void saveRecipe({ ...input, samples: input.samples!.filter((sample) => sample.id !== id) })}
      terms={terms}
      onNavigate={(href) => router.push(href)}
    />
  );
}
