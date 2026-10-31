import { isPageId } from "./store.ts";
import type { Block, OwnerId, Page, PageKind, PageLang, Queryable, StepStatus } from "./types.ts";

/**
 * ページの複製（#34）。本人の・ゴミ箱でないページだけを、1 つの文（INSERT … SELECT）で写す。
 * 写すのは kind・lang・blocks・lead と題名（「〜のコピー」）。parent・cover・recipe・step_status・共有・公開・版は写さない。
 * 録音ページ（#36。page_recordings の行がある）は、文字起こし（段落・話者名・原本の名前と SHA-256）も同じ文の中で写す。
 * 録音の revision は 1 から数え直す（別の録音になるので、元の録音の編集とは競合しない）。
 * 音声（#36 段 2a。資産は 1 つのページに属する）は写さない: コピーは文字起こしだけで、audio_* は既定の none。
 * 2 本目以降の音声（新しい migration の page_recording_audios）と文字起こしの案（page_recording_candidates）も、同じ理由で写さない。
 * 音声から作った録音（source = 'audio'）も録音の行を写す（音声のない音声由来の録音は 0008 が許す。文字起こしは残る）。
 */

/** 複製の題名に足す言葉。 */
export const DUPLICATE_TITLE_SUFFIX = "のコピー";
/** 題名の上限（0001 の CHECK と同じ。PostgreSQL の length は code point の数）。 */
export const PAGE_TITLE_MAX_CHARS = 500;

/** 複製したページ（createPage の戻りと同じ列）。 */
export type DuplicatedPage = Pick<
  Page,
  "id" | "kind" | "title" | "lang" | "blocks" | "cover" | "lead" | "parent" | "recipe" | "stepStatus" | "createdAt" | "updatedAt"
>;

/**
 * 複製の題名（SQL と同じ規則。テストと画面の見込みのため）。空なら空のまま。
 * そうでなければ「題名のコピー」。上限を超えるときは元の題名の側を code point 単位で切る。
 */
export function duplicateTitle(title: string): string {
  if (title === "") return "";
  const keep = PAGE_TITLE_MAX_CHARS - Array.from(DUPLICATE_TITLE_SUFFIX).length;
  return `${Array.from(title).slice(0, keep).join("")}${DUPLICATE_TITLE_SUFFIX}`;
}

type PageRow = {
  id: string;
  kind: PageKind;
  title: string;
  lang: PageLang;
  blocks: Block[];
  cover: string | null;
  lead: string | null;
  parent: string | null;
  recipe: string | null;
  step_status: StepStatus | null;
  created_at: Date;
  updated_at: Date;
};

/** store.ts の PAGE_COLUMNS と同じ列（#33 と並行して触らないよう、ここに持つ）。 */
const DUPLICATE_COLUMNS = "id, kind, title, lang, blocks, cover, lead, parent, recipe, step_status, created_at, updated_at";

// $1 owner / $2 元のページの id / $3 題名に足す言葉 / $4 題名の上限。left・char_length は code point で数える。
// 録音の行は、写したページの行と同じ文の中で入れる（片方だけが入ることはない。外部キーは文の終わりに確かめられる）。
const DUPLICATE_SQL = `
WITH copied AS (
  INSERT INTO pages (owner, kind, title, lang, blocks, lead)
  SELECT owner, kind,
         CASE WHEN title = '' THEN '' ELSE left(title, $4::int - char_length($3::text)) || $3::text END,
         lang, blocks, lead
    FROM pages
   WHERE owner = $1 AND id = $2 AND deleted_at IS NULL
  RETURNING ${DUPLICATE_COLUMNS}
),
recording AS (
  INSERT INTO page_recordings
         (page_id, owner, source, language, engine, duration_sec, source_name, source_sha256, segments, speaker_names, created_at, updated_at)
  SELECT c.id, r.owner, r.source, r.language, r.engine, r.duration_sec, r.source_name, r.source_sha256,
         r.segments, r.speaker_names, c.created_at, c.created_at
    FROM copied AS c
    JOIN page_recordings AS r ON r.owner = $1 AND r.page_id = $2
  RETURNING page_id
)
SELECT ${DUPLICATE_COLUMNS} FROM copied`;

function assertOwner(owner: OwnerId): void {
  // store.ts と同じ守り: 認証の層の誤りで空の owner が来たときに、誰のものでもない行を読み書きしない
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

function isInvalidTextRepresentation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "22P02";
}

/** 本人のページを複製する。別の人のページ・削除済み・存在しない・UUID として不正な id はどれも null。 */
export async function duplicatePage(db: Queryable, owner: OwnerId, pageId: string): Promise<DuplicatedPage | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  try {
    const result = await db.query<PageRow>(DUPLICATE_SQL, [owner, pageId, DUPLICATE_TITLE_SUFFIX, PAGE_TITLE_MAX_CHARS]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      lang: row.lang,
      blocks: row.blocks,
      cover: row.cover,
      lead: row.lead,
      parent: row.parent,
      recipe: row.recipe,
      stepStatus: row.step_status,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  } catch (error) {
    if (isInvalidTextRepresentation(error)) return null;
    throw error;
  }
}
