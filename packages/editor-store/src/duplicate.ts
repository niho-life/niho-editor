import { isPageId } from "./store.ts";
import type { Block, OwnerId, Page, PageKind, PageLang, Queryable, StepStatus } from "./types.ts";

/**
 * ページの複製（#34）。本人の・ゴミ箱でないページだけを、1 つの文（INSERT … SELECT）で写す。
 * 写すのは kind・lang・blocks・lead と題名（「〜のコピー」）。cover・recipe・step_status・共有・公開・版は写さない。
 * タブ（#307。`page` が入れ物を指す行）の複製は**同じ入れ物の新しいタブ**（同じフォルダに並び、並びは末尾、`made_from` は `{kind:'dup', from}`）。
 * 入れ物の無い行（手順のサブページ・移行前の行）の複製は、今までどおり上の段の 1 枚（parent は付けない）。
 * 録音ページ（#36。page_recordings の行がある）は、文字起こし（段落・話者名・原本の名前と SHA-256）も同じ文の中で写す。
 * 文字起こしのタブ（#310。page_transcripts の行がある）も、本文（段落・話者名・長さ）を同じ文の中で写す（版は写さない。revision は 1 から）。
 * 録音の revision は 1 から数え直す（別の録音になるので、元の録音の編集とは競合しない）。
 * 音声（#36 段 2a。資産は 1 つのページに属する）は写さない: コピーは文字起こしだけで、audio_* は既定の none。
 * 2 本目以降の音声（新しい migration の page_recording_audios）と文字起こしの案（page_recording_candidates）も、同じ理由で写さない。
 * 音声から作った録音（source = 'audio'）も録音の行を写す（音声のない音声由来の録音は 0008 が許す。文字起こしは残る）。
 * フォルダ（kind = 'folder'）は複製しない（null。API は先に kind を見て bad_request を返す）。
 */

/** 複製の題名に足す言葉。 */
export const DUPLICATE_TITLE_SUFFIX = "のコピー";
/** 題名の上限（0001 の CHECK と同じ。PostgreSQL の length は code point の数）。 */
export const PAGE_TITLE_MAX_CHARS = 500;

/** 複製したページ（createPage の戻りと同じ列）。`page` は同じ入れ物（タブの複製）か null。 */
export type DuplicatedPage = Pick<
  Page,
  "id" | "kind" | "title" | "lang" | "blocks" | "cover" | "lead" | "parent" | "recipe" | "stepStatus" | "page" | "tabName" | "createdAt" | "updatedAt"
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
  page: string | null;
  tab_name: string | null;
  created_at: Date;
  updated_at: Date;
};

/** store.ts の PAGE_COLUMNS の一部（#33 と並行して触らないよう、ここに持つ）。 */
const DUPLICATE_COLUMNS = "id, kind, title, lang, blocks, cover, lead, parent, recipe, step_status, page, tab_name, created_at, updated_at";

/** タブの名前の上限（migration 20261107003531 の CHECK と同じ）。 */
const TAB_NAME_MAX_CHARS = 100;

// $1 owner / $2 元のページの id / $3 題名に足す言葉 / $4 題名の上限 / $5 タブの名前の上限。left・char_length は code point で数える。
// 録音の行は、写したページの行と同じ文の中で入れる（片方だけが入ることはない。外部キーは文の終わりに確かめられる）。
// タブ（page が入れ物を指す）なら同じ入れ物・同じフォルダに、並びは末尾。題名はページの名前のまま（入れ物と同じ。#308）で、
// タブの名前（付けた名前か位置の番号）に「のコピー」を足す。入れ物の無い行は上の段の 1 枚（parent なし）で、題名に「のコピー」。
const DUPLICATE_SQL = `
WITH copied AS (
  INSERT INTO pages (owner, kind, title, lang, blocks, lead, parent, page, made_from, sort_order, tab_name)
  SELECT s.owner, s.kind,
         CASE WHEN s.title = '' OR s.page IS NOT NULL THEN s.title ELSE left(s.title, $4::int - char_length($3::text)) || $3::text END,
         s.lang, s.blocks, s.lead,
         CASE WHEN s.page IS NULL THEN NULL ELSE s.parent END,
         s.page,
         CASE WHEN s.page IS NULL THEN NULL ELSE jsonb_build_object('kind', 'dup', 'from', s.id) END,
         CASE WHEN s.page IS NULL THEN 0
              ELSE COALESCE((SELECT max(t.sort_order) FROM pages t WHERE t.owner = s.owner AND t.page = s.page AND t.deleted_at IS NULL), 0) + 1 END,
         CASE WHEN s.page IS NULL THEN NULL
              ELSE left(COALESCE(s.tab_name, (SELECT count(*) FROM pages t
                                                WHERE t.owner = s.owner AND t.page = s.page AND t.deleted_at IS NULL
                                                  AND (t.sort_order, t.created_at, t.id) <= (s.sort_order, s.created_at, s.id))::text),
                        $5::int - char_length($3::text)) || $3::text END
    FROM pages s
   WHERE s.owner = $1 AND s.id = $2 AND s.deleted_at IS NULL AND s.kind <> 'folder' AND s.kind <> 'page'
  RETURNING ${DUPLICATE_COLUMNS}
),
touched AS (
  UPDATE pages h SET updated_at = GREATEST(clock_timestamp(), h.updated_at), last_tab = c.id
    FROM copied c WHERE h.owner = $1 AND h.id = c.page
  RETURNING h.id
),
recording AS (
  INSERT INTO page_recordings
         (page_id, owner, source, language, engine, duration_sec, source_name, source_sha256, segments, speaker_names, created_at, updated_at)
  SELECT c.id, r.owner, r.source, r.language, r.engine, r.duration_sec, r.source_name, r.source_sha256,
         r.segments, r.speaker_names, c.created_at, c.created_at
    FROM copied AS c
    JOIN page_recordings AS r ON r.owner = $1 AND r.page_id = $2
  RETURNING page_id
),
transcript AS (
  INSERT INTO page_transcripts
         (page_id, owner, recording_page_id, engine, language, segments, speaker_names, duration_sec, created_at, updated_at)
  SELECT c.id, t.owner, t.recording_page_id, t.engine, t.language, t.segments, t.speaker_names, t.duration_sec, c.created_at, c.created_at
    FROM copied AS c
    JOIN page_transcripts AS t ON t.owner = $1 AND t.page_id = $2
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
    const result = await db.query<PageRow>(DUPLICATE_SQL, [owner, pageId, DUPLICATE_TITLE_SUFFIX, PAGE_TITLE_MAX_CHARS, TAB_NAME_MAX_CHARS]);
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
      page: row.page,
      tabName: row.tab_name,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  } catch (error) {
    if (isInvalidTextRepresentation(error)) return null;
    throw error;
  }
}
