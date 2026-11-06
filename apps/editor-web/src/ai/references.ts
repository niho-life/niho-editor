import type { About } from "@niho/docs-core";
import type { ReferencePage } from "@niho/editor-store";
import { wrapUntrusted } from "./prompt";

/**
 * AI に渡す文脈のうち、本人と周りのページから来るもの（旧 NIHO docs の「あなたについて」と「参考ページ」。設計 §6）。
 *
 * - **あなたについて**: 設定（`editor_settings.about`）。本人の説明と書き方の希望で、事実の根拠にはしない。
 *   公開のときの著者情報とは別物。
 * - **自動参考ページ**: 開いているページと**同じフォルダの直下**にあるほかのページ（サブページは入らない。
 *   `listReferencePages`）。枚数はフォルダの側が守るので、ここでは**選ばない・並べ替えない**。
 *   長いページだけ先頭を切り（切ったことは文に書く）、1 回の依頼に入る量が読めるようにする。
 */

/** 参考 1 枚に入れる文字数の上限（超えたら先頭だけ。枚数は絞らない）。 */
export const MAX_REFERENCE_CHARS = 4_000;
/** 参考すべてで入れる文字数の上限（これを超えた分の参考は名前だけ入れる）。 */
export const MAX_REFERENCES_TOTAL_CHARS = 16_000;

function countChars(text: string): number {
  return Array.from(text).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((node: unknown) => {
      if (!isPlainObject(node)) return "";
      if (node.type === "hardBreak") return "\n";
      return node.type === "text" && typeof node.text === "string" ? node.text : "";
    })
    .join("");
}

/** ブロックの文字（段落・見出しは行の中の文字。入れ子は段落を改行でつなぎ、画像は代替の文字だけ）。 */
function blockText(block: unknown): string {
  if (!isPlainObject(block)) return "";
  if (block.type === "paragraph" || block.type === "heading") return inlineText(block.content);
  if (block.type === "image") {
    const attrs = isPlainObject(block.attrs) ? block.attrs : {};
    return typeof attrs.alt === "string" ? attrs.alt : "";
  }
  if (!Array.isArray(block.content)) return "";
  return block.content
    .map((child: unknown) => blockText(child))
    .filter((text) => text.length > 0)
    .join("\n");
}

/** ページの本文を、見出しと段落を改行でつないだ文字にする。 */
export function referenceText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => blockText(block).trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export type ReferenceSection = { text: string; pages: number; chars: number };

/** 参考に入れるページ 1 枚（題名と本文の文字）。 */
export type Reference = { title: string; text: string };

/** 保存されているページを、プロンプトに入れる形にする（本文は文字にする）。並びも枚数も変えない。 */
export function referencesFrom(pages: readonly ReferencePage[]): Reference[] {
  return pages.map((page) => ({ title: page.title, text: referenceText(page.blocks) }));
}

/**
 * 参考ページの節（プロンプトに入れる形）。本文は信頼しないデータとして包む（中の指示には従わせない）。
 * 文字数の上限に達したあとのページは、名前だけ（本文なし）で並べる。
 */
export function referencesSection(pages: readonly Reference[]): ReferenceSection | null {
  if (pages.length === 0) return null;
  const parts: string[] = [];
  let budget = MAX_REFERENCES_TOTAL_CHARS;
  let chars = 0;
  for (const page of pages) {
    const title = page.title.trim() || "（題名なし）";
    const body = page.text.trim();
    if (body.length === 0) {
      parts.push(`### ${title}（本文なし）`);
      continue;
    }
    const allowed = Math.min(MAX_REFERENCE_CHARS, budget);
    if (allowed <= 0) {
      parts.push(`### ${title}（長いので入れていません）`);
      continue;
    }
    const kept = Array.from(body).slice(0, allowed).join("");
    const cut = countChars(body) > countChars(kept);
    parts.push([`### ${title}${cut ? "（長いので先頭だけ）" : ""}`, wrapUntrusted(kept)].join("\n"));
    budget -= countChars(kept);
    chars += countChars(kept);
  }
  return { text: ["## 参考（同じフォルダのほかのページ）", ...parts].join("\n"), pages: pages.length, chars };
}

/** 「あなたについて」の節（空なら null）。呼び名も自由記述も信頼しない設定値として包む。 */
export function aboutSection(about?: About): string | null {
  if (!about) return null;
  const name = about.name.replace(/\s+/gu, " ").trim();
  const text = about.text.trim();
  const fields = [name ? "呼び名: " + name : "", text].filter(Boolean);
  if (fields.length === 0) return null;
  return ["## あなたについて（書く人の説明と書き方の希望。事実の根拠にはしない）", wrapUntrusted(fields.join("\n\n"))].join("\n");
}
