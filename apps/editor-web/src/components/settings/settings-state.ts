import { useRef, useState } from "react";
import type { SettingsTerm } from "@niho/editor-store";
import { formatVariants, parseVariants } from "@niho/docs-core";
import type { EditorTermEditing, EditorTermRowsProps } from "niho-docs-ui/shell";
import { saveSettings, type SettingsDto, type SettingsPatchInput, type SettingsRecipeInput } from "@/lib/settings-client";
import { SETTINGS_MESSAGES } from "@/settings/messages";

/**
 * 設定のページ（一覧・あなたについて・固有名詞・手順。オーナー決定 2026-11-05）が共有する状態と、送る形を作る純粋な関数。
 *
 * 保存は項目ごとに送り、応答の設定で画面を置き換える（サーバーが整えた値・既定に戻った手順がそのまま出る）。
 * 失敗したときは設定を変えず、`SETTINGS_MESSAGES` の一言だけ出す。送っているあいだは次を受け付けない。
 */

export type SettingsRecipeDto = SettingsDto["recipes"][number];

/** 手順と段階の新しい id（owner の中で一意ならよい。形は editor-store の SETTINGS_ID_PATTERN）。 */
export function newSettingsId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  return `${prefix}-${random.replace(/[^a-z0-9]/g, "").slice(0, 16)}`;
}

/** PATCH に載せる 1 つの手順（画面用の印 isDefault・modified・defaults は外す）。 */
export function recipeInput(recipe: Pick<SettingsRecipeDto, "id" | "name" | "guide" | "steps" | "terms" | "samples">): SettingsRecipeInput {
  return {
    id: recipe.id,
    name: recipe.name,
    guide: recipe.guide,
    steps: recipe.steps.map((step) => ({ ...step })),
    terms: recipe.terms.map((term) => ({ ...term, variants: [...term.variants] })),
    samples: recipe.samples.map((sample) => ({ ...sample })),
  };
}

/** 効いている手順の並び（PATCH はこの形の全部を送る。既定の手順がすべて揃っていることを求められる）。 */
export function effectiveRecipes(dto: SettingsDto): SettingsRecipeInput[] {
  return dto.recipes.map(recipeInput);
}

/** 1 つの手順を置き換えた並び（並びの位置はそのまま）。 */
export function withRecipe(dto: SettingsDto, next: SettingsRecipeInput): SettingsRecipeInput[] {
  return effectiveRecipes(dto).map((entry) => (entry.id === next.id ? next : entry));
}

/**
 * 既定に戻す: 一覧から外すのではなく、既定の定義（応答の `defaults`）で置き換えて送る
 * （PATCH は既定の手順が揃っていることを求める。サーバーは既定と同じ中身の写しを保存しないので、これで既定に戻る）。
 */
export function resetRecipeInput(recipe: SettingsRecipeDto): SettingsRecipeInput | null {
  if (!recipe.defaults) return null;
  return { id: recipe.id, ...recipe.defaults, steps: recipe.defaults.steps.map((step) => ({ ...step })), terms: recipe.defaults.terms.map((term) => ({ ...term, variants: [...term.variants] })), samples: recipe.defaults.samples.map((sample) => ({ ...sample })) };
}

export function useSettingsState(initial: SettingsDto) {
  const [settings, setSettings] = useState(initial);
  const [status, setStatus] = useState("");
  const [busy, setBusyState] = useState(false);
  // 押した直後のもう一押しも断る（state の busy は次の描画まで古い）
  const busyRef = useRef(false);
  const setBusy = (value: boolean) => {
    busyRef.current = value;
    setBusyState(value);
  };

  /** 送り始める（送っている最中なら false）。 */
  const begin = (text: string): boolean => {
    if (busyRef.current) return false;
    setBusy(true);
    setStatus(text);
    return true;
  };
  const end = () => setBusy(false);

  /** 渡した項目だけを送る。成功したら画面の値をサーバーの答えで置き換え、after を呼ぶ。 */
  const apply = async (patch: SettingsPatchInput, after?: (saved: SettingsDto) => void): Promise<boolean> => {
    if (!begin(SETTINGS_MESSAGES.saving)) return false;
    const result = await saveSettings(patch);
    end();
    if (!result.ok) {
      setStatus(result.message);
      return false;
    }
    setSettings(result.settings);
    setStatus(SETTINGS_MESSAGES.saved);
    after?.(result.settings);
    return true;
  };

  return { settings, setSettings, status, setStatus, busy, begin, end, apply };
}

/**
 * 固有名詞の表（1 行ずつ直す）。誤りやすい表記は「・」で繋いだ文字列で開き（formatVariants）、打っている間は文字列のまま、
 * 配列に分けるのは保存のとき（parseVariants）。保存は表の全部を `save` に渡す。
 */
export function useTermRows(terms: readonly SettingsTerm[], max: number, busy: boolean, save: (next: SettingsTerm[]) => Promise<boolean>): Omit<EditorTermRowsProps, "label" | "addRow"> {
  const [editing, setEditing] = useState<EditorTermEditing | null>(null);
  // 開いた行の通し番号。保存が返ったとき、送った行がまだ開いているときだけ閉じる（その間に開き直した別の行の入力を消さない）
  const opened = useRef(0);
  const open = (next: EditorTermEditing | null) => {
    opened.current += 1;
    setEditing(next);
  };
  const commit = (next: SettingsTerm[]) => {
    const sent = opened.current;
    void save(next).then((ok) => {
      if (ok && opened.current === sent) open(null);
    });
  };
  return {
    terms: terms.map((term) => ({ ...term, variants: [...term.variants] })),
    max,
    busy,
    editing,
    // 送っている間は別の行を開かない（削除が返ると行の位置がずれ、開いた行が別の固有名詞を指す）
    onOpen: (index) => {
      const entry = terms[index];
      if (!busy && entry) open({ index, draft: { ...entry, variants: formatVariants(entry.variants) } });
    },
    onAdd: () => {
      if (!busy && terms.length < max) open({ index: null, draft: { term: "", reading: "", variants: "", note: "" } });
    },
    onDraft: (draft) => setEditing((current) => (current ? { ...current, draft } : current)),
    onCancel: () => open(null),
    onSave: () => {
      if (!editing || editing.draft.term.trim() === "") return;
      const entry: SettingsTerm = { ...editing.draft, variants: parseVariants(editing.draft.variants) };
      const index = editing.index;
      commit(index === null ? [...terms, entry] : terms.map((item, i) => (i === index ? entry : item)));
    },
    onRemove: () => {
      const index = editing?.index;
      if (index === null || index === undefined) return;
      commit(terms.filter((_, i) => i !== index));
    },
  };
}
