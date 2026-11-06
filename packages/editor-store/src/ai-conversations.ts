import type { PoolClient } from "pg";
import { isPageId } from "./store.ts";
import type { Database, OwnerId, Queryable } from "./types.ts";

/**
 * AI チャット（会話）の層（表 ai_conversations・ai_messages。migration 0022・0025・20261107011826）。
 * 旧アプリ（packages/docs-core の conversation.ts）がファイルに持っていた会話を、サーバーの正本に置き換えたもの。
 *
 * - 会話は**利用者（owner）に属する**（#312。ページを移っても続く）。`page_id` は始めたページを覚えるだけで、読み書きは owner と会話の id で絞る
 *   （他人の会話・無い会話はどちらも null＝同じ 404）。ページの id を受ける口は、そのページが本人のものかを確かめるためだけに使う。
 * - 発言には、その turn で開いていたページ（タブ）を残す（`pageId`・`pageTitle`。画面の「◯◯ で」）。消えたページは NULL。
 * - 1 回のやりとり（人の頼み → AI の提案）は 1 transaction で 2 つの発言として足す（途中の片方だけが残らない）。
 * - 採用は提案の発言に後から書く（採用した中身と、採用の前の本文が残った版の番号）。採用しなければ何も書かない。
 * - 持つのは頼んだことと提案の中身だけ（鍵・プロンプト・モデルへ送った文は持たない）。
 */

/** 利用者の会話の一覧で返す数の上限（新しい順）。 */
export const CONVERSATION_LIST_LIMIT = 50;
/** 1 つの会話で返す発言の数の上限（古い順。超えた分は新しいものだけを返す）。 */
export const CONVERSATION_MESSAGE_LIMIT = 200;
/** 発言の文の上限（文字。migration の CHECK と同じ）。 */
export const MESSAGE_TEXT_MAX_CHARS = 4_000;
/** 提案・採用の JSON の上限（バイト）。超えるものは保存しない（会話は手がかりで、本文の正本はページ）。 */
export const MESSAGE_JSON_MAX_BYTES = 256 * 1024;

const PRESET_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/;

export type AiMessageRole = "user" | "assistant";

export type AiConversationSummary = {
  id: string;
  /** 始めたページ（消えていれば null）。会話はこのページに縛られない。 */
  pageId: string | null;
  createdAt: string;
  updatedAt: string;
  /** 発言の数（人の頼みと AI の返事の合計）。 */
  messages: number;
  /** 一覧に出す最後の発言の文（会話が空なら null）。 */
  lastText: string | null;
};

/** 1 回の依頼で直した・作ったページ（旧アプリの TurnPageChange。migration 0025）。 */
export type AiMessageChange = {
  pageId: string;
  title: string;
  change: "edited" | "created";
  /** 直す前の本文が残った版の番号（作ったページは null）。 */
  version: number | null;
  /** 依頼が書き終えたときの revision（人があとから直したかを見るため）。 */
  revision: number;
  chars: number;
  delta: number;
  undoneAt: string | null;
};

export type AiMessage = {
  id: string;
  seq: number;
  role: AiMessageRole;
  text: string;
  /** 候補から頼んだときの preset の id（自由入力は null）。 */
  preset: string | null;
  /** そのときの提案（AI の発言だけ）。 */
  proposal: unknown | null;
  /** 採用した中身（採用していなければ null）。 */
  adopted: unknown | null;
  /** 採用の前の本文が残った版の番号（採用していなければ null）。 */
  version: number | null;
  adoptedAt: string | null;
  /** AI チャットの作業の要約（提案の発言は null）。 */
  items: unknown | null;
  /** 依頼の結果（done・failed・stopped。提案の発言は null）。 */
  result: AiMessageResult | null;
  /** 止まった理由の短い code。 */
  resultCode: string | null;
  /** 誰が文を作ったか（`server`＝サーバーの API、`device`＝この Mac の CLI）。人の発言は null。 */
  route: AiRoute | null;
  /** エンジンの短い id（`anthropic:claude-sonnet-5-5`・`cli:claude-code`）。 */
  engine: string | null;
  /** その依頼で直した・作ったページ。 */
  changes: AiMessageChange[];
  /** その turn で開いていたページ（タブ）。古い記録・消えたページは null。 */
  pageId: string | null;
  /** そのページの今の題名（画面の「◯◯ で」）。ページが無ければ null。 */
  pageTitle: string | null;
  createdAt: string;
};

export const AI_MESSAGE_RESULTS = ["done", "failed", "stopped"] as const;
export type AiMessageResult = (typeof AI_MESSAGE_RESULTS)[number];

/** 文を作った経路（使用量の `AiUsageSource` と同じ名前）。 */
export const AI_ROUTES = ["server", "device"] as const;
export type AiRoute = (typeof AI_ROUTES)[number];

/** エンジンの短い id（鍵・端末の情報を入れない）。 */
const ENGINE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,95}$/;

/** 誰が文を作ったか（会話に残す）。 */
export type AiAuthor = { route: AiRoute; engine: string };

function assertAuthor(author: AiAuthor | undefined): void {
  if (author === undefined) return;
  if (!(AI_ROUTES as readonly string[]).includes(author.route)) throw new TypeError("editor-store: route must be server or device");
  if (typeof author.engine !== "string" || !ENGINE_PATTERN.test(author.engine)) throw new TypeError("editor-store: engine must be a short id");
}

export type AiConversation = { conversation: AiConversationSummary; messages: AiMessage[] };

/** 1 回のやりとり。`request` は人が頼んだこと、`result` は AI の結果の一言とそのときの提案。 */
export type AiTurnInput = {
  /** 頼んだときに開いていたページ（タブ）。本人の生きているページでなければ null を返す。新しい会話はこのページで始まる。 */
  pageId: string;
  /** 続ける会話（無ければ新しい会話を始める）。他人の会話・無い会話は null を返す。 */
  conversationId?: string | null;
  request: { text: string; preset?: string | null };
  result: { text: string; proposal: unknown };
  /** 誰が提案を作ったか（渡さなければ記録しない）。 */
  author?: AiAuthor;
};

export type AiTurn = { conversation: AiConversationSummary; request: AiMessage; result: AiMessage };

function assertOwner(owner: OwnerId): void {
  // ai-usage.ts・store.ts と同じ守り（空の owner で誰のものでもない行を作らない）
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }
}

/** 保存できる文（1〜MESSAGE_TEXT_MAX_CHARS 文字・NUL なし）。 */
export function isMessageText(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\u0000")) return false;
  const length = Array.from(value).length;
  return length >= 1 && length <= MESSAGE_TEXT_MAX_CHARS;
}

/** 保存できる JSON（object で、MESSAGE_JSON_MAX_BYTES バイト以内・NUL なし）。 */
export function isMessageJson(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return false;
  }
  if (text === undefined || text.includes("\\u0000")) return false;
  return new TextEncoder().encode(text).byteLength <= MESSAGE_JSON_MAX_BYTES;
}

type ConversationRow = { id: string; page_id: string | null; created_at: Date; updated_at: Date; messages: string | number; last_text: string | null };
type MessageRow = {
  id: string;
  seq: number;
  role: AiMessageRole;
  text: string;
  preset: string | null;
  proposal: unknown;
  adopted: unknown;
  version: number | null;
  adopted_at: Date | null;
  items: unknown;
  result: AiMessageResult | null;
  result_code: string | null;
  route: AiRoute | null;
  engine: string | null;
  page_id: string | null;
  page_title?: string | null;
  created_at: Date;
};

type ChangeRow = {
  message_id: string;
  page_id: string;
  title: string | null;
  change: "edited" | "created";
  version: number | null;
  revision: number;
  chars: number;
  delta: number;
  undone_at: Date | null;
};

function toChange(row: ChangeRow): AiMessageChange {
  return {
    pageId: row.page_id,
    title: row.title ?? "",
    change: row.change,
    version: row.version,
    revision: row.revision,
    chars: row.chars,
    delta: row.delta,
    undoneAt: row.undone_at ? row.undone_at.toISOString() : null,
  };
}

function toSummary(row: ConversationRow): AiConversationSummary {
  return {
    id: row.id,
    pageId: row.page_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    messages: Number(row.messages),
    lastText: row.last_text,
  };
}

function toMessage(row: MessageRow, changes: readonly ChangeRow[] = []): AiMessage {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    text: row.text,
    preset: row.preset,
    proposal: row.proposal ?? null,
    adopted: row.adopted ?? null,
    version: row.version,
    adoptedAt: row.adopted_at ? row.adopted_at.toISOString() : null,
    items: row.items ?? null,
    result: row.result,
    resultCode: row.result_code,
    route: row.route,
    engine: row.engine,
    changes: changes.filter((change) => change.message_id === row.id).map(toChange),
    pageId: row.page_id,
    pageTitle: row.page_id ? (row.page_title ?? null) : null,
    createdAt: row.created_at.toISOString(),
  };
}

const SUMMARY_SELECT = `SELECT c.id, c.page_id, c.created_at, c.updated_at,
         (SELECT count(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS messages,
         (SELECT m.text FROM ai_messages m WHERE m.conversation_id = c.id ORDER BY m.seq DESC LIMIT 1) AS last_text
    FROM ai_conversations c`;

const MESSAGE_COLUMNS = "id, seq, role, text, preset, proposal, adopted, version, adopted_at, items, result, result_code, route, engine, page_id, created_at";
/** 発言と、その turn で開いていたページの今の題名（消えたページは NULL）。 */
const MESSAGE_SELECT = `SELECT ${MESSAGE_COLUMNS.split(", ")
  .map((column) => `m.${column}`)
  .join(", ")}, p.title AS page_title
    FROM ai_messages m
    LEFT JOIN pages p ON p.id = m.page_id`;

/** 発言に紐づく「直した・作ったページ」（題名は今の題名。消えたページの行は無い）。 */
const CHANGES_SELECT = `SELECT c.message_id, c.page_id, p.title, c.change, c.version, c.revision, c.chars, c.delta, c.undone_at
    FROM ai_message_changes c
    JOIN pages p ON p.id = c.page_id`;

async function pageExists(db: Queryable, owner: OwnerId, pageId: string): Promise<boolean> {
  const result = await db.query<{ id: string }>("SELECT id FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL", [owner, pageId]);
  return result.rows.length > 0;
}

/**
 * 利用者の会話の一覧（新しい順。どのページで始めたかによらない）。`pageId` は開いているページ（本人のものでない・無い・ゴミ箱の中なら null＝404）。
 */
export async function listConversations(db: Queryable, owner: OwnerId, pageId: string): Promise<AiConversationSummary[] | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  if (!(await pageExists(db, owner, pageId))) return null;
  const result = await db.query<ConversationRow>(`${SUMMARY_SELECT} WHERE c.owner = $1 ORDER BY c.updated_at DESC, c.id DESC LIMIT $2`, [owner, CONVERSATION_LIST_LIMIT]);
  return result.rows.map(toSummary);
}

/** 本人の会話を 1 つ読む（古い順。CONVERSATION_MESSAGE_LIMIT を超えたら新しい方だけ）。`pageId` は開いているページ（本人のものでなければ null）。 */
export async function getConversation(db: Queryable, owner: OwnerId, pageId: string, conversationId: string): Promise<AiConversation | null> {
  assertOwner(owner);
  if (!isPageId(pageId) || !isPageId(conversationId)) return null;
  if (!(await pageExists(db, owner, pageId))) return null;
  const found = await db.query<ConversationRow>(`${SUMMARY_SELECT} WHERE c.owner = $1 AND c.id = $2`, [owner, conversationId]);
  const row = found.rows[0];
  if (!row) return null;
  const messages = await db.query<MessageRow>(
    `SELECT * FROM (${MESSAGE_SELECT} WHERE m.conversation_id = $1 ORDER BY m.seq DESC LIMIT $2) AS recent ORDER BY seq`,
    [conversationId, CONVERSATION_MESSAGE_LIMIT],
  );
  const ids = messages.rows.map((message) => message.id);
  const changes = ids.length === 0 ? { rows: [] } : await db.query<ChangeRow>(`${CHANGES_SELECT} WHERE c.message_id = ANY($1::uuid[]) ORDER BY c.created_at`, [ids]);
  return { conversation: toSummary(row), messages: messages.rows.map((message) => toMessage(message, changes.rows)) };
}

/** 本人の提案の発言（採用の前に確かめる）。`pageId` は開いているページ（本人のものでなければ null）。無ければ null。 */
export async function getAssistantMessage(db: Queryable, owner: OwnerId, pageId: string, messageId: string): Promise<AiMessage | null> {
  assertOwner(owner);
  if (!isPageId(pageId) || !isPageId(messageId)) return null;
  if (!(await pageExists(db, owner, pageId))) return null;
  const result = await db.query<MessageRow>(
    `${MESSAGE_SELECT}
      WHERE m.id = $2 AND m.role = 'assistant'
        AND EXISTS (SELECT 1 FROM ai_conversations c WHERE c.id = m.conversation_id AND c.owner = $1)`,
    [owner, messageId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const changes = await db.query<ChangeRow>(`${CHANGES_SELECT} WHERE c.message_id = $1 ORDER BY c.created_at`, [row.id]);
  return toMessage(row, changes.rows);
}

async function inTransaction<T>(db: Database, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    let result: T;
    try {
      result = await work(client);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}

/**
 * 続ける会話を押さえる（無ければ新しい会話を始める）。同じ会話に同時に足しても seq がぶつからないよう、会話の行を FOR UPDATE で押さえる。
 * 他人の会話・無い会話なら null。新しい会話は、頼んだときに開いていたページで始まる。
 */
async function holdConversation(client: PoolClient, owner: OwnerId, conversationId: string | null | undefined, pageId: string): Promise<string | null> {
  if (conversationId == null) {
    const created = await client.query<{ id: string }>("INSERT INTO ai_conversations (owner, page_id) VALUES ($1, $2) RETURNING id", [owner, pageId]);
    return created.rows[0]!.id;
  }
  const existing = await client.query<{ id: string }>("SELECT id FROM ai_conversations WHERE owner = $1 AND id = $2 FOR UPDATE", [owner, conversationId]);
  return existing.rows[0]?.id ?? null;
}

async function conversationSummary(client: PoolClient, conversationId: string): Promise<AiConversationSummary> {
  const summary = await client.query<ConversationRow>(
    `UPDATE ai_conversations SET updated_at = clock_timestamp() WHERE id = $1
     RETURNING id, page_id, created_at, updated_at,
               (SELECT count(*) FROM ai_messages m WHERE m.conversation_id = ai_conversations.id) AS messages,
               (SELECT m.text FROM ai_messages m WHERE m.conversation_id = ai_conversations.id ORDER BY m.seq DESC LIMIT 1) AS last_text`,
    [conversationId],
  );
  return toSummary(summary.rows[0]!);
}

/** 書いたばかりの発言を、ページの題名つきで読み直す。 */
async function readMessage(client: PoolClient, messageId: string, changes: readonly ChangeRow[] = []): Promise<AiMessage> {
  const row = await client.query<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = $1`, [messageId]);
  return toMessage(row.rows[0]!, changes);
}

/**
 * 1 回のやりとりを足す（人の頼み → AI の提案の 2 つの発言）。`conversationId` を渡せばその会話に続け、
 * 渡さなければ新しい会話を始める。ページが本人のものでない・無い、渡した会話が本人のものでなければ null
 * （呼び出し側は 404。他人のものと無いものを見分けさせない）。
 */
export async function appendTurn(db: Database, owner: OwnerId, input: AiTurnInput): Promise<AiTurn | null> {
  assertOwner(owner);
  if (!isPageId(input.pageId)) return null;
  if (input.conversationId != null && !isPageId(input.conversationId)) return null;
  if (!isMessageText(input.request.text) || !isMessageText(input.result.text)) throw new TypeError("editor-store: message text must be 1..4000 characters");
  const preset = input.request.preset ?? null;
  if (preset !== null && (typeof preset !== "string" || !PRESET_PATTERN.test(preset))) throw new TypeError("editor-store: preset must be a short id");
  if (!isMessageJson(input.result.proposal)) throw new TypeError("editor-store: proposal must be a small JSON object");
  assertAuthor(input.author);

  return inTransaction(db, async (client) => {
    // ページを押さえてから書く（書き終えるまで削除させない）
    const page = await client.query<{ id: string }>("SELECT id FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL FOR SHARE", [owner, input.pageId]);
    if (page.rows.length === 0) return null;
    const conversationId = await holdConversation(client, owner, input.conversationId, input.pageId);
    if (conversationId === null) return null;

    const next = await client.query<{ seq: number }>("SELECT coalesce(max(seq), 0) + 1 AS seq FROM ai_messages WHERE conversation_id = $1", [conversationId]);
    const seq = next.rows[0]!.seq;
    const request = await client.query<{ id: string }>(
      "INSERT INTO ai_messages (conversation_id, seq, role, text, preset, page_id) VALUES ($1, $2, 'user', $3, $4, $5) RETURNING id",
      [conversationId, seq, input.request.text, preset, input.pageId],
    );
    const result = await client.query<{ id: string }>(
      `INSERT INTO ai_messages (conversation_id, seq, role, text, proposal, route, engine, page_id) VALUES ($1, $2, 'assistant', $3, $4::jsonb, $5, $6, $7)
       RETURNING id`,
      [conversationId, seq + 1, input.result.text, JSON.stringify(input.result.proposal), input.author?.route ?? null, input.author?.engine ?? null, input.pageId],
    );
    return {
      conversation: await conversationSummary(client, conversationId),
      request: await readMessage(client, request.rows[0]!.id),
      result: await readMessage(client, result.rows[0]!.id),
    };
  });
}

/** AI チャットが読み書きできるページ（作業場）。 */
export type ChatWorkspacePage = { id: string; title: string; kind: string; parent: string | null; open: boolean };

/** 作業場に入れるページの数の上限（開いているページのフォルダの中のページ）。 */
export const CHAT_WORKSPACE_LIMIT = 50;

/**
 * 開いているページ（タブ）が入っているフォルダ。タブはフォルダに直に並ぶ（`parent`）。録音の下の段階（kind = 'step'）は
 * 親の録音のフォルダ。フォルダの外（一番上）のページは null。
 */
const FOLDER_OF = `SELECT CASE
           WHEN me.kind = 'step' THEN (SELECT r.parent FROM pages r WHERE r.owner = me.owner AND r.id = me.parent AND r.deleted_at IS NULL)
           ELSE me.parent
         END
    FROM pages me
   WHERE me.owner = $1 AND me.id = $2 AND me.deleted_at IS NULL AND me.kind NOT IN ('folder', 'page')`;

/**
 * AI チャットが読み書きできるページ＝**開いているページのフォルダの中の全部**（#312。タブも、録音の下の段階も）。
 * フォルダの外のページなら、そのページだけ。フォルダ（`kind = 'folder'`）と入れ物（`kind = 'page'`）は本文を持たないので入れない。
 * 旧アプリが会話ごとに作った「隔離した作業場」にあたるもので、ここに無いページは道具から触れない。
 * ページが本人のものでない・無い・ゴミ箱の中・フォルダ・入れ物なら null。
 */
export async function listChatWorkspace(db: Queryable, owner: OwnerId, pageId: string): Promise<ChatWorkspacePage[] | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  const result = await db.query<{ id: string; title: string; kind: string; parent: string | null }>(
    `WITH folder AS (${FOLDER_OF})
     SELECT p.id, p.title, p.kind, p.parent
       FROM pages p
      WHERE p.owner = $1 AND p.deleted_at IS NULL AND p.kind NOT IN ('folder', 'page')
        AND (
          p.id = $2
          OR (
            (SELECT * FROM folder) IS NOT NULL
            AND (
              p.parent = (SELECT * FROM folder)
              OR p.parent IN (SELECT r.id FROM pages r WHERE r.owner = $1 AND r.deleted_at IS NULL AND r.kind = 'rec' AND r.parent = (SELECT * FROM folder))
            )
          )
        )
      ORDER BY (p.id = $2) DESC, p.created_at, p.id
      LIMIT $3`,
    [owner, pageId, CHAT_WORKSPACE_LIMIT],
  );
  const pages = result.rows.map((row) => ({ id: row.id, title: row.title, kind: row.kind, parent: row.parent, open: row.id === pageId }));
  return pages.some((page) => page.open) ? pages : null;
}

/** 開いているページの文脈の手がかり（指示の文脈を turn ごとに組み直すため。#312）。 */
export type ChatContextOf = {
  /** このページが元にしている録音（録音そのもの・録音の下の段階・文字起こしや手順から作られたタブの系譜をたどる）。無ければ null。 */
  recordingId: string | null;
  /** 入っているフォルダの手順（`pages.recipe`）。フォルダの外・手順が無ければ null。 */
  folderRecipe: string | null;
};

/** 系譜をたどる回数の上限（複製の複製の…を無限には追わない）。 */
const LINEAGE_HOPS = 8;

/**
 * 開いているページの文脈の手がかり: 元の録音（`kind = 'rec'` は自分、`step` は親、タブは `made_from` の系譜
 * （文字起こし → 録音、段階 → 入力のタブ、複製 → 元のタブ）を録音に当たるまでたどる）と、フォルダの手順。
 * ページが本人のものでない・無い・ゴミ箱の中なら null。
 */
export async function chatContextOf(db: Queryable, owner: OwnerId, pageId: string): Promise<ChatContextOf | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  type Row = { id: string; kind: string; parent: string | null; made_from: unknown };
  const read = async (id: string): Promise<Row | null> => {
    if (!isPageId(id)) return null;
    const found = await db.query<Row>("SELECT id, kind, parent, made_from FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL", [owner, id]);
    return found.rows[0] ?? null;
  };
  const me = await read(pageId);
  if (!me || me.kind === "folder" || me.kind === "page") return null;
  const folder = await db.query<{ folder: string | null }>(`SELECT (${FOLDER_OF}) AS folder`, [owner, pageId]);
  const folderId = folder.rows[0]?.folder ?? null;
  const recipe = folderId ? await db.query<{ recipe: string | null }>("SELECT recipe FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL AND kind = 'folder'", [owner, folderId]) : null;

  let recordingId: string | null = null;
  let at: Row | null = me;
  for (let hop = 0; at && hop < LINEAGE_HOPS; hop++) {
    if (at.kind === "rec") {
      recordingId = at.id;
      break;
    }
    if (at.kind === "step") {
      const parent = at.parent ? await read(at.parent) : null;
      recordingId = parent?.kind === "rec" ? parent.id : null;
      break;
    }
    const from = at.made_from;
    if (typeof from !== "object" || from === null) break;
    const link = from as { kind?: unknown; recording?: unknown; input?: unknown; from?: unknown };
    const next = link.kind === "transcript" ? link.recording : link.kind === "step" ? link.input : link.kind === "dup" ? link.from : null;
    at = typeof next === "string" ? await read(next) : null;
  }
  return { recordingId, folderRecipe: recipe?.rows[0]?.recipe ?? null };
}

/** 自動で参考に入れるページ（同じフォルダの直下。開いているページとサブページは入らない）。 */
export type ReferencePage = { id: string; title: string; kind: string; blocks: unknown };

/**
 * 同じフォルダの直下のほかのページ（手順の段階が参考として読む。設計 §6）。AI チャットはもう使わない（作業場がフォルダ全体。#312）。
 * **開いているページと同じ親（フォルダ）の直下にある、ほかのページ**だけを返す。サブページ（孫）は入れない
 * （手順の成果物なので、参考に混ぜると AI の入力が二重になる）。親が無い（一番上の）ページは空。
 *
 * **枚数の上限はここでは持たない。** 1 フォルダに置けるページの数はフォルダの側が守る（T1 の実装）ので、
 * ここはその直下を素直に全部返す。
 */
export async function listReferencePages(db: Queryable, owner: OwnerId, pageId: string): Promise<ReferencePage[] | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  const result = await db.query<{ id: string; title: string; kind: string; blocks: unknown }>(
    `SELECT s.id, s.title, s.kind, s.blocks
       FROM pages p
       JOIN pages s ON s.owner = p.owner AND s.parent = p.parent AND s.deleted_at IS NULL AND s.id <> p.id AND s.kind <> 'page'
      WHERE p.owner = $1 AND p.id = $2 AND p.deleted_at IS NULL AND p.parent IS NOT NULL
      ORDER BY s.created_at, s.id`,
    [owner, pageId],
  );
  return result.rows.map((row) => ({ id: row.id, title: row.title, kind: row.kind, blocks: row.blocks }));
}

/** 1 回の依頼で直した・作ったページ（記録するときの入力）。 */
export type ChatChangeInput = {
  pageId: string;
  change: "edited" | "created";
  /** 直す前の本文が残った版の番号（直したページは必須）。 */
  version?: number | null;
  /** 依頼が書き終えたときの revision。 */
  revision: number;
  chars: number;
  delta: number;
};

/**
 * AI チャットの 1 回の依頼（人の指示 → AI の作業と返答）。`items` は作業の要約、`changes` は直した・作ったページ。
 * 提案（appendTurn）と違い、ページは依頼の中で既に書き換わっている（ここは記録だけ）。
 */
export type ChatTurnInput = {
  /** 頼んだときに開いていたページ（タブ）。発言に残り、新しい会話はこのページで始まる。 */
  pageId: string;
  conversationId?: string | null;
  input: string;
  reply: string;
  items: readonly unknown[];
  result: AiMessageResult;
  resultCode?: string | null;
  changes?: readonly ChatChangeInput[];
  /** 誰が文を作ったか（サーバーの API か、この Mac の CLI か）。 */
  author?: AiAuthor;
};

/**
 * 依頼を会話に足す（人の発言と AI の発言、直した・作ったページ）。ページが本人のものでない・無い、
 * 渡した会話が本人のものでなければ null。同じページを何度書いても 1 行で、版は最初の 1 つ（依頼の前の本文）。
 */
export async function appendChatTurn(db: Database, owner: OwnerId, input: ChatTurnInput): Promise<AiTurn | null> {
  assertOwner(owner);
  if (!isPageId(input.pageId)) return null;
  if (input.conversationId != null && !isPageId(input.conversationId)) return null;
  if (!isMessageText(input.input)) throw new TypeError("editor-store: message text must be 1..4000 characters");
  const reply = isMessageText(input.reply) ? input.reply : "";
  if (!(AI_MESSAGE_RESULTS as readonly string[]).includes(input.result)) throw new TypeError("editor-store: unknown chat result");
  const code = input.resultCode ?? null;
  if (code !== null && !/^[a-z0-9_]{1,64}$/.test(code)) throw new TypeError("editor-store: result code must be a short code");
  if (!Array.isArray(input.items) || !isMessageJson({ items: input.items })) throw new TypeError("editor-store: items must be a small JSON array");
  assertAuthor(input.author);
  const changes = input.changes ?? [];
  for (const change of changes) {
    if (!isPageId(change.pageId)) throw new TypeError("editor-store: change page must be a page id");
    if (change.change !== "edited" && change.change !== "created") throw new TypeError("editor-store: unknown change");
    if (change.change === "edited" && !Number.isSafeInteger(change.version ?? Number.NaN)) throw new TypeError("editor-store: an edited page needs the version it can be undone to");
    if (!Number.isSafeInteger(change.chars) || change.chars < 0 || !Number.isSafeInteger(change.delta)) throw new RangeError("editor-store: chars and delta must be integers");
    if (!Number.isSafeInteger(change.revision) || change.revision < 1) throw new RangeError("editor-store: revision must be a positive integer");
  }

  return inTransaction(db, async (client) => {
    const page = await client.query<{ id: string }>("SELECT id FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL FOR SHARE", [owner, input.pageId]);
    if (page.rows.length === 0) return null;
    const conversationId = await holdConversation(client, owner, input.conversationId, input.pageId);
    if (conversationId === null) return null;

    const next = await client.query<{ seq: number }>("SELECT coalesce(max(seq), 0) + 1 AS seq FROM ai_messages WHERE conversation_id = $1", [conversationId]);
    const seq = next.rows[0]!.seq;
    const request = await client.query<{ id: string }>(
      "INSERT INTO ai_messages (conversation_id, seq, role, text, page_id) VALUES ($1, $2, 'user', $3, $4) RETURNING id",
      [conversationId, seq, input.input, input.pageId],
    );
    const answer = await client.query<{ id: string }>(
      `INSERT INTO ai_messages (conversation_id, seq, role, text, items, result, result_code, route, engine, page_id)
       VALUES ($1, $2, 'assistant', $3, $4::jsonb, $5, $6, $7, $8, $9) RETURNING id`,
      [
        conversationId,
        seq + 1,
        reply.length > 0 ? reply : "（返答はありません）",
        JSON.stringify(input.items),
        input.result,
        code,
        input.author?.route ?? null,
        input.author?.engine ?? null,
        input.pageId,
      ],
    );
    const messageId = answer.rows[0]!.id;
    for (const change of changes) {
      // 同じ依頼で同じページを何度書いても 1 行（版は最初の 1 つ＝依頼の前の本文）
      await client.query(
        `INSERT INTO ai_message_changes (message_id, page_id, change, version, revision, chars, delta)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (message_id, page_id) DO UPDATE
            SET chars = EXCLUDED.chars,
                delta = ai_message_changes.delta + EXCLUDED.delta,
                revision = EXCLUDED.revision`,
        [messageId, change.pageId, change.change, change.change === "edited" ? change.version : null, change.revision, change.chars, change.delta],
      );
    }
    const written = await client.query<ChangeRow>(`${CHANGES_SELECT} WHERE c.message_id = $1 ORDER BY c.created_at`, [messageId]);
    return {
      conversation: await conversationSummary(client, conversationId),
      request: await readMessage(client, request.rows[0]!.id),
      result: await readMessage(client, messageId, written.rows),
    };
  });
}

/**
 * 依頼で直した・作ったページ（「元に戻す」が読む）。本人の会話の依頼でなければ null。`pageId` は開いているページ（本人のものでなければ null）。
 * まだ戻していないものだけを返す（`undone` を渡すと戻したものも含む）。
 */
export async function getChatChanges(db: Queryable, owner: OwnerId, pageId: string, messageId: string, options: { undone?: boolean } = {}): Promise<AiMessageChange[] | null> {
  assertOwner(owner);
  if (!isPageId(pageId) || !isPageId(messageId)) return null;
  if (!(await pageExists(db, owner, pageId))) return null;
  const found = await db.query<{ id: string }>(
    `SELECT m.id FROM ai_messages m
      WHERE m.id = $2 AND m.role = 'assistant'
        AND EXISTS (SELECT 1 FROM ai_conversations c WHERE c.id = m.conversation_id AND c.owner = $1)`,
    [owner, messageId],
  );
  if (found.rows.length === 0) return null;
  const changes = await db.query<ChangeRow>(
    `${CHANGES_SELECT} WHERE c.message_id = $1 ${options.undone ? "" : "AND c.undone_at IS NULL"} ORDER BY c.created_at`,
    [messageId],
  );
  return changes.rows.map(toChange);
}

/** 戻したページに印を付ける（戻し終えてから呼ぶ）。戻した件数を返す。 */
export async function markChangesUndone(db: Queryable, owner: OwnerId, messageId: string, pageIds: readonly string[]): Promise<number> {
  assertOwner(owner);
  if (!isPageId(messageId) || pageIds.length === 0) return 0;
  if (!pageIds.every((id) => isPageId(id))) throw new TypeError("editor-store: page ids must be page ids");
  const result = await db.query(
    `UPDATE ai_message_changes AS c
        SET undone_at = clock_timestamp()
      WHERE c.message_id = $2 AND c.page_id = ANY($3::uuid[]) AND c.undone_at IS NULL
        AND EXISTS (
          SELECT 1 FROM ai_messages m
            JOIN ai_conversations v ON v.id = m.conversation_id
           WHERE m.id = c.message_id AND v.owner = $1
        )`,
    [owner, messageId, [...pageIds]],
  );
  return result.rowCount ?? 0;
}

export type AdoptionInput = {
  /** 開いているページ（本人のものでなければ書かない）。 */
  pageId: string;
  /** 採用した提案の発言。 */
  messageId: string;
  /** 採用の前の本文が残った版の番号。 */
  version: number;
  /** 採用した中身（{ changes, inserts }）。 */
  adopted: unknown;
};

/**
 * 採用を提案の発言に書く（採用した中身・版の番号・時刻）。本人の会話の提案の発言で、まだ採用を書いていないものだけ。
 * 書けなければ false（ページの保存そのものは済んでいるので、呼び出し側は 200 のまま続ける）。
 */
export async function recordAdoption(db: Queryable, owner: OwnerId, input: AdoptionInput): Promise<boolean> {
  assertOwner(owner);
  if (!isPageId(input.pageId) || !isPageId(input.messageId)) return false;
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new RangeError("editor-store: version must be a positive integer");
  if (!isMessageJson(input.adopted)) throw new TypeError("editor-store: adopted must be a small JSON object");
  if (!(await pageExists(db, owner, input.pageId))) return false;
  const result = await db.query(
    `UPDATE ai_messages AS m
        SET adopted = $3::jsonb, version = $4, adopted_at = clock_timestamp()
      WHERE m.id = $2 AND m.role = 'assistant' AND m.proposal IS NOT NULL AND m.adopted IS NULL
        AND EXISTS (SELECT 1 FROM ai_conversations c WHERE c.id = m.conversation_id AND c.owner = $1)`,
    [owner, input.messageId, JSON.stringify(input.adopted), input.version],
  );
  return (result.rowCount ?? 0) > 0;
}
