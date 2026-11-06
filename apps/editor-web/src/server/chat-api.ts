import { estimateTokenCostUsd } from "@niho/docs-core";
import {
  DEFAULT_EDITOR_SETTINGS,
  MESSAGE_TEXT_MAX_CHARS,
  monthKeyJst,
  type AiMessage,
  type AiMessageChange,
  type AiUsageDelta,
  type AiUsageTotals,
  type AiUsageSource,
  type Block,
  type ChatChangeInput,
  type ChatTurnInput,
  type ChatWorkspacePage,
  type CreatePageInput,
  type ReferencePage,
  type EditorSettings,
  type OwnerId,
  type Page,
  type PageFields,
  type PageVersionSummary,
  type Recording,
  type RestoreResult,
  type SaveResult,
} from "@niho/editor-store";
// 画面の部品に触れない Markdown の往復（docs-ui。Mac の保管庫と同じ変換を使う）
import { blocksToMarkdown, markdownToBlocks } from "niho-docs-ui/page/markdown";
import { blockText, diffBlocks, markAiInserted } from "../ai/block-diff";
import type { AiComposeBackend } from "../ai/config";
import {
  MAX_CHAT_INPUT_CHARS,
  MAX_TRANSCRIPT_QUERY_CHARS,
  buildChatMessages,
  buildChatSystem,
  isChatToolName,
  runChatTurn,
  type ChatEvent,
  type ChatHistoryTurn,
  type ChatItem,
  type ChatRun,
  type ToolOutcome,
  paragraphLabel,
} from "../ai/chat";
import { wrapUntrusted } from "../ai/prompt";
import type { AiUsageReport } from "../ai/model";
import type { AuthProvider } from "../auth/types";
import { PAGE_BODY_MAX_BYTES, conflictResponse, errorResponse, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";
import { parseBlocks } from "./page-input";

/**
 * AI チャット（#38）。旧アプリ（NIHO docs）の「修正の会話」と同じ動き: **AI が道具でページを直接書き換える**。
 * 依頼の中でページが変わる。安全のための約束:
 *
 * - 触れるのは「開いているページ・その親・そのサブページ」だけ（`listChatWorkspace`）。
 * - 書く前に必ず今の本文を版（`ai`）に残し、その版の番号を会話に書く → 人が「元に戻す」で戻せる。
 * - 書き込み（edit_page・write_page）は AI が読んだ版（`base_revision`）が今の版と同じときだけ（#278）。
 *   Mac CLI の書き戻し（recordDeviceChatTurn）は、CLI が読んだ版（`deviceRevisions`）をその前提に使う。
 * - 月の上限は往復のたびに見て、上限以上ならモデルを呼ばずに止める。
 * - 鍵・プロンプト・本文はログ・エラーに出さない。会話に残すのは作業の要約（道具・ページの名前・成否）だけ。
 */

export type ChatPagesStore = {
  getPage: (owner: OwnerId, id: string) => Promise<Page | null>;
  savePage: (owner: OwnerId, id: string, patch: { blocks: Block[] }, options: { baseRevision: number }) => Promise<SaveResult | null>;
  createVersion: (owner: OwnerId, id: string, reason: "ai") => Promise<PageVersionSummary | null>;
  /** 上の段に作る（チャットからはフォルダの中に作らない）。 */
  createPage: (owner: OwnerId, input: Omit<CreatePageInput, "parent">) => Promise<Page>;
  restoreVersion: (
    owner: OwnerId,
    id: string,
    version: number,
    options: { baseRevision: number; accept: (blocks: unknown) => Block[] | null },
  ) => Promise<RestoreResult | null>;
  deletePage: (owner: OwnerId, id: string) => Promise<"deleted" | "published" | null>;
};

export type ChatConversationStore = {
  workspace: (owner: OwnerId, pageId: string) => Promise<ChatWorkspacePage[] | null>;
  /** 同じフォルダのほかのページ（読むだけで触らせる。書けるのは作業場のページだけ）。 */
  references?: (owner: OwnerId, pageId: string) => Promise<ReferencePage[] | null>;
  /** 録音ページの文字起こし（search_transcript。渡さなければ探せない）。他人の・無いページは null。 */
  recording?: (owner: OwnerId, pageId: string) => Promise<Recording | null>;
  /** 録音ページの「この録音について」（背景・登場人物・固有名詞）。開いているのが録音ページのとき、指示の文脈に入れる。 */
  fields?: (owner: OwnerId, pageId: string) => Promise<PageFields>;
  history: (owner: OwnerId, pageId: string, conversationId: string) => Promise<{ messages: AiMessage[] } | null>;
  append: (owner: OwnerId, input: ChatTurnInput) => Promise<{ conversation: { id: string }; result: AiMessage } | null>;
  changes: (owner: OwnerId, pageId: string, messageId: string) => Promise<AiMessageChange[] | null>;
  undone: (owner: OwnerId, messageId: string, pageIds: readonly string[]) => Promise<number>;
};

export type ChatUsageStore = {
  /** 経路ごとの合計（既定はサーバーの API＝月の上限が効く方）。 */
  get: (owner: OwnerId, month: string, source?: AiUsageSource) => Promise<AiUsageTotals>;
  record: (owner: OwnerId, month: string, delta: AiUsageDelta, source?: AiUsageSource) => Promise<AiUsageTotals>;
};

export type ChatApiDeps = {
  auth: () => AuthProvider;
  store: () => ChatPagesStore | null;
  conversations: () => ChatConversationStore | null;
  usage: () => ChatUsageStore | null;
  /** 道具つきの往復ができるモデル（無効なら 503 `ai_unavailable`）。 */
  ai: () => AiComposeBackend | null;
  limitUsd: () => number | null;
  settings?: () => ((owner: OwnerId) => Promise<EditorSettings>) | null;
  now?: () => Date;
  env?: Readonly<Record<string, string | undefined>>;
};

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function usageDelta(backend: AiComposeBackend, usage: AiUsageReport): AiUsageDelta {
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  const usd = backend.provider ? estimateTokenCostUsd(backend.provider, usage.model, inputTokens, outputTokens) : null;
  return { requests: 1, inputTokens, outputTokens, costMicroUsd: usd === null ? 0 : count(Math.round(usd * 1e6)) };
}

function overLimit(totals: AiUsageTotals, limitUsd: number | null): boolean {
  return limitUsd !== null && totals.costMicroUsd >= Math.round(limitUsd * 1e6);
}

async function guarded(route: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    console.error("editor-web: request failed", { route, name });
    return errorResponse("internal");
  }
}

/**
 * 会話への記録は、**ページを書き換えたあとのおまけ**。ここで失敗しても応答は壊さない
 * （書いた分と版は既に残っている。500 を返すと、ページが変わったのに失敗に見える）。
 * ログに出すのは route と失敗の名前だけ。
 */
async function recorded<T>(route: string, work: () => Promise<T | null>): Promise<T | null> {
  try {
    const result = await work();
    if (result === null) console.error("editor-web: chat turn not recorded", { route });
    return result;
  } catch (error) {
    console.error("editor-web: chat turn not recorded", { route, name: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** 道具の結果の JSON（モデルが読む。短く、内部の情報を入れない）。 */
function toolJson(value: unknown): string {
  return JSON.stringify(value);
}

const PAGE_HAS_PARTS = "このページの本文には、文字だけにできないもの（画像・録音）が入っています。この会話では直せません。";
/** 読んだ版（base_revision）が今の版と違う（AI は読み直して書き直せる）。 */
const PAGE_CHANGED = "本文が変わっています。read_page で読み直してください。";
/** search_transcript が返す一致の数の上限（それより多い分は数だけ返す）。 */
const TRANSCRIPT_MATCHES_MAX = 20;
/** search_transcript の一致の前後に付ける文字数。 */
const TRANSCRIPT_CONTEXT_CHARS = 200;

/**
 * 道具を実行する側。触れるのは作業場のページだけで、書いたページは `changes` に積む
 * （版は依頼の中で最初に書いたときのものを残す＝依頼の前の本文に戻せる）。
 */
type WorkspaceEntry = ChatWorkspacePage & { writable: boolean };

/**
 * AI が足した語だけに `ai` mark を付けた本文（ai/block-diff.ts）。付けた結果が保存の検査を通らなければ
 * （大きさの上限など）、`ai` 無しの本文をそのまま使う（安全側。印が無くても本文は同じ）。
 */
function withAiMarks(before: readonly Block[], after: Block[]): Block[] {
  const marked = parseBlocks(markAiInserted(before, after));
  return marked.ok ? marked.value : after;
}

function charsOf(blocks: readonly Block[]): number {
  return blocks.reduce((total, block) => total + Array.from(blockText(block)).length, 0);
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** 秒 → `hh:mm:ss`（切り捨て）。 */
function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60].map((part) => String(part).padStart(2, "0")).join(":");
}

/** 直した段落の番号（1 始まり。直した・消した段落は書く前の番号、足した段落は書いたあとの番号）。 */
function changedParagraphs(before: readonly Block[], after: readonly Block[]): number[] {
  const numbers = new Set<number>();
  for (const hunk of diffBlocks(before, after)) numbers.add((hunk.kind === "inserted" ? hunk.afterIndex : hunk.beforeIndex) + 1);
  return [...numbers].sort((a, b) => a - b);
}

/** `find` が `text` に一致する位置（重なりも数える）。2 つ見つかったら打ち切る。 */
function matchesOf(text: string, find: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(find); at >= 0 && found.length < 2; at = text.indexOf(find, at + 1)) found.push(at);
  return found;
}

/**
 * 部分置換（edit_page）の材料: 段落（ブロック）ごとの Markdown（read_page が返すのと同じ形）と、それを空行でつないだ本文。
 * `find` はつないだ本文で探し、**一致した段落だけ**を Markdown から組み直す。ほかの段落は元のブロックをそのまま保つ
 * （本文の全体を Markdown に書き出して読み直すと、空の段落や段落末尾の改行（hardBreak）が落ち、頼んでいない段落まで変わる）。
 * 書き出せないブロック（画像・録音など）があれば null。
 */
function paragraphsOf(blocks: readonly Block[]): { parts: string[]; joined: string } | null {
  const parts: string[] = [];
  for (const block of blocks) {
    const one = blocksToMarkdown([block]);
    if (!one.ok) return null;
    parts.push(one.markdown.replace(/\n+$/u, ""));
  }
  return { parts, joined: parts.join("\n\n") };
}

/**
 * つないだ本文の中の位置 `at` から `length` 字が掛かる段落の範囲（添字は 0 始まり、両端を含む）と、先頭の段落の開始位置。
 * 段落と段落の間の空行（2 字）は、前の段落に付けて数える（どの位置もちょうど 1 つの段落に落ちる）。
 */
function paragraphRange(parts: readonly string[], at: number, length: number): { from: number; to: number; start: number } {
  const last = Math.max(0, at + length - 1);
  let from = 0;
  let to = 0;
  let start = 0;
  for (let index = 0, offset = 0; index < parts.length; index++) {
    const next = offset + parts[index]!.length + 2;
    if (at >= offset && (at < next || index === parts.length - 1)) {
      from = index;
      start = offset;
    }
    if (last >= offset && (last < next || index === parts.length - 1)) to = index;
    offset = next;
  }
  return { from, to: Math.max(from, to), start };
}

type TranscriptMatch = { page_id: string; title: string; time: string | null; speaker: string | null; before: string; match: string; after: string };

/** 録音の文字起こしの中を語句で探す（大文字・小文字は区別しない）。 */
function searchRecording(page: { id: string; title: string }, recording: Recording, query: string, room: number): { total: number; matches: TranscriptMatch[] } {
  const offsets: number[] = [];
  let text = "";
  for (const segment of recording.segments) {
    if (text.length > 0) text += "\n";
    offsets.push(text.length);
    text += segment.text;
  }
  const lower = text.toLowerCase();
  // 小文字にして長さが変わる文字があるときは、そのまま探す（位置がずれないように）
  const [hay, needle] = lower.length === text.length ? [lower, query.toLowerCase()] : [text, query];
  const matches: TranscriptMatch[] = [];
  let total = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
    total += 1;
    if (matches.length >= room) continue;
    let index = 0;
    while (index + 1 < offsets.length && offsets[index + 1]! <= at) index += 1;
    const segment = recording.segments[index]!;
    const speaker = segment.speaker === null ? null : recording.speakerNames[String(segment.speaker)]?.trim() || `話者 ${segment.speaker}`;
    matches.push({
      page_id: page.id,
      title: page.title || "（題名なし）",
      time: segment.start === null ? null : clock(segment.start),
      speaker,
      before: Array.from(text.slice(0, at)).slice(-TRANSCRIPT_CONTEXT_CHARS).join(""),
      match: text.slice(at, at + needle.length),
      after: Array.from(text.slice(at + needle.length)).slice(0, TRANSCRIPT_CONTEXT_CHARS).join(""),
    });
  }
  return { total, matches };
}

function createToolRunner(deps: {
  store: ChatPagesStore;
  owner: OwnerId;
  workspace: WorkspaceEntry[];
  changes: Map<string, ChatChangeInput & { title: string }>;
  /** 録音の文字起こし（search_transcript）。渡さなければ探せない。 */
  recording?: ChatConversationStore["recording"];
  /**
   * Device turns save against the revision the CLI actually read. The Mac CLI write-back has no `base_revision`
   * in its input, so this map is its base (unchanged from before #278).
   */
  deviceRevisions?: ReadonlyMap<string, number>;
}): (call: { name: string; input: unknown }) => Promise<ToolOutcome & { conflict?: true }> {
  const { store, owner } = deps;
  const find = (id: unknown) => (typeof id === "string" ? deps.workspace.find((page) => page.id === id) : undefined);

  /**
   * 書き込みの共通の道（write_page・edit_page）: 読んだ版の確認 → 本文の検査 → 版を残す → 保存 → `changes` に積む。
   * `next` は書いたあとの本文の全体（Markdown）。
   */
  const commit = async (
    target: WorkspaceEntry,
    current: Page,
    before: string,
    next: string,
    blocks: { value: Block[] },
    base: number,
    device: boolean,
  ): Promise<{ ok: false; outcome: ToolOutcome & { conflict?: true } } | { ok: true; saved: Page; blocks: Block[]; chars: number; delta: number }> => {
    // 書く前の本文を版に残す（人が元に戻せる）
    const version = await store.createVersion(owner, target.id, "ai");
    if (!version) return { ok: false, outcome: { ok: false, result: "そのページはもうありません。", page: current.title } };
    const saved = await store.savePage(owner, target.id, { blocks: withAiMarks(current.blocks, blocks.value) }, { baseRevision: base });
    if (!saved) return { ok: false, outcome: { ok: false, result: "そのページはもうありません。", page: current.title } };
    if (saved.status === "page_full") return { ok: false, outcome: { ok: false, result: "ページ全体の30 MiB上限を超えるため保存できませんでした。本文や画像を減らしてください。", page: current.title } };
    if (saved.status !== "saved") {
      return { ok: false, outcome: { ok: false, result: device ? "別の画面で保存されたので書けませんでした。read_page で読み直してください。" : PAGE_CHANGED, page: current.title, conflict: true } };
    }
    const chars = Array.from(next).length;
    const delta = chars - Array.from(before).length;
    const existing = deps.changes.get(target.id);
    deps.changes.set(target.id, {
      pageId: target.id,
      title: current.title,
      change: existing?.change ?? "edited",
      // 版は依頼の中で最初に書いたときのもの（依頼の前の本文）
      version: existing?.version ?? version.version,
      revision: saved.page.revision,
      chars,
      delta: existing ? existing.delta + delta : delta,
    });
    return { ok: true, saved: saved.page, blocks: blocks.value, chars, delta };
  };

  /** 書いたあとの本文（Markdown）を保存できる blocks にする。 */
  const parseNext = (next: string, title: string): { ok: true; value: Block[] } | { ok: false; outcome: ToolOutcome } => {
    // AI は記事の先頭に `#` の題名を付けがちなので、見出しの段階は 2・3 にそろえる（画像などの対応外は断る）
    const parsed = markdownToBlocks(next, { headings: "clamp" });
    if (!parsed.ok) return { ok: false, outcome: { ok: false, result: `本文を読めませんでした: ${parsed.reason}`, page: title } };
    const blocks = parseBlocks(parsed.blocks);
    if (!blocks.ok) return { ok: false, outcome: { ok: false, result: "本文が大きすぎるか、保存できない形です。", page: title } };
    return { ok: true, value: blocks.value };
  };

  /** 書き込みの前の確認（作業場・書けるか・読んだ版）。通れば今のページと本文の Markdown。 */
  const prepareWrite = async (
    input: Record<string, unknown>,
  ): Promise<{ ok: false; outcome: ToolOutcome & { conflict?: true } } | { ok: true; target: WorkspaceEntry; current: Page; before: string; base: number; device: boolean }> => {
    const target = find(input.page_id);
    if (!target) return { ok: false, outcome: { ok: false, result: "そのページは、この会話では書けません。list_pages の id を使ってください。" } };
    if (!target.writable) return { ok: false, outcome: { ok: false, result: "そのページは読むだけです（同じフォルダのほかのページ）。書けるのは開いているページとその親・サブページだけです。", page: target.title } };
    const deviceRevision = deps.deviceRevisions?.get(target.id);
    const device = deviceRevision !== undefined;
    // Mac CLI の書き戻しは base_revision を持たない（CLI が読んだ版＝deviceRevisions が前提）
    const base = deviceRevision ?? (isRevision(input.base_revision) ? input.base_revision : undefined);
    if (base === undefined) return { ok: false, outcome: { ok: false, result: "base_revision に、read_page で返った revision を渡してください。", page: target.title } };
    const current = await store.getPage(owner, target.id);
    if (!current) return { ok: false, outcome: { ok: false, result: "そのページはもうありません。", page: target.title } };
    if (current.revision !== base) {
      return { ok: false, outcome: { ok: false, result: device ? "別の画面で保存されたので書けませんでした。" : PAGE_CHANGED, page: current.title, conflict: true } };
    }
    const before = blocksToMarkdown(current.blocks);
    if (!before.ok) return { ok: false, outcome: { ok: false, result: PAGE_HAS_PARTS, page: current.title } };
    return { ok: true, target, current, before: before.markdown, base, device };
  };

  return async (call: { name: string; input: unknown }) => {
    const input = isPlainObject(call.input) ? call.input : {};
    if (!isChatToolName(call.name)) return { ok: false, result: "その道具はありません。" };

    if (call.name === "list_pages") {
      const pages = [];
      for (const page of deps.workspace) {
        const current = await store.getPage(owner, page.id);
        if (!current) continue;
        pages.push({ id: page.id, title: page.title || "（題名なし）", kind: page.kind, open: page.open, writable: page.writable, chars: charsOf(current.blocks), revision: current.revision });
      }
      return { ok: true, result: toolJson({ pages }) };
    }

    if (call.name === "read_page") {
      const target = find(input.page_id);
      if (!target) return { ok: false, result: "そのページは、この会話では開けません。list_pages の id を使ってください。" };
      const page = await store.getPage(owner, target.id);
      if (!page) return { ok: false, result: "そのページはもうありません。", page: target.title };
      const markdown = blocksToMarkdown(page.blocks);
      if (!markdown.ok) return { ok: false, result: PAGE_HAS_PARTS, page: page.title };
      const total = page.blocks.length;
      for (const key of ["from", "to"] as const) {
        if (input[key] !== undefined && !isRevision(input[key])) return { ok: false, result: `${key} には 1 以上の段落の番号を渡してください。`, page: page.title };
      }
      const ranged = input.from !== undefined || input.to !== undefined;
      const from = isRevision(input.from) ? input.from : 1;
      const to = isRevision(input.to) ? input.to : total;
      if (ranged && isRevision(input.from) && isRevision(input.to) && from > to) {
        return { ok: false, result: `from（${from}）は to（${to}）以下にしてください。`, page: page.title };
      }
      if (ranged && (from > total || to > total)) return { ok: false, result: `範囲が本文の外です。この本文は ${total} 段落です。`, page: page.title };
      const paragraphs = [];
      for (let index = from - 1; index < to; index++) {
        const one = blocksToMarkdown([page.blocks[index]!]);
        if (!one.ok) return { ok: false, result: PAGE_HAS_PARTS, page: page.title };
        paragraphs.push({ n: index + 1, markdown: one.markdown.replace(/\n+$/u, "") });
      }
      return { ok: true, result: toolJson({ id: page.id, title: page.title, revision: page.revision, total, from: Math.min(from, total), to, paragraphs }), page: page.title };
    }

    if (call.name === "edit_page") {
      if (typeof input.find !== "string" || input.find.length === 0) return { ok: false, result: "find に、本文の中の置き換える文字列を渡してください。" };
      if (typeof input.replace !== "string") return { ok: false, result: "replace に、置き換えたあとの文字列を渡してください。" };
      const ready = await prepareWrite(input);
      if (!ready.ok) return ready.outcome;
      // 段落ごとの Markdown で探し、一致した段落だけを組み直す（ほかの段落は元のブロックのまま）
      const paragraphsNow = paragraphsOf(ready.current.blocks);
      if (!paragraphsNow) return { ok: false, result: PAGE_HAS_PARTS, page: ready.current.title };
      const found = matchesOf(paragraphsNow.joined, input.find);
      if (found.length === 0) {
        return { ok: false, result: "find が本文に見つかりませんでした（0 か所）。read_page で今の本文を読み、そのとおりに写してください。", page: ready.current.title };
      }
      if (found.length > 1) {
        return { ok: false, result: "find が本文の 2 か所以上に一致しました。1 か所に決まるよう、前後を含めてもっと長く指定してください。", page: ready.current.title };
      }
      const at = found[0]!;
      const range = paragraphRange(paragraphsNow.parts, at, input.find.length);
      const segment = paragraphsNow.parts.slice(range.from, range.to + 1).join("\n\n");
      const rel = at - range.start;
      const nextSegment = segment.slice(0, rel) + input.replace + segment.slice(rel + input.find.length);
      const replaced = parseNext(nextSegment, ready.current.title);
      if (!replaced.ok) return replaced.outcome;
      // 対象外の段落は元のブロックをそのまま継ぐ。ページ全体の大きさの上限はここで見る
      const checked = parseBlocks([...ready.current.blocks.slice(0, range.from), ...replaced.value, ...ready.current.blocks.slice(range.to + 1)]);
      if (!checked.ok) return { ok: false, result: "本文が大きすぎるか、保存できない形です。", page: ready.current.title };
      const next = [...paragraphsNow.parts.slice(0, range.from), nextSegment, ...paragraphsNow.parts.slice(range.to + 1)].join("\n\n");
      const written = await commit(ready.target, ready.current, paragraphsNow.joined, next, { value: checked.value }, ready.base, ready.device);
      if (!written.ok) return written.outcome;
      const paragraphs = changedParagraphs(ready.current.blocks, written.blocks);
      return {
        ok: true,
        result: toolJson({ id: ready.target.id, revision: written.saved.revision, paragraphs, chars: written.chars, delta: written.delta }),
        page: ready.current.title,
        detail: `${paragraphLabel(paragraphs)}を直しました`,
        paragraphs,
      };
    }

    if (call.name === "write_page") {
      // 確かめる順は #278 の前と同じ（作業場 → 書けるか → 本文の形 → 読んだ版。Mac CLI の書き戻しの結果を変えない）
      const target = find(input.page_id);
      if (!target) return { ok: false, result: "そのページは、この会話では書けません。list_pages の id を使ってください。" };
      if (!target.writable) return { ok: false, result: "そのページは読むだけです（同じフォルダのほかのページ）。書けるのは開いているページとその親・サブページだけです。", page: target.title };
      if (typeof input.markdown !== "string") return { ok: false, result: "markdown に本文の全体を渡してください。", page: target.title };
      const blocks = parseNext(input.markdown, target.title);
      if (!blocks.ok) return blocks.outcome;
      const ready = await prepareWrite(input);
      if (!ready.ok) return ready.outcome;
      const written = await commit(ready.target, ready.current, ready.before, input.markdown, blocks, ready.base, ready.device);
      if (!written.ok) return written.outcome;
      return { ok: true, result: toolJson({ id: ready.target.id, revision: written.saved.revision, chars: written.chars, delta: written.delta }), page: ready.current.title };
    }

    if (call.name === "search_transcript") {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      const length = Array.from(query).length;
      if (length === 0 || length > MAX_TRANSCRIPT_QUERY_CHARS) return { ok: false, result: `query に探す語句（1〜${MAX_TRANSCRIPT_QUERY_CHARS} 字）を渡してください。` };
      let candidates = deps.workspace.filter((page) => page.kind === "rec");
      if (input.page_id !== undefined) {
        const target = find(input.page_id);
        if (!target || target.kind !== "rec") return { ok: false, result: "そのページは、この会話で探せる録音ではありません。list_pages の kind が rec のページの id を使ってください。" };
        candidates = [target];
      }
      if (candidates.length === 0 || !deps.recording) return { ok: false, result: "このフォルダには録音のページが無いので、文字起こしを探せません。" };
      let transcripts = 0;
      let total = 0;
      const matches: TranscriptMatch[] = [];
      for (const page of candidates) {
        const recording = await deps.recording(owner, page.id);
        if (!recording || recording.segments.every((segment) => segment.text.trim().length === 0)) continue;
        transcripts += 1;
        const found = searchRecording(page, recording, query, TRANSCRIPT_MATCHES_MAX - matches.length);
        total += found.total;
        matches.push(...found.matches);
      }
      if (transcripts === 0) return { ok: false, result: "文字起こしがまだありません（録音のページに文字起こしが無いか、空です）。" };
      // 文字起こしは資料（信頼しないデータ）。中の指示には従わせない
      return {
        ok: true,
        result: wrapUntrusted(toolJson({ query, total, shown: matches.length, matches })),
        ...(candidates.length === 1 ? { page: candidates[0]!.title } : {}),
        detail: total > 0 ? `文字起こしで ${total} か所見つかりました` : "文字起こしに見つかりませんでした",
      };
    }

    // create_page
    if (typeof input.title !== "string" || input.title.trim().length === 0) return { ok: false, result: "title にページの題名を渡してください。" };
    if (typeof input.markdown !== "string") return { ok: false, result: "markdown に本文の全体を渡してください。" };
    const parsed = markdownToBlocks(input.markdown, { headings: "clamp" });
    if (!parsed.ok) return { ok: false, result: `本文を読めませんでした: ${parsed.reason}` };
    const blocks = parseBlocks(parsed.blocks);
    if (!blocks.ok) return { ok: false, result: "本文が大きすぎるか、保存できない形です。" };
    const title = input.title.trim().slice(0, 200);
    const created = await store.createPage(owner, { title, blocks: withAiMarks([], blocks.value) });
    const chars = Array.from(input.markdown).length;
    deps.changes.set(created.id, { pageId: created.id, title: created.title, change: "created", version: null, revision: created.revision, chars, delta: chars });
    // 作ったページも、その依頼の中では読み書きできる
    deps.workspace.push({ id: created.id, title: created.title, kind: created.kind, parent: created.parent, open: false, writable: true });
    return { ok: true, result: toolJson({ id: created.id, title: created.title, revision: created.revision, chars }), page: created.title };
  };
}

type ChatInput = { text: string; conversationId: string | null };

function parseChatBody(body: unknown): { ok: true; value: ChatInput } | { ok: false } {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["text", "conversationId"])) return { ok: false };
  if (typeof body.text !== "string") return { ok: false };
  const text = body.text.trim();
  const length = Array.from(text).length;
  if (length === 0 || length > MAX_CHAT_INPUT_CHARS || text.includes("\u0000")) return { ok: false };
  if (body.conversationId !== undefined && body.conversationId !== null && typeof body.conversationId !== "string") return { ok: false };
  return { ok: true, value: { text, conversationId: typeof body.conversationId === "string" ? body.conversationId : null } };
}

/** 会話の記録から、モデルに渡す過去のやりとり（人の指示と AI の返答だけ）。 */
function historyOf(messages: readonly AiMessage[]): ChatHistoryTurn[] {
  return messages.filter((message) => message.text.length > 0).map((message) => ({ role: message.role, text: message.text }));
}

/** 画面に出す作業の要約（道具の名前はそのまま、ページの名前は今の題名）。 */
function itemsOf(run: ChatRun): ChatItem[] {
  return run.items;
}

/**
 * POST /api/pages/{id}/ai/chat — AI チャットの 1 回の依頼。モデルが道具でページを読み書きし、
 * 書いた分は版に残る。会話には指示・作業の要約・返答・直したページが残る。
 * 上限以上ならモデルを呼ばずに 429。未認証は 401、他人のページ・無いページは同じ 404。
 */
export function runAiChat(request: Request, id: string, deps: ChatApiDeps): Promise<Response> {
  const route = "POST /api/pages/[id]/ai/chat";
  return guarded(route, async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    const chats = deps.conversations();
    const usage = deps.usage();
    if (!store || !chats || !usage) return errorResponse("unavailable");
    const backend = deps.ai();
    if (!backend) return jsonResponse(503, { error: "ai_unavailable" });
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = parseChatBody(body.value);
    if (!input.ok) return errorResponse("bad_request");

    const owner = session.userId;
    const writable = await chats.workspace(owner, id);
    if (!writable) return notFoundResponse();
    const open = writable.find((page) => page.open)!;
    // 同じフォルダのほかのページは読むだけで触れる（旧アプリの「フォルダ内の他ページを見る」）
    const readable = (await chats.references?.(owner, id)) ?? [];
    const known = new Set(writable.map((page) => page.id));
    const workspace: WorkspaceEntry[] = [
      ...writable.map((page) => ({ ...page, writable: true })),
      ...readable
        .filter((page) => !known.has(page.id))
        .map((page) => ({ id: page.id, title: page.title, kind: page.kind, parent: open.parent, open: false, writable: false })),
    ];
    const conversationId = input.value.conversationId;
    const past = conversationId === null ? null : await chats.history(owner, id, conversationId);
    if (conversationId !== null && !past) return notFoundResponse();

    const month = monthKeyJst(deps.now ? deps.now() : new Date());
    const limitUsd = deps.limitUsd();
    // 月の上限はサーバーの API の経路にだけ効く
    if (backend.route === "server" && overLimit(await usage.get(owner, month), limitUsd)) return jsonResponse(429, { error: "quota_exceeded" });

    const settings = (await deps.settings?.()?.(owner)) ?? DEFAULT_EDITOR_SETTINGS;
    // 開いているのが録音ページなら「この録音について」（背景・登場人物・固有名詞）も指示の文脈に入れる（AI の欄の「読むもの」と同じ）
    const recordingInfo = open.kind === "rec" && chats.fields ? await chats.fields(owner, open.id) : null;
    const respond = async (onEvent?: (event: ChatEvent) => void): Promise<unknown> => {
      const changes = new Map<string, ChatChangeInput & { title: string }>();
      const run = await runChatTurn({
        client: backend.client,
        system: buildChatSystem({
          glossary: settings.glossary,
          about: { name: settings.aboutName, text: settings.about },
          ...(settings.aiLang === "same" ? {} : { lang: settings.aiLang }),
          ...(recordingInfo ? { recording: recordingInfo } : {}),
        }),
        messages: buildChatMessages(historyOf(past?.messages ?? []), input.value.text, { id: open.id, title: open.title, kind: open.kind }),
        run: createToolRunner({ store, owner, workspace, changes, ...(chats.recording ? { recording: chats.recording } : {}) }),
        // 往復のたびに上限を見る（会話が長くても 1 人 1 か月の上限は同じ意味で働く）
        // 上限を見るのはサーバーの API の経路だけ（CLI は利用者のサブスクで従量が出ないので止めない）
        beforeCall: async () => backend.route !== "server" || !overLimit(await usage.get(owner, month), limitUsd),
        onUsage: async (report) => {
          await usage.record(owner, month, usageDelta(backend, report), backend.route);
        },
        signal: request.signal,
        ...(onEvent ? { onEvent } : {}),
      });

      const written = [...changes.values()];
      const turn = await recorded(route, () =>
        chats.append(owner, {
          pageId: id,
          conversationId,
          input: input.value.text,
          reply: run.reply,
          items: itemsOf(run),
          result: run.result,
          resultCode: run.code,
          author: { route: backend.route, engine: backend.engine },
          changes: written.map((change) => ({
            pageId: change.pageId,
            change: change.change,
            version: change.version ?? null,
            revision: change.revision,
            chars: change.chars,
            delta: change.delta,
          })),
        }),
      );
      // 開いているページが変わっていれば、画面に載せ替えるために今の本文を返す
      const page = written.some((change) => change.pageId === id) ? await store.getPage(owner, id) : null;
      const totals = await usage.get(owner, month);
      return {
        conversation: turn ? { id: turn.conversation.id, messageId: turn.result.id } : null,
        message: turn
          ? turn.result
          : { id: null, role: "assistant", text: run.reply, items: run.items, result: run.result, resultCode: run.code, changes: [] },
        page,
        usage: {
          month,
          costUsd: totals.costMicroUsd / 1e6,
          limitUsd,
          nearLimit: limitUsd !== null && totals.costMicroUsd * 5 >= Math.round(limitUsd * 1e6) * 4,
        },
      };
    };

    // 画面が `Accept: text/event-stream` で頼んだときだけ、途中の文と道具を流す（最後の done は 200 の JSON と同じ本文）
    if (wantsEventStream(request)) return chatEventStream(route, request.signal, respond);
    return jsonResponse(200, await respond());
  });
}

/** SSE の ping の間隔（途中の proxy に切られないように）。 */
export const CHAT_STREAM_PING_MS = 15_000;

function wantsEventStream(request: Request): boolean {
  return (request.headers.get("accept") ?? "").toLowerCase().includes("text/event-stream");
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * AI チャットの SSE の応答。`text`（文の差分）・`tool`（道具の前後）を流し、終わりに `done`（200 の JSON と同じ本文）。
 * 途中の例外は `error`（`{"error":"internal"}`。ログは route と失敗の名前だけ）。依頼の中断（request.signal）で止める。
 */
function chatEventStream(route: string, signal: AbortSignal, work: (onEvent: (event: ChatEvent) => void) => Promise<unknown>): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let ping: ReturnType<typeof setInterval> | undefined;
  let stop: () => void = () => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const onAbort = () => stop();
      stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // もう閉じている
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      ping = setInterval(() => write(": ping\n\n"), CHAT_STREAM_PING_MS);
      void (async () => {
        try {
          const body = await work((event) => {
            if (event.type === "text") write(sseEvent("text", { text: event.text }));
            else write(sseEvent("tool", { tool: event.tool, page: event.page, ok: event.ok, phase: event.phase, ...(event.detail ? { detail: event.detail } : {}) }));
          });
          write(sseEvent("done", body));
        } catch (error) {
          if (!signal.aborted) {
            console.error("editor-web: request failed", { route, name: error instanceof Error ? error.name : "unknown" });
            write(sseEvent("error", { error: "internal" }));
          }
        } finally {
          stop();
        }
      })();
    },
    cancel() {
      closed = true;
      clearInterval(ping);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}

/** この Mac の CLI が書き戻してくる依頼（`POST …/ai/chat/turns`）。 */
type DeviceTurnInput = {
  conversationId: string | null;
  input: string;
  reply: string;
  engine: string;
  writes: { pageId: string; markdown: string; baseRevision: number }[];
};

/**
 * CLI の書き戻しで受けるページの数の上限。#278 で道具の上限（MAX_CHAT_TOOL_CALLS）を 12 → 40 に上げたが、
 * Mac CLI の経路は変えないので、前と同じ 12 のまま固定する。
 */
const MAX_DEVICE_TURN_WRITES = 12;

/** エンジンの短い id（鍵・端末の情報を入れない）。 */
const ENGINE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,95}$/;

function parseDeviceTurnBody(body: unknown): { ok: true; value: DeviceTurnInput } | { ok: false } {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["conversationId", "input", "reply", "engine", "writes"])) return { ok: false };
  const text = parseChatBody({ text: body.input, ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }) });
  if (!text.ok) return { ok: false };
  if (typeof body.engine !== "string" || !ENGINE_PATTERN.test(body.engine)) return { ok: false };
  if (body.reply !== undefined && typeof body.reply !== "string") return { ok: false };
  const reply = typeof body.reply === "string" ? body.reply.trim() : "";
  if (Array.from(reply).length > MESSAGE_TEXT_MAX_CHARS) return { ok: false };
  if (!Array.isArray(body.writes) || body.writes.length > MAX_DEVICE_TURN_WRITES) return { ok: false };
  const writes: DeviceTurnInput["writes"] = [];
  for (const raw of body.writes) {
    if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["pageId", "markdown", "baseRevision"])) return { ok: false };
    if (typeof raw.pageId !== "string" || typeof raw.markdown !== "string" || typeof raw.baseRevision !== "number" || !Number.isSafeInteger(raw.baseRevision) || raw.baseRevision < 1) return { ok: false };
    if (writes.some((write) => write.pageId === raw.pageId)) return { ok: false };
    writes.push({ pageId: raw.pageId, markdown: raw.markdown, baseRevision: raw.baseRevision });
  }
  return { ok: true, value: { conversationId: text.value.conversationId, input: text.value.text, reply, engine: body.engine, writes } };
}

/**
 * POST /api/pages/{id}/ai/chat/turns — **この Mac の CLI（利用者のサブスク）が作った結果を書き戻す口**。
 * サーバーはモデルを呼ばず、受け取った本文を**チャットと同じ道**に通す（作業場の確認 → 版を残す → 保存 → 会話に記録）。
 * これで版・「元に戻す」・触れる範囲・本文の検査が経路によらず同じになる。
 *
 * **月の上限（USD）は効かない**（従量が出ないため）。使用量は `device` の行にだけ、回数として残る。
 * 未認証は 401、他人のページ・無いページ・他人の会話は同じ 404。
 */
export function recordDeviceChatTurn(request: Request, id: string, deps: ChatApiDeps): Promise<Response> {
  const route = "POST /api/pages/[id]/ai/chat/turns";
  return guarded(route, async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    const chats = deps.conversations();
    const usage = deps.usage();
    if (!store || !chats || !usage) return errorResponse("unavailable");
    const body = await readJsonBody(request, PAGE_BODY_MAX_BYTES);
    if (!body.ok) return body.response;
    const input = parseDeviceTurnBody(body.value);
    if (!input.ok) return errorResponse("bad_request");

    const owner = session.userId;
    const writable = await chats.workspace(owner, id);
    if (!writable) return notFoundResponse();
    const conversationId = input.value.conversationId;
    if (conversationId !== null && !(await chats.history(owner, id, conversationId))) return notFoundResponse();
    const currentWrite = input.value.writes.find((write) => write.pageId === id);
    if (currentWrite) {
      const currentPage = await store.getPage(owner, id);
      if (!currentPage) return notFoundResponse();
      if (currentPage.revision !== currentWrite.baseRevision) return conflictResponse(currentPage);
    }

    // 書き込みはチャットと同じ道具を通す（作業場の外・画像のあるページ・大きすぎる本文はここで断られる）
    const changes = new Map<string, ChatChangeInput & { title: string }>();
    const workspace: WorkspaceEntry[] = writable.map((page) => ({ ...page, writable: true }));
    const run = createToolRunner({ store, owner, workspace, changes, deviceRevisions: new Map(input.value.writes.map((write) => [write.pageId, write.baseRevision])) });
    const items: ChatItem[] = [];
    let failed = false;
    let revisionConflict = false;
    for (const write of input.value.writes) {
      const outcome = await run({ name: "write_page", input: { page_id: write.pageId, markdown: write.markdown } });
      items.push({ kind: "tool", tool: "write_page", page: outcome.page ?? null, ok: outcome.ok });
      if (!outcome.ok) failed = true;
      if ("conflict" in outcome && outcome.conflict === true) revisionConflict = true;
    }

    const written = [...changes.values()];
    const turn = await recorded(route, () =>
      chats.append(owner, {
        pageId: id,
        conversationId,
        input: input.value.input,
        reply: input.value.reply,
        items,
        result: failed ? "stopped" : "done",
        resultCode: revisionConflict ? "revision_conflict" : failed ? "write_refused" : null,
        author: { route: "device", engine: input.value.engine },
        changes: written.map((change) => ({
          pageId: change.pageId,
          change: change.change,
          version: change.version ?? null,
          revision: change.revision,
          chars: change.chars,
          delta: change.delta,
        })),
      }),
    );
    // 回数だけ数える（この Mac の CLI は利用者のサブスクなので金額は 0。月の上限では止めない）。
    // ここも書いたあとのおまけなので、失敗しても応答は壊さない
    await recorded(route, async () => {
      await usage.record(owner, monthKeyJst(deps.now ? deps.now() : new Date()), { requests: 1, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 }, "device");
      return true;
    });
    const page = written.some((change) => change.pageId === id) ? await store.getPage(owner, id) : null;
    return jsonResponse(200, {
      conversation: turn ? { id: turn.conversation.id, messageId: turn.result.id } : null,
      message: turn ? turn.result : null,
      page,
    });
  });
}

/**
 * POST /api/pages/{id}/ai/chat/{messageId}/undo — その依頼で書いた分を元に戻す。
 * 直したページは依頼の前の版に戻し、作ったページはゴミ箱へ入れる（30 日は戻せる）。
 * 既に戻したもの・人が後から直したページは、そのままにして結果に理由を出す。
 */
export function undoAiChat(request: Request, id: string, messageId: string, deps: ChatApiDeps): Promise<Response> {
  const route = "POST /api/pages/[id]/ai/chat/[messageId]/undo";
  return guarded(route, async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    const chats = deps.conversations();
    if (!store || !chats) return errorResponse("unavailable");
    const owner = session.userId;
    const changes = await chats.changes(owner, id, messageId);
    if (!changes) return notFoundResponse();

    const undone: string[] = [];
    const kept: { pageId: string; reason: "gone" | "changed" | "published" }[] = [];
    for (const change of changes) {
      const now = await store.getPage(owner, change.pageId);
      // 依頼のあとに人が直したページは、そのままにする（人の直しを消さない）
      if (now && now.revision !== change.revision) {
        kept.push({ pageId: change.pageId, reason: "changed" });
        continue;
      }
      if (change.change === "created") {
        const deleted = await store.deletePage(owner, change.pageId);
        if (deleted === "deleted") undone.push(change.pageId);
        else kept.push({ pageId: change.pageId, reason: deleted === "published" ? "published" : "gone" });
        continue;
      }
      if (!now || change.version === null) {
        kept.push({ pageId: change.pageId, reason: "gone" });
        continue;
      }
      const restored = await store.restoreVersion(owner, change.pageId, change.version, {
        baseRevision: now.revision,
        accept: (blocks) => {
          const parsed = parseBlocks(blocks);
          return parsed.ok ? parsed.value : null;
        },
      });
      if (restored?.status === "restored") undone.push(change.pageId);
      else kept.push({ pageId: change.pageId, reason: "changed" });
    }
    if (undone.length > 0) await chats.undone(owner, messageId, undone);
    const page = undone.includes(id) ? await store.getPage(owner, id) : null;
    return jsonResponse(200, { undone, kept, page });
  });
}
