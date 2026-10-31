import { FOLDER_EXPORT_CONTEXT_TITLE, FOLDER_EXPORT_MAX_CHARS, FOLDER_EXPORT_MAX_TABS } from "@niho/docs-core";
import { buildZip, type ZipEntry } from "@niho/editor-publish";
import type { PageEntity, PageFields } from "@niho/editor-store";
import { exportMarkdown } from "./markdown";

/**
 * フォルダ単位の書き出し（#37。旧 NIHO docs の `folder-export-tree.ts` の木を、ページ＋サブページの木に作り替えたもの）。
 *
 * - 出すのは `.md` と写真の zip。`背景情報.md`（フォルダの本文＋登場人物＋固有名詞）を先頭に、フォルダの中のページを
 *   木の順に 1 ページ 1 ファイルで並べる。Google ドキュメントへの書き出しは別（この module は触らない）。
 * - 件数と字数の上限は旧版と同じ（`FOLDER_EXPORT_MAX_TABS`・`FOLDER_EXPORT_MAX_CHARS`。docs-core の定数）。
 * - 写真は本文に出てくる資産だけを `photos/{sha256}.{拡張子}` に 1 回ずつ入れ、本文はその相対 path を指す。
 *   読めなかった写真は**黙って落とさず**、その本文から画像の行を出さない（`photoPath` が null を返す）。
 * - ファイル名はページの題名から作る（同じ名前は `-2`・`-3`。zip の中で安全な名前だけを作る）。
 * - 本文・題名はログ・エラーに書かない（結果は数と理由だけ）。
 */

/** 書き出すページ（`EditorStore.listPageTree` の 1 行。先頭がフォルダ）。 */
export type FolderExportPage = {
  id: string;
  title: string;
  blocks: readonly unknown[];
};

/** 本文に出てくる写真（読めたものだけ）。 */
export type FolderExportPhoto = {
  sha256: string;
  /** `image/jpeg` など。zip の中の拡張子を決める。 */
  contentType: string;
  bytes: Uint8Array;
};

export type FolderExportInput = {
  pages: readonly FolderExportPage[];
  /** フォルダの登場人物・固有名詞（`page_fields`）。 */
  fields: PageFields;
  /** 資産の id → 読めた写真。 */
  photos: ReadonlyMap<string, FolderExportPhoto>;
};

export type FolderExportFailure = { ok: false; reason: "empty" | "too_many" | "too_large" | "archive" };
export type FolderExportResult = { ok: true; bytes: Uint8Array; files: string[]; photos: number } | FolderExportFailure;

/** 写真の拡張子（editor-publish の PHOTO_EXTENSIONS と同じ値。知らない種類は bin）。 */
const PHOTO_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const PHOTO_DIRECTORY = "photos";

/** zip の中の写真の path（同じ写真は 1 回だけ入る）。 */
export function photoArchivePath(photo: Pick<FolderExportPhoto, "sha256" | "contentType">): string {
  return `${PHOTO_DIRECTORY}/${photo.sha256}.${PHOTO_EXTENSIONS[photo.contentType] ?? "bin"}`;
}

/**
 * ページの題名から zip の中のファイル名を作る。zip の名前として危ない文字（`/` `\` `:` 制御文字・`.` だけの名前）を
 * `-` にし、長すぎる名前を切る。題名が空なら「無題」。
 */
export function exportFileName(title: string): string {
  const cleaned = Array.from(title.trim().replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "-"))
    .slice(0, 80)
    .join("")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  return cleaned === "" ? "無題" : cleaned;
}

/** 同じ名前が 2 つ以上あれば `-2`・`-3` を付ける（比べるのは小文字にした名前。ファイルシステムと同じ）。 */
export function uniqueFileNames(titles: readonly string[]): string[] {
  const used = new Map<string, number>();
  return titles.map((title) => {
    const base = exportFileName(title);
    const key = base.toLowerCase();
    const seen = used.get(key) ?? 0;
    used.set(key, seen + 1);
    return seen === 0 ? `${base}.md` : `${base}-${seen + 1}.md`;
  });
}

/** 本文の中の再帰の深さの上限（markdown.ts と同じ）。 */
const MAX_DEPTH = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 本文に出てくる写真の資産の id（出てくる順。同じ id は 1 回）。読むのはこの id の写真だけ。 */
export function photoAssetIds(blocks: readonly unknown[]): string[] {
  const found: string[] = [];
  const walk = (nodes: unknown, depth: number): void => {
    if (!Array.isArray(nodes) || depth > MAX_DEPTH) return;
    for (const node of nodes) {
      if (typeof node !== "object" || node === null || Array.isArray(node)) continue;
      const record = node as { type?: unknown; attrs?: unknown; content?: unknown };
      if (record.type === "image" && typeof record.attrs === "object" && record.attrs !== null) {
        const { assetId } = record.attrs as { assetId?: unknown };
        if (typeof assetId === "string" && UUID.test(assetId) && !found.includes(assetId)) found.push(assetId);
      }
      walk(record.content, depth + 1);
    }
  };
  walk(blocks, 0);
  return found;
}

function entityLine(entity: PageEntity): string {
  const parts = [entity.name, entity.reading, entity.role, entity.note].map((part) => part.trim()).filter((part) => part !== "");
  return `- ${parts.join(" · ")}`;
}

/**
 * 「背景情報」のページ（旧 NIHO docs の `info`）。フォルダの本文をそのまま置き、登場人物・固有名詞があれば
 * 見出しを付けて並べる。どれも無ければ null（そのページを出さない）。
 */
export function contextMarkdown(folder: FolderExportPage, fields: PageFields, photoPath: (assetId: string) => string | null): string | null {
  const body = exportMarkdown(folder.blocks, { photoPath }).trim();
  const parts: string[] = [];
  if (body !== "") parts.push(body);
  if (fields.entities.length > 0) parts.push(`## 登場人物\n${fields.entities.map(entityLine).join("\n")}`);
  if (fields.terms.length > 0) {
    const lines = fields.terms.map((term) => {
      const written = [term.term, term.reading, ...term.variants, term.note].map((part) => part.trim()).filter((part) => part !== "");
      return `- ${written.join(" · ")}`;
    });
    parts.push(`## 固有名詞\n${lines.join("\n")}`);
  }
  return parts.length === 0 ? null : `# ${FOLDER_EXPORT_CONTEXT_TITLE}\n\n${parts.join("\n\n")}\n`;
}

/** ページ 1 枚の `.md`（題名を h1 にして本文を続ける。公開の書き出しと違い、front matter は付けない）。 */
export function pageMarkdown(page: FolderExportPage, photoPath: (assetId: string) => string | null): string {
  const body = exportMarkdown(page.blocks, { photoPath }).trim();
  const title = page.title.trim() === "" ? "無題" : page.title.trim();
  return body === "" ? `# ${title}\n` : `# ${title}\n\n${body}\n`;
}

/**
 * フォルダの書き出しを組む。`pages` の先頭がフォルダで、その後ろが中のページ（木の順）。
 * 件数・字数の上限を超えたら何も作らずに断る（`too_many`・`too_large`）。
 */
export function buildFolderExport(input: FolderExportInput): FolderExportResult {
  const [folder, ...inside] = input.pages;
  if (!folder) return { ok: false, reason: "empty" };
  const photoPath = (assetId: string): string | null => {
    const photo = input.photos.get(assetId);
    return photo ? photoArchivePath(photo) : null;
  };
  const files: { name: string; text: string }[] = [];
  const context = contextMarkdown(folder, input.fields, photoPath);
  if (context !== null) files.push({ name: `${FOLDER_EXPORT_CONTEXT_TITLE}.md`, text: context });
  const names = uniqueFileNames([FOLDER_EXPORT_CONTEXT_TITLE, ...inside.map((page) => page.title)]).slice(1);
  for (const [index, page] of inside.entries()) files.push({ name: names[index]!, text: pageMarkdown(page, photoPath) });
  if (files.length === 0) return { ok: false, reason: "empty" };
  if (files.length > FOLDER_EXPORT_MAX_TABS) return { ok: false, reason: "too_many" };
  const chars = files.reduce((total, file) => total + Array.from(file.text).length, 0);
  if (chars > FOLDER_EXPORT_MAX_CHARS) return { ok: false, reason: "too_large" };

  const used = new Set(files.flatMap((file) => [...file.text.matchAll(/\]\((photos\/[^)]+)\)/g)].map((match) => match[1]!)));
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = files.map((file) => ({ name: file.name, data: encoder.encode(file.text) }));
  const photos = [...input.photos.values()].filter((photo) => used.has(photoArchivePath(photo)));
  const seen = new Set<string>();
  for (const photo of photos) {
    const name = photoArchivePath(photo);
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push({ name, data: photo.bytes });
  }
  const zip = buildZip(entries);
  if (!zip.ok) return { ok: false, reason: "archive" };
  return { ok: true, bytes: zip.bytes, files: entries.map((entry) => entry.name), photos: seen.size };
}
