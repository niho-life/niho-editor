import { SETTINGS_LIMITS, isSettingsTerm, isSettingsText, type SettingsTerm } from "./settings.ts";
import type { OwnerId, Queryable } from "./types.ts";

/**
 * フォルダの欄（表 page_fields。migration 20261101013000_folder_order_fields_opens。docs/architecture/editor-recipes-and-folders.md §3）。
 *
 * 旧 NIHO docs の `project.json` の `info` のうち、**登場人物（entities）と固有名詞（terms）**を持つ。
 * **背景情報はフォルダのページの本文そのもの**なので、ここには持たない（列を増やさない）。
 *
 * - どのページでも持てるが、画面で出すのはフォルダ（＝子を持てる、上の段のページ）。行が無ければ空。
 * - 書き込みは項目ごとに全部入れ替える（部分的な継ぎ足しをしない）。
 * - 固有名詞はアカウント共通（`editor_settings.glossary`）・手順ごと（`recipes.terms`）と同じ形で、
 *   このフォルダの中の録音・文書にだけ効く（AI へ渡す側がどれを使うか決める）。
 * - 録音の欄（話者人数・言語・参考。docs-core の `recording-fields.ts`）は別のもので、ここには入れない。
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
});

export const EMPTY_PAGE_FIELDS: PageFields = Object.freeze({ entities: [], terms: [] }) as PageFields;

/** 検証が断る理由（API はこれをそのまま返さない。短い code だけを返す）。 */
export type PageFieldsProblem = "entities" | "terms";

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

/** フォルダの欄の変更に通らないところがあれば、その項目を返す（無ければ null）。 */
export function pageFieldsProblem(patch: unknown): PageFieldsProblem | null {
  if (!isPlainObject(patch) || !hasOnlyKeys(patch, ["entities", "terms"])) return "entities";
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
  return cleaned;
}

function assertOwner(owner: OwnerId): void {
  // store.ts と同じ守り（空の owner で誰のものでもない行を読み書きしない）
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

type FieldsRow = { entities: unknown; terms: unknown };

/** 保存した値が今の形に合わなければ落として読む（古い行・手で直した行で画面を壊さない）。 */
function toFields(row: FieldsRow | undefined): PageFields {
  if (!row) return { entities: [], terms: [] };
  return {
    entities: Array.isArray(row.entities) ? row.entities.filter(isPageEntity) : [],
    terms: Array.isArray(row.terms) ? row.terms.filter(isSettingsTerm) : [],
  };
}

const COLUMNS = "entities, terms";

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
  const result = await db.query<FieldsRow>(
    `INSERT INTO page_fields (owner, page_id, entities, terms)
     VALUES ($1, $2, COALESCE($3::jsonb, '[]'::jsonb), COALESCE($4::jsonb, '[]'::jsonb))
     ON CONFLICT (owner, page_id) DO UPDATE
        SET entities = COALESCE($3::jsonb, page_fields.entities),
            terms = COALESCE($4::jsonb, page_fields.terms),
            updated_at = clock_timestamp()
     RETURNING ${COLUMNS}`,
    [owner, pageId, entities, terms],
  );
  const row = result.rows[0];
  if (!row) throw new Error("editor-store: page fields upsert returned no row");
  return toFields(row);
}

/** 欄が何か入っているか（書き出しの「背景情報」のページを出すかの判定に使う）。 */
export function hasPageFields(fields: PageFields): boolean {
  return fields.entities.length > 0 || fields.terms.length > 0;
}
