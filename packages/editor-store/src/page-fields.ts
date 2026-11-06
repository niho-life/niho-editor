import { SETTINGS_LIMITS, isSettingsTerm, isSettingsText, type SettingsTerm } from "./settings.ts";
import { TRANSCRIPTION_TERMS_MAX, isTranscriptionTerm } from "./transcription-runs.ts";
import { isPageId } from "./store.ts";
import type { OwnerId, PageKind, Queryable } from "./types.ts";

/**
 * 録音ページの欄「この録音について」（表 page_fields。migration 20261101013000_folder_order_fields_opens と
 * 20261106161433_folder_kind_recording_fields。docs/architecture/editor-recipes-and-folders.md §3.3・§4）。
 *
 * 旧 NIHO docs の `project.json` の `info` にあたる、**登場人物（entities）・固有名詞（terms）・背景（background）**を持つ。
 * 2026-11-06 からは録音ページ自身の id で持つ（これまでは親フォルダの id。フォルダは本文も欄も持たない）。
 *
 * - どのページでも持てるが、画面で出すのは録音ページ（録音ブロックの直下の「この録音について」）。行が無ければ空。
 * - 書き込みは項目ごとに全部入れ替える（部分的な継ぎ足しをしない）。
 * - 固有名詞はアカウント共通（`editor_settings.glossary`）・手順ごと（`recipes.terms`）と同じ形で、この録音にだけ効く
 *   （文字起こしのヒントと工程の入力。AI へ渡す側がどれを使うか決める）。
 * - 話者人数・言語（docs-core の `recording-fields.ts`）は文字起こしの開始の値で、ここには入れない。
 */

/** 登場人物の 1 行（名前・よみ・役割・補足）。旧 `project.json` の `info.entities` と同じ形。 */
export type PageEntity = {
  name: string;
  reading: string;
  role: string;
  note: string;
};

export type PageFields = {
  entities: PageEntity[];
  terms: SettingsTerm[];
  /** 背景（取材の目的・相手・場所など。文字。4,000 字まで）。 */
  background: string;
};

/** 変える項目だけを渡す（渡した項目は全部入れ替える）。 */
export type PageFieldsPatch = Partial<PageFields>;

/** 画面と API が守る上限（表の CHECK は件数だけを見る）。固有名詞は設定（0013）と同じ値。 */
export const PAGE_FIELD_LIMITS = Object.freeze({
  entities: 200,
  nameChars: SETTINGS_LIMITS.termChars,
  roleChars: SETTINGS_LIMITS.termChars,
  noteChars: SETTINGS_LIMITS.noteChars,
  terms: SETTINGS_LIMITS.glossary,
  /** 背景の字数（表の CHECK と同じ値）。 */
  backgroundChars: 4000,
});

export const EMPTY_PAGE_FIELDS: PageFields = Object.freeze({ entities: [], terms: [], background: "" }) as PageFields;

/** 検証が断る理由（API はこれをそのまま返さない。短い code だけを返す）。 */
export type PageFieldsProblem = "entities" | "terms" | "background";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isPageEntity(value: unknown): value is PageEntity {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["name", "reading", "role", "note"])) return false;
  const { nameChars, roleChars, noteChars } = PAGE_FIELD_LIMITS;
  // 名前だけは空にできない（空の行は AI に渡しても意味が無い）
  if (!isSettingsText(value.name, nameChars) || value.name.trim() === "") return false;
  if (!isSettingsText(value.reading, nameChars)) return false;
  if (!isSettingsText(value.role, roleChars)) return false;
  return isSettingsText(value.note, noteChars);
}

/** 録音の欄の変更に通らないところがあれば、その項目を返す（無ければ null）。 */
export function pageFieldsProblem(patch: unknown): PageFieldsProblem | null {
  if (!isPlainObject(patch) || !hasOnlyKeys(patch, ["entities", "terms", "background"])) return "entities";
  if (patch.entities !== undefined) {
    const { entities } = patch;
    if (!Array.isArray(entities) || entities.length > PAGE_FIELD_LIMITS.entities || !entities.every(isPageEntity)) return "entities";
    const names = entities.map((entity) => entity.name.trim());
    if (new Set(names).size !== names.length) return "entities";
  }
  if (patch.terms !== undefined) {
    const { terms } = patch;
    if (!Array.isArray(terms) || terms.length > PAGE_FIELD_LIMITS.terms || !terms.every(isSettingsTerm)) return "terms";
    const written = terms.map((entry) => entry.term.trim());
    if (new Set(written).size !== written.length) return "terms";
  }
  if (patch.background !== undefined) {
    // 表の CHECK は length（文字数）で数えるので、ここもコードポイントで数える
    const { background } = patch;
    if (typeof background !== "string" || background.includes("\u0000") || Array.from(background).length > PAGE_FIELD_LIMITS.backgroundChars) return "background";
  }
  return null;
}

/** 前後の空白を落として整える（保存の直前に 1 回だけ通す）。 */
export function cleanPageFieldsPatch(patch: PageFieldsPatch): PageFieldsPatch {
  const cleaned: PageFieldsPatch = {};
  if (patch.entities !== undefined) {
    cleaned.entities = patch.entities.map((entity) => ({
      name: entity.name.trim(),
      reading: entity.reading.trim(),
      role: entity.role.trim(),
      note: entity.note.trim(),
    }));
  }
  if (patch.terms !== undefined) {
    cleaned.terms = patch.terms.map((entry) => ({
      term: entry.term.trim(),
      reading: entry.reading.trim(),
      variants: entry.variants.map((variant) => variant.trim()).filter((variant) => variant !== ""),
      note: entry.note.trim(),
    }));
  }
  if (patch.background !== undefined) cleaned.background = patch.background.trim();
  return cleaned;
}

function assertOwner(owner: OwnerId): void {
  // store.ts と同じ守り（空の owner で誰のものでもない行を読み書きしない）
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

type FieldsRow = { entities: unknown; terms: unknown; background: unknown };

/** 保存した値が今の形に合わなければ落として読む（古い行・手で直した行で画面を壊さない）。 */
function toFields(row: FieldsRow | undefined): PageFields {
  if (!row) return { entities: [], terms: [], background: "" };
  return {
    entities: Array.isArray(row.entities) ? row.entities.filter(isPageEntity) : [],
    terms: Array.isArray(row.terms) ? row.terms.filter(isSettingsTerm) : [],
    background: typeof row.background === "string" ? row.background : "",
  };
}

const COLUMNS = "entities, terms, background";

/** そのページの欄（行が無ければ空）。ページが本人のものかは呼ぶ側が先に確かめる。 */
export async function getPageFields(db: Queryable, owner: OwnerId, pageId: string): Promise<PageFields> {
  assertOwner(owner);
  const result = await db.query<FieldsRow>(`SELECT ${COLUMNS} FROM page_fields WHERE owner = $1 AND page_id = $2`, [owner, pageId]);
  return toFields(result.rows[0]);
}

/**
 * 渡した項目だけを入れ替え、入れ替えた後の欄を返す。1 つの `INSERT … ON CONFLICT DO UPDATE` で書く。
 * ページが本人のものでなければ、外部キーが断る（呼ぶ側が先に 404 を返す）。
 */
export async function savePageFields(db: Queryable, owner: OwnerId, pageId: string, patch: PageFieldsPatch): Promise<PageFields> {
  assertOwner(owner);
  const problem = pageFieldsProblem(patch);
  if (problem) throw new TypeError(`editor-store: fields.${problem} is not storable`);
  const value = cleanPageFieldsPatch(patch);
  const entities = value.entities === undefined ? null : JSON.stringify(value.entities);
  const terms = value.terms === undefined ? null : JSON.stringify(value.terms);
  const background = value.background === undefined ? null : value.background;
  const result = await db.query<FieldsRow>(
    `INSERT INTO page_fields (owner, page_id, entities, terms, background)
     VALUES ($1, $2, COALESCE($3::jsonb, '[]'::jsonb), COALESCE($4::jsonb, '[]'::jsonb), COALESCE($5::text, ''))
     ON CONFLICT (owner, page_id) DO UPDATE
        SET entities = COALESCE($3::jsonb, page_fields.entities),
            terms = COALESCE($4::jsonb, page_fields.terms),
            background = COALESCE($5::text, page_fields.background),
            updated_at = clock_timestamp()
     RETURNING ${COLUMNS}`,
    [owner, pageId, entities, terms, background],
  );
  const row = result.rows[0];
  if (!row) throw new Error("editor-store: page fields upsert returned no row");
  return toFields(row);
}

/** 欄が何か入っているか（書き出しの「この録音について」を出すかの判定に使う）。 */
export function hasPageFields(fields: PageFields): boolean {
  return fields.entities.length > 0 || fields.terms.length > 0 || fields.background.trim() !== "";
}

/**
 * 文字起こしの開始に渡すヒント（docs/architecture/editor-recipes-and-folders.md §3.3）。録音の固有名詞の表記（`term`）と
 * 誤りやすい表記（`variants`）を、出てくる順に重ねず並べ、文字起こしの語として通らないもの（長すぎる・空）は落とし、
 * `TRANSCRIPTION_TERMS_MAX` を超える分は先頭から数えて切る。
 */
export function transcriptionTermsOf(terms: readonly SettingsTerm[]): string[] {
  const hints: string[] = [];
  for (const entry of terms) {
    for (const written of [entry.term, ...entry.variants]) {
      const term = written.trim();
      if (!isTranscriptionTerm(term) || hints.includes(term)) continue;
      hints.push(term);
      if (hints.length >= TRANSCRIPTION_TERMS_MAX) return hints;
    }
  }
  return hints;
}

/**
 * 本人の・ゴミ箱でないページの種類と、文字起こしのヒント（そのページ自身の固有名詞）。ページが無ければ null（同じ 404）。
 * 文字起こしの開始が `terms` を渡されなかったときに使う。
 */
export async function readTranscriptionHints(db: Queryable, owner: OwnerId, pageId: string): Promise<{ kind: PageKind; terms: string[] } | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  const result = await db.query<{ kind: PageKind; terms: unknown }>(
    `SELECT p.kind, f.terms
       FROM pages p
       LEFT JOIN page_fields f ON f.owner = p.owner AND f.page_id = p.id
      WHERE p.owner = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
    [owner, pageId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const terms = Array.isArray(row.terms) ? row.terms.filter(isSettingsTerm) : [];
  return { kind: row.kind, terms: transcriptionTermsOf(terms) };
}
