import type { OwnerId, Queryable } from "./types.ts";

/**
 * アカウントの設定（表 editor_settings。migration 0013。Issue #108）。owner ごとに 1 行で、行が無ければ既定値。
 *
 * - 持つのは画面から変えられるものだけ: AI の提案の言語、固有名詞と誤りやすい表記、手順（段階の名前・指示・お手本）、
 *   AI チャットの Web 検索の可否（`web_search`。#283）、「あなたについて」（旧アプリの about.json。AI に渡す本人の説明と書き方の希望。**公開のときの著者情報とは別物**）。
 * - 文字起こしのエンジンはサーバーの設定（`EDITOR_TRANSCRIBE_ENGINE`）、保存先は NIHO から毎回読む（設計 §2.1）ので、
 *   どちらもここには無い。
 * - 書き込みは項目ごとに全部入れ替える（部分的な継ぎ足しをしない）。同時の保存は後から来たものが勝つ。
 * - 検証はここの純粋な関数（`settingsProblem`）が 1 か所で決め、API はそれで 400 を返す。保存は assert で守る。
 */

export const SETTINGS_AI_LANGS = ["same", "ja", "en"] as const;
export type SettingsAiLang = (typeof SETTINGS_AI_LANGS)[number];

/** 固有名詞の 1 行（表記・よみ・誤りやすい表記・補足）。docs-core の `GlossaryEntry` と同じ形。 */
export type SettingsTerm = {
  term: string;
  reading: string;
  variants: string[];
  note: string;
};

/** 手順の 1 つの段階。`id` は成果物のサブページに結ぶ固定の文字列。 */
export type SettingsStep = {
  id: string;
  name: string;
  instruction: string;
};

/** 手順（既定の手順に手を入れた写しと、足したもの）。`guide` はお手本（全段階の入力に入る文書ガイド）。 */
export type SettingsRecipe = {
  id: string;
  name: string;
  guide: string;
  steps: SettingsStep[];
};

export type EditorSettings = {
  aiLang: SettingsAiLang;
  glossary: SettingsTerm[];
  recipes: SettingsRecipe[];
  /** AI に渡す呼び名（1 行。公開プロフィールとは別）。 */
  aboutName: string;
  /** 「あなたについて」（AI に渡す本人の説明と書き方の希望。空なら渡さない）。 */
  about: string;
  /** AI チャットが Web を検索してよいか（設定 › AI の「Web を検索する」。既定 ON。#283）。 */
  webSearch: boolean;
};

/** 変える項目だけを渡す（渡した項目は全部入れ替える）。 */
export type EditorSettingsPatch = Partial<EditorSettings>;

/** 画面と API が守る上限（表の CHECK は件数だけを見る）。 */
export const SETTINGS_LIMITS = Object.freeze({
  glossary: 200,
  termChars: 100,
  variants: 20,
  noteChars: 200,
  recipes: 20,
  recipeNameChars: 80,
  guideChars: 20_000,
  steps: 12,
  stepNameChars: 80,
  instructionChars: 8_000,
  /** 「あなたについて」の上限（旧アプリと同じ 2,000 字）。 */
  aboutChars: 2_000,
  /** 呼び名は短い1行にする。 */
  aboutNameChars: 80,
});

/** 手順と段階の id（既定の手順の `tpl-1`、足したものの `r-…` のどちらも通る形）。 */
export const SETTINGS_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = Object.freeze({
  aiLang: "same",
  glossary: [],
  recipes: [],
  aboutName: "",
  about: "",
  webSearch: true,
}) as EditorSettings;

/** 検証が断る理由（API はこれをそのまま 400 の理由にしない。短い code だけを返す）。 */
export type SettingsProblem = "ai_lang" | "glossary" | "recipes" | "about" | "about_name" | "web_search";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** 制御文字（改行とタブを除く）を持たない文字列。長さは書記素ではなく code point で数える。手順の表（recipes.ts）も使う。 */
export function isSettingsText(value: unknown, maxChars: number, multiline = false): value is string {
  if (typeof value !== "string") return false;
  if (Array.from(value).length > maxChars) return false;
  return multiline ? !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) : !/[\u0000-\u001f\u007f]/.test(value);
}

export function isSettingsAiLang(value: unknown): value is SettingsAiLang {
  return typeof value === "string" && (SETTINGS_AI_LANGS as readonly string[]).includes(value);
}

export function isSettingsTerm(value: unknown): value is SettingsTerm {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["term", "reading", "variants", "note"])) return false;
  const { termChars, variants, noteChars } = SETTINGS_LIMITS;
  // 表記だけは空にできない（空の行は AI の表に出しても意味が無い）
  if (!isSettingsText(value.term, termChars) || value.term.trim() === "") return false;
  if (!isSettingsText(value.reading, termChars)) return false;
  if (!isSettingsText(value.note, noteChars)) return false;
  if (!Array.isArray(value.variants) || value.variants.length > variants) return false;
  // 空の誤りやすい表記は断らずに落とす（1 つの欄に「・」で並べて書くので、空が混ざる）
  return value.variants.every((variant) => isSettingsText(variant, termChars));
}

export function isSettingsStep(value: unknown): value is SettingsStep {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "name", "instruction"])) return false;
  if (typeof value.id !== "string" || !SETTINGS_ID_PATTERN.test(value.id)) return false;
  if (!isSettingsText(value.name, SETTINGS_LIMITS.stepNameChars) || value.name.trim() === "") return false;
  return isSettingsText(value.instruction, SETTINGS_LIMITS.instructionChars, true);
}

export function isSettingsRecipe(value: unknown): value is SettingsRecipe {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "name", "guide", "steps"])) return false;
  if (typeof value.id !== "string" || !SETTINGS_ID_PATTERN.test(value.id)) return false;
  if (!isSettingsText(value.name, SETTINGS_LIMITS.recipeNameChars) || value.name.trim() === "") return false;
  if (!isSettingsText(value.guide, SETTINGS_LIMITS.guideChars, true)) return false;
  // 段階が 1 つも無い手順は実行できない
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > SETTINGS_LIMITS.steps) return false;
  if (!value.steps.every(isSettingsStep)) return false;
  const ids = value.steps.map((step) => step.id);
  return new Set(ids).size === ids.length;
}

/** 設定の変更に通らないところがあれば、その項目を返す（無ければ null）。 */
export function settingsProblem(patch: unknown): SettingsProblem | null {
  if (!isPlainObject(patch) || !hasOnlyKeys(patch, ["aiLang", "glossary", "recipes", "about", "aboutName", "webSearch"])) return "ai_lang";
  if (patch.aiLang !== undefined && !isSettingsAiLang(patch.aiLang)) return "ai_lang";
  if (patch.glossary !== undefined) {
    const { glossary } = patch;
    if (!Array.isArray(glossary) || glossary.length > SETTINGS_LIMITS.glossary || !glossary.every(isSettingsTerm)) return "glossary";
    const terms = glossary.map((entry) => entry.term.trim());
    if (new Set(terms).size !== terms.length) return "glossary";
  }
  if (patch.recipes !== undefined) {
    const { recipes } = patch;
    if (!Array.isArray(recipes) || recipes.length > SETTINGS_LIMITS.recipes || !recipes.every(isSettingsRecipe)) return "recipes";
    const ids = recipes.map((recipe) => recipe.id);
    if (new Set(ids).size !== ids.length) return "recipes";
  }
  if (patch.about !== undefined && !isSettingsText(patch.about, SETTINGS_LIMITS.aboutChars, true)) return "about";
  if (patch.aboutName !== undefined && !isSettingsText(patch.aboutName, SETTINGS_LIMITS.aboutNameChars, true)) return "about_name";
  if (patch.webSearch !== undefined && typeof patch.webSearch !== "boolean") return "web_search";
  return null;
}

/** 前後の空白を落として整える（保存の直前に 1 回だけ通す）。 */
export function cleanSettingsPatch(patch: EditorSettingsPatch): EditorSettingsPatch {
  const cleaned: EditorSettingsPatch = {};
  if (patch.aiLang !== undefined) cleaned.aiLang = patch.aiLang;
  if (patch.glossary !== undefined) {
    cleaned.glossary = patch.glossary.map((entry) => ({
      term: entry.term.trim(),
      reading: entry.reading.trim(),
      variants: entry.variants.map((variant) => variant.trim()).filter((variant) => variant !== ""),
      note: entry.note.trim(),
    }));
  }
  if (patch.about !== undefined) cleaned.about = patch.about.trim();
  if (patch.aboutName !== undefined) cleaned.aboutName = patch.aboutName.replace(/\s+/gu, " ").trim();
  if (patch.webSearch !== undefined) cleaned.webSearch = patch.webSearch;
  if (patch.recipes !== undefined) {
    cleaned.recipes = patch.recipes.map((recipe) => ({
      id: recipe.id,
      name: recipe.name.trim(),
      guide: recipe.guide.trim(),
      steps: recipe.steps.map((step) => ({ id: step.id, name: step.name.trim(), instruction: step.instruction.trim() })),
    }));
  }
  return cleaned;
}

function assertOwner(owner: OwnerId): void {
  // store.ts と同じ守り（空の owner で誰のものでもない行を読み書きしない）
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

type SettingsRow = { ai_lang: string; glossary: unknown; recipes: unknown; about_name: string | null; about: string | null; web_search: boolean | null };

/** 保存した値が今の形に合わなければ既定値として読む（古い行・手で直した行で画面を壊さない）。 */
function toSettings(row: SettingsRow | undefined): EditorSettings {
  if (!row) return { ...DEFAULT_EDITOR_SETTINGS };
  const glossary = Array.isArray(row.glossary) ? row.glossary.filter(isSettingsTerm) : [];
  const recipes = Array.isArray(row.recipes) ? row.recipes.filter(isSettingsRecipe) : [];
  return {
    aiLang: isSettingsAiLang(row.ai_lang) ? row.ai_lang : DEFAULT_EDITOR_SETTINGS.aiLang,
    glossary,
    recipes,
    aboutName: typeof row.about_name === "string" ? row.about_name : "",
    about: typeof row.about === "string" ? row.about : "",
    webSearch: typeof row.web_search === "boolean" ? row.web_search : DEFAULT_EDITOR_SETTINGS.webSearch,
  };
}

const COLUMNS = "ai_lang, glossary, recipes, about_name, about, web_search";

/** その人の設定（行が無ければ既定値）。 */
export async function getEditorSettings(db: Queryable, owner: OwnerId): Promise<EditorSettings> {
  assertOwner(owner);
  const result = await db.query<SettingsRow>(`SELECT ${COLUMNS} FROM editor_settings WHERE owner = $1`, [owner]);
  return toSettings(result.rows[0]);
}

/**
 * 渡した項目だけを入れ替え、入れ替えた後の設定を返す。1 つの `INSERT … ON CONFLICT DO UPDATE` で書く
 * （行が無い人の最初の保存と、2 回目以降を同じ 1 文で扱う）。
 */
export async function saveEditorSettings(db: Queryable, owner: OwnerId, patch: EditorSettingsPatch): Promise<EditorSettings> {
  assertOwner(owner);
  const problem = settingsProblem(patch);
  if (problem) throw new TypeError(`editor-store: settings.${problem} is not storable`);
  const value = cleanSettingsPatch(patch);
  const aiLang = value.aiLang ?? null;
  const glossary = value.glossary === undefined ? null : JSON.stringify(value.glossary);
  const recipes = value.recipes === undefined ? null : JSON.stringify(value.recipes);
  const aboutName = value.aboutName ?? null;
  const about = value.about ?? null;
  const webSearch = value.webSearch ?? null;
  const result = await db.query<SettingsRow>(
    `INSERT INTO editor_settings (owner, ai_lang, glossary, recipes, about_name, about, web_search)
     VALUES ($1, COALESCE($2, 'same'), COALESCE($3::jsonb, '[]'::jsonb), COALESCE($4::jsonb, '[]'::jsonb), COALESCE($5, ''), COALESCE($6, ''), COALESCE($7::boolean, true))
     ON CONFLICT (owner) DO UPDATE
        SET ai_lang = COALESCE($2, editor_settings.ai_lang),
            glossary = COALESCE($3::jsonb, editor_settings.glossary),
            recipes = COALESCE($4::jsonb, editor_settings.recipes),
            about_name = COALESCE($5, editor_settings.about_name),
            about = COALESCE($6, editor_settings.about),
            web_search = COALESCE($7::boolean, editor_settings.web_search),
            updated_at = clock_timestamp()
     RETURNING ${COLUMNS}`,
    [owner, aiLang, glossary, recipes, aboutName, about, webSearch],
  );
  const row = result.rows[0];
  if (!row) throw new Error("editor-store: settings upsert returned no row");
  return toSettings(row);
}
