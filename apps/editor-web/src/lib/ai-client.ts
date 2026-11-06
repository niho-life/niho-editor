/**
 * ブラウザから AI チャットと会話の API を呼ぶ（同じ origin。cookie・token は扱わない。モデルと鍵はサーバー側だけ）。
 * 契約はサーバー側の src/server/chat-api.ts（チャット）と src/server/ai-api.ts（会話の読み出し）。
 */

import type { ChatSelection } from "@/ai/chat-selection";
import { conflictPageOf, type ConflictPage } from "./pages-client";

/** 応答のページ（書いた結果・競合のときの今のページ）。 */
export type AiPage = ConflictPage;

/**
 * 失敗の分け方（画面の文言を選ぶ。本文・内部の情報は持たない）。
 * - `signedOut` 401・`quota` 429 quota_exceeded・`aiUnavailable` 503 ai_unavailable・`aiFailed` 502 ai_failed・
 *   `tooLarge` 413・`badRequest` 400・`network` 届かなかった・`aborted` 中止した・`failed` それ以外（形の違う応答も）。
 */
export type AiErrorCode = "signedOut" | "quota" | "aiUnavailable" | "aiFailed" | "tooLarge" | "badRequest" | "network" | "aborted" | "failed";

export class AiRequestError extends Error {
  override readonly name: string = "AiRequestError";
  constructor(readonly code: AiErrorCode) {
    super(`ai request failed: ${code}`);
  }
}

/** 頼んだ revision が今のページと違った（409）。何も保存されていない。`page` は今のページ。 */
export class AiConflictError extends Error {
  override readonly name: string = "AiConflictError";
  constructor(readonly page: AiPage) {
    super("ai request conflicted");
  }
}

/** 会話に残った 1 回のやりとり（会話の id と、その AI の発言の id。残せなかったときは null）。 */
export type AiTurnRef = { id: string; messageId: string };

/** 会話の 1 つの発言（画面に出す分だけ。提案の中身は履歴では開かない）。 */
export type AiChatMessage = {
  id: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  preset: string | null;
  /** 提案を伴う発言（AI の発言）。 */
  hasProposal: boolean;
  /** 採用の前の本文が残った版の番号（採用していなければ null）。 */
  version: number | null;
  /** AI チャットの依頼の結果（提案の発言は null）。 */
  result: "done" | "failed" | "stopped" | null;
  items: AiChatItem[];
  changes: AiChatChange[];
};

export type AiChatSummary = { id: string; updatedAt: string; messages: number; lastText: string | null };
export type AiChat = { conversation: AiChatSummary; messages: AiChatMessage[] };

/** AI が直した・作ったページ（1 回の依頼ごと）。 */
export type AiChatChange = {
  pageId: string;
  title: string;
  change: "edited" | "created";
  /** 直す前の本文が残った版の番号（作ったページ・古い記録は null）。「変更を見る」の前の本文。 */
  version: number | null;
  /** 依頼が書き終えたときの revision（あとで人が直したかを見る。古い記録は null）。 */
  revision: number | null;
  chars: number;
  delta: number;
  undoneAt: string | null;
};

/** AI チャットの 1 回の依頼の結果。 */
export type AiChatResult = {
  conversation: AiTurnRef | null;
  reply: string;
  items: AiChatItem[];
  result: "done" | "failed" | "stopped";
  resultCode: string | null;
  changes: AiChatChange[];
  /** 開いているページが変わったときの、今のページ（変わらなければ null）。 */
  page: AiPage | null;
  usage: { nearLimit: boolean };
};

export type DeviceChatWrite = { pageId: string; markdown: string; baseRevision: number };

/** 作業の 1 行（道具の名前とページの名前。edit_page は直した段落の番号も）。 */
export type AiChatItem = { kind: "narration"; text: string } | { kind: "tool"; tool: string; page: string | null; ok: boolean; paragraphs?: number[]; results?: number };

/** 「元に戻す」の結果。`kept` は戻さなかったページとその理由。 */
export type AiUndoResult = { undone: string[]; kept: { pageId: string; reason: string }[]; page: AiPage | null };

function codeOf(status: number, error: unknown): AiErrorCode {
  if (status === 401) return "signedOut";
  if (status === 429 && error === "quota_exceeded") return "quota";
  if (status === 503 && error === "ai_unavailable") return "aiUnavailable";
  if (status === 502 && error === "ai_failed") return "aiFailed";
  if (status === 413) return "tooLarge";
  if (status === 400) return "badRequest";
  return "failed";
}

function aborted(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError");
}

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw new AiRequestError(aborted(error, signal) ? "aborted" : "network");
  }
  return readResponse(response, signal);
}

/** POST の応答を読む（409 は競合、それ以外の失敗はステータスから code。本文は JSON）。 */
async function readResponse(response: Response, signal: AbortSignal | undefined): Promise<unknown> {
  try {
    if (response.status === 409) {
      const page = conflictPageOf(await response.json().catch(() => null));
      // 競合の形でない 409 はただの失敗として扱う
      throw page ? new AiConflictError(page) : new AiRequestError("failed");
    }
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw new AiRequestError(codeOf(response.status, data?.error));
    }
    return await response.json();
  } catch (error) {
    if (error instanceof AiRequestError || error instanceof AiConflictError) throw error;
    throw new AiRequestError(aborted(error, signal) ? "aborted" : "failed");
  }
}

function pagePath(id: string, suffix: string): string {
  return `/api/pages/${encodeURIComponent(id)}${suffix}`;
}

const isIndex = (value: unknown, min: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 会話の id と発言の id（形が違えば null。会話に残せなくても結果は使える）。 */
function turnRefOf(value: unknown): AiTurnRef | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.messageId !== "string") return null;
  return { id: value.id, messageId: value.messageId };
}

function chatItemOf(value: unknown): AiChatItem | null {
  if (!isRecord(value)) return null;
  if (value.kind === "narration" && typeof value.text === "string") return { kind: "narration", text: value.text };
  if (value.kind !== "tool" || typeof value.tool !== "string") return null;
  const paragraphs = Array.isArray(value.paragraphs) ? value.paragraphs.filter((n): n is number => isIndex(n, 1)).slice(0, 200) : [];
  // Web 検索（#283）は件数だけを持つ
  const results = isIndex(value.results, 0) ? value.results : null;
  return { kind: "tool", tool: value.tool, page: typeof value.page === "string" ? value.page : null, ok: value.ok === true, ...(paragraphs.length > 0 ? { paragraphs } : {}), ...(results === null ? {} : { results }) };
}

function chatItemsOf(value: unknown): AiChatItem[] {
  if (!Array.isArray(value)) return [];
  return value.map(chatItemOf).filter((item): item is AiChatItem => item !== null);
}

function chatChangeOf(value: unknown): AiChatChange | null {
  if (!isRecord(value) || typeof value.pageId !== "string") return null;
  if (value.change !== "edited" && value.change !== "created") return null;
  return {
    pageId: value.pageId,
    title: typeof value.title === "string" ? value.title : "",
    change: value.change,
    version: isIndex(value.version, 1) ? value.version : null,
    revision: isIndex(value.revision, 0) ? value.revision : null,
    chars: isIndex(value.chars, 0) ? value.chars : 0,
    delta: typeof value.delta === "number" && Number.isSafeInteger(value.delta) ? value.delta : 0,
    undoneAt: typeof value.undoneAt === "string" ? value.undoneAt : null,
  };
}

function chatChangesOf(value: unknown): AiChatChange[] {
  if (!Array.isArray(value)) return [];
  return value.map(chatChangeOf).filter((change): change is AiChatChange => change !== null);
}

function chatResultOf(value: unknown): AiChatMessage["result"] {
  return value === "done" || value === "failed" || value === "stopped" ? value : null;
}

function chatMessageOf(value: unknown): AiChatMessage | null {
  if (!isRecord(value) || typeof value.id !== "string" || !isIndex(value.seq, 1) || typeof value.text !== "string") return null;
  if (value.role !== "user" && value.role !== "assistant") return null;
  return {
    id: value.id,
    seq: value.seq,
    role: value.role,
    text: value.text,
    preset: typeof value.preset === "string" ? value.preset : null,
    hasProposal: isRecord(value.proposal),
    version: isIndex(value.version, 1) ? value.version : null,
    result: chatResultOf(value.result),
    items: chatItemsOf(value.items),
    changes: chatChangesOf(value.changes),
  };
}

function chatSummaryOf(value: unknown): AiChatSummary | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.updatedAt !== "string") return null;
  return {
    id: value.id,
    updatedAt: value.updatedAt,
    messages: isIndex(value.messages, 0) ? value.messages : 0,
    lastText: typeof value.lastText === "string" ? value.lastText : null,
  };
}

async function get(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...(signal ? { signal } : {}) });
  } catch (error) {
    throw new AiRequestError(aborted(error, signal) ? "aborted" : "network");
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new AiRequestError(codeOf(response.status, data?.error));
  }
  try {
    return await response.json();
  } catch (error) {
    throw new AiRequestError(aborted(error, signal) ? "aborted" : "failed");
  }
}

/** そのページの会話の一覧（新しい順）。 */
export async function listAiChats(pageId: string, options: { signal?: AbortSignal } = {}): Promise<AiChatSummary[]> {
  const data = await get(pagePath(pageId, "/ai/conversations"), options.signal);
  if (!isRecord(data) || !Array.isArray(data.conversations)) throw new AiRequestError("failed");
  const conversations = data.conversations.map(chatSummaryOf);
  if (conversations.some((item) => item === null)) throw new AiRequestError("failed");
  return conversations as AiChatSummary[];
}

/** Mac の CLI に渡す文脈の 1 ファイル（`context/<name>.md`）。サーバー経路が指示に入れる節と同じもの。 */
export type AiContextFile = { name: string; title: string; markdown: string };

const CONTEXT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Mac の CLI に渡す文脈（あなたについて・この録音について・文書ガイド・固有名詞。無いものは含まれない）。 */
export async function fetchAiChatContext(pageId: string, options: { signal?: AbortSignal } = {}): Promise<AiContextFile[]> {
  const data = await get(pagePath(pageId, "/ai/context"), options.signal);
  if (!isRecord(data) || !Array.isArray(data.context)) throw new AiRequestError("failed");
  const files: AiContextFile[] = [];
  for (const item of data.context) {
    if (!isRecord(item) || typeof item.name !== "string" || !CONTEXT_NAME.test(item.name) || typeof item.title !== "string" || typeof item.markdown !== "string") {
      throw new AiRequestError("failed");
    }
    files.push({ name: item.name, title: item.title, markdown: item.markdown });
  }
  return files;
}

/** 1 つの会話とその発言（古い順）。 */
export async function getAiChat(pageId: string, conversationId: string, options: { signal?: AbortSignal } = {}): Promise<AiChat> {
  const data = await get(pagePath(pageId, `/ai/conversations/${encodeURIComponent(conversationId)}`), options.signal);
  if (!isRecord(data)) throw new AiRequestError("failed");
  const conversation = chatSummaryOf(data.conversation);
  if (!conversation || !Array.isArray(data.messages)) throw new AiRequestError("failed");
  const messages = data.messages.map(chatMessageOf);
  if (messages.some((item) => item === null)) throw new AiRequestError("failed");
  return { conversation, messages: messages as AiChatMessage[] };
}

/**
 * AI チャットの 1 回の依頼（AI がページを直接書き換える。旧 NIHO docs と同じ動き）。
 * 書いた分は版として残るので、`undoAiChat` で元に戻せる。
 */
function chatResultFrom(data: unknown): AiChatResult {
  if (!isRecord(data) || !isRecord(data.message)) throw new AiRequestError("failed");
  const message = data.message;
  const result = chatResultOf(message.result);
  if (result === null) throw new AiRequestError("failed");
  return {
    conversation: turnRefOf(data.conversation),
    reply: typeof message.text === "string" ? message.text : "",
    items: chatItemsOf(message.items),
    result,
    resultCode: typeof message.resultCode === "string" ? message.resultCode : null,
    changes: chatChangesOf(message.changes),
    page: data.page === null || data.page === undefined ? null : conflictPageOf(data),
    usage: { nearLimit: isRecord(data.usage) && data.usage.nearLimit === true },
  };
}

export async function sendAiChat(pageId: string, body: { text: string; conversationId?: string; selection?: ChatSelection }, options: { signal?: AbortSignal } = {}): Promise<AiChatResult> {
  return chatResultFrom(await post(pagePath(pageId, "/ai/chat"), body, options.signal));
}

/**
 * 依頼の途中の出来事（画面の書きかけの発言）。`text` は文の差分（`kind` は CLI 経路の思考なら `thinking`）、
 * `tool` は道具の前（`start`。ok・page は null）と後（`end`）。
 */
export type AiChatEvent =
  | { type: "text"; text: string; kind?: "text" | "thinking" }
  | { type: "tool"; tool: string; page: string | null; ok: boolean | null; phase: "start" | "end"; detail?: string };

/** 作業の行の 1 句の長さの上限（文字。サーバーが作る短い句だけを出す）。 */
const TOOL_DETAIL_MAX_CHARS = 60;

/** SSE の 1 つの出来事（`event:` と `data:`）。コメント行（`:`）は無視する。 */
function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length > 0 ? { event, data: data.join("\n") } : null;
}

function toolEventOf(value: unknown): AiChatEvent | null {
  if (!isRecord(value) || typeof value.tool !== "string") return null;
  if (value.phase !== "start" && value.phase !== "end") return null;
  const detail = typeof value.detail === "string" && value.detail.trim().length > 0 ? Array.from(value.detail.trim()).slice(0, TOOL_DETAIL_MAX_CHARS).join("") : null;
  return {
    type: "tool",
    tool: value.tool,
    page: typeof value.page === "string" ? value.page : null,
    ok: typeof value.ok === "boolean" ? value.ok : null,
    phase: value.phase,
    ...(detail ? { detail } : {}),
  };
}

/**
 * AI チャットの 1 回の依頼を SSE で受ける（`Accept: text/event-stream`）。途中の文・道具は `onEvent` へ、終わりの `done` を結果として返す。
 * サーバーが JSON で返したとき（SSE に対応しない経路）は `sendAiChat` と同じに読む。失敗のステータスの扱いも `sendAiChat` と同じ。
 * `done` が来ずに終わったら、中断なら `aborted`、それ以外は `failed`。
 */
export async function streamAiChat(
  pageId: string,
  body: { text: string; conversationId?: string; selection?: ChatSelection },
  options: { signal?: AbortSignal; onEvent: (event: AiChatEvent) => void },
): Promise<AiChatResult> {
  const { signal } = options;
  let response: Response;
  try {
    response = await fetch(pagePath(pageId, "/ai/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw new AiRequestError(aborted(error, signal) ? "aborted" : "network");
  }
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!response.ok || !type.includes("text/event-stream") || !response.body) {
    return chatResultFrom(await readResponse(response, signal));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      buffer = buffer.replace(/\r\n?/g, "\n");
      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf("\n\n");
        const parsed = parseSseBlock(block);
        if (!parsed) continue;
        let data: unknown;
        try {
          data = JSON.parse(parsed.data);
        } catch {
          continue;
        }
        if (parsed.event === "text") {
          if (isRecord(data) && typeof data.text === "string" && data.text.length > 0) options.onEvent({ type: "text", text: data.text });
        } else if (parsed.event === "tool") {
          const event = toolEventOf(data);
          if (event) options.onEvent(event);
        } else if (parsed.event === "done") {
          void reader.cancel().catch(() => undefined);
          return chatResultFrom(data);
        } else if (parsed.event === "error") {
          void reader.cancel().catch(() => undefined);
          throw new AiRequestError("failed");
        }
      }
      if (done) break;
    }
  } catch (error) {
    if (error instanceof AiRequestError) throw error;
    throw new AiRequestError(aborted(error, signal) ? "aborted" : "failed");
  }
  throw new AiRequestError(signal?.aborted ? "aborted" : "failed");
}

/** Mac CLI の完了結果を保存する。通信が途切れたら保存済みか不明なので、この関数は自動再送しない。 */
export async function recordDeviceAiChat(pageId: string, body: { conversationId?: string; input: string; reply: string; engine: string; writes: DeviceChatWrite[]; selection?: ChatSelection }): Promise<AiChatResult> {
  const data = await post(pagePath(pageId, "/ai/chat/turns"), body);
  // Device turns save the page before best-effort conversation history. Preserve a successful page response
  // even when that history write failed, so the editor can refresh the changed page and tell the user.
  if (isRecord(data) && data.message === null && data.conversation === null) {
    return {
      conversation: null,
      reply: body.reply,
      items: [],
      result: "done",
      resultCode: "history_unavailable",
      changes: [],
      page: data.page === null || data.page === undefined ? null : conflictPageOf(data),
      usage: { nearLimit: false },
    };
  }
  return chatResultFrom(data);
}

/** その依頼で書いた分を元に戻す（直したページは依頼の前へ、作ったページはゴミ箱へ）。 */
export async function undoAiChat(pageId: string, messageId: string, options: { signal?: AbortSignal } = {}): Promise<AiUndoResult> {
  const data = await post(pagePath(pageId, `/ai/chat/${encodeURIComponent(messageId)}/undo`), {}, options.signal);
  if (!isRecord(data) || !Array.isArray(data.undone)) throw new AiRequestError("failed");
  const kept = Array.isArray(data.kept)
    ? data.kept.flatMap((item) => (isRecord(item) && typeof item.pageId === "string" ? [{ pageId: item.pageId, reason: String(item.reason) }] : []))
    : [];
  return {
    undone: data.undone.filter((id): id is string => typeof id === "string"),
    kept,
    page: data.page === null || data.page === undefined ? null : conflictPageOf(data),
  };
}
