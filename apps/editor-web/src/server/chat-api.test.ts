import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AiMessage, AiMessageChange, Block, ChatTurnInput, ChatWorkspacePage, CreatePageInput, Page } from "@niho/editor-store";
import type { Turn } from "../ai/anthropic";
import type { AiComposeBackend } from "../ai/config";
import type { AuthProvider } from "../auth/types";
import { recordDeviceChatTurn, runAiChat, undoAiChat, type ChatApiDeps, type ChatConversationStore, type ChatPagesStore, type ChatUsageStore } from "./chat-api";

const ORIGIN = "http://editor.test";
const NOW = new Date("2026-11-01T03:00:00Z");
const usage = { model: "claude-sonnet-5-5", inputTokens: 100, outputTokens: 20 };

const p = (text: string): Block => ({ type: "paragraph", content: [{ type: "text", text }] });

function turn(partial: Partial<Turn>): Turn {
  return { text: "", toolCalls: [], stopReason: "end_turn", usage, ...partial };
}

/** owner ごとのページ（版と revision を持つ。EditorStore と同じ約束）。 */
function memoryStore() {
  const rows = new Map<string, Page & { owner: string; deleted: boolean }>();
  const versions: { pageId: string; version: number; blocks: Block[] }[] = [];
  const visible = (owner: string, id: string) => {
    const row = rows.get(id);
    return row && row.owner === owner && !row.deleted ? row : null;
  };
  const strip = (row: Page & { owner: string; deleted: boolean }): Page => {
    const page = structuredClone(row) as Partial<Page & { owner: string; deleted: boolean }>;
    delete page.owner;
    delete page.deleted;
    return page as Page;
  };
  const add = (owner: string, input: CreatePageInput & { parent?: string | null } = {}): Page => {
    const now = new Date().toISOString();
    const page: Page = {
      id: randomUUID(),
      kind: input.kind ?? "note",
      title: input.title ?? "",
      lang: "ja",
      blocks: input.blocks ?? [],
      cover: null,
      lead: null,
      parent: input.parent ?? null,
      recipe: null,
      stepStatus: null,
      sortOrder: 0,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    rows.set(page.id, { ...structuredClone(page), owner, deleted: false });
    return page;
  };
  const store: ChatPagesStore & { rows: typeof rows; versions: typeof versions; add: typeof add } = {
    rows,
    versions,
    add,
    async getPage(owner, id) {
      const row = visible(owner, id);
      return row ? strip(row) : null;
    },
    async savePage(owner, id, patch, options) {
      const row = visible(owner, id);
      if (!row) return null;
      if (row.revision !== options.baseRevision) return { status: "conflict", page: strip(row) };
      row.blocks = structuredClone(patch.blocks);
      row.revision += 1;
      return { status: "saved", page: strip(row) };
    },
    async createVersion(owner, id) {
      const row = visible(owner, id);
      if (!row) return null;
      const version = (versions.filter((item) => item.pageId === id).at(-1)?.version ?? 0) + 1;
      versions.push({ pageId: id, version, blocks: structuredClone(row.blocks) });
      return { version, reason: "ai", createdAt: new Date().toISOString(), blockCount: row.blocks.length };
    },
    async createPage(owner, input) {
      return add(owner, input);
    },
    async restoreVersion(owner, id, version, options) {
      const row = visible(owner, id);
      if (!row) return null;
      const stored = versions.find((item) => item.pageId === id && item.version === version);
      if (!stored) return null;
      if (row.revision !== options.baseRevision) return { status: "conflict", page: strip(row) };
      const accepted = options.accept(stored.blocks);
      if (!accepted) return { status: "unrestorable" };
      row.blocks = structuredClone(accepted);
      row.revision += 1;
      return { status: "restored", page: strip(row) };
    },
    async deletePage(owner, id) {
      const row = visible(owner, id);
      if (!row) return null;
      row.deleted = true;
      return "deleted";
    },
  };
  return store;
}

type MemoryStore = ReturnType<typeof memoryStore>;

/** 会話の記録（直した・作ったページも覚える）。 */
function memoryConversations(store: MemoryStore) {
  const turns: (ChatTurnInput & { id: string })[] = [];
  const undone = new Set<string>();
  const changesOf = (messageId: string): AiMessageChange[] => {
    const found = turns.find((item) => item.id === messageId);
    return (found?.changes ?? []).map((change) => ({
      pageId: change.pageId,
      title: store.rows.get(change.pageId)?.title ?? "",
      change: change.change,
      version: change.version ?? null,
      revision: change.revision,
      chars: change.chars,
      delta: change.delta,
      undoneAt: undone.has(`${messageId}/${change.pageId}`) ? NOW.toISOString() : null,
    }));
  };
  const conversations: ChatConversationStore & { turns: typeof turns } = {
    turns,
    async references(owner, pageId) {
      const open = store.rows.get(pageId);
      if (!open || open.owner !== owner || open.deleted || open.parent === null) return null;
      return [...store.rows.values()]
        .filter((row) => row.owner === owner && !row.deleted && row.parent === open.parent && row.id !== open.id)
        .map((row) => ({ id: row.id, title: row.title, kind: row.kind, blocks: row.blocks }));
    },
    async workspace(owner, pageId) {
      const open = store.rows.get(pageId);
      if (!open || open.owner !== owner || open.deleted) return null;
      const pages: ChatWorkspacePage[] = [{ id: open.id, title: open.title, kind: open.kind, parent: open.parent, open: true }];
      for (const row of store.rows.values()) {
        if (row.owner !== owner || row.deleted || row.id === open.id) continue;
        if (row.parent === open.id || row.id === open.parent) pages.push({ id: row.id, title: row.title, kind: row.kind, parent: row.parent, open: false });
      }
      return pages;
    },
    async history(owner, pageId, conversationId) {
      const found = turns.filter((item) => item.conversationId === conversationId || item.id === conversationId);
      if (conversationId !== "chat-1" && found.length === 0) return null;
      const messages: AiMessage[] = [];
      return { messages };
    },
    async append(owner, input) {
      const id = `message-${turns.length + 1}`;
      turns.push({ ...input, id });
      return {
        conversation: { id: input.conversationId ?? "chat-1" },
        result: {
          id,
          seq: turns.length * 2,
          role: "assistant",
          text: input.reply,
          preset: null,
          proposal: null,
          adopted: null,
          version: null,
          adoptedAt: null,
          items: input.items,
          result: input.result,
          resultCode: input.resultCode ?? null,
          route: input.author?.route ?? null,
          engine: input.author?.engine ?? null,
          changes: changesOf(id),
          createdAt: NOW.toISOString(),
        },
      };
    },
    async changes(owner, pageId, messageId) {
      const found = turns.find((item) => item.id === messageId && item.pageId === pageId);
      if (!found) return null;
      return changesOf(messageId).filter((change) => change.undoneAt === null);
    },
    async undone(owner, messageId, pageIds) {
      for (const pageId of pageIds) undone.add(`${messageId}/${pageId}`);
      return pageIds.length;
    },
  };
  return conversations;
}

function memoryUsage(seed = 0) {
  let costMicroUsd = seed;
  const records: number[] = [];
  const sources: string[] = [];
  const store: ChatUsageStore & { records: number[]; sources: string[]; total: () => number } = {
    records,
    sources,
    total: () => costMicroUsd,
    async get(owner, month) {
      return { owner, month, source: "server", requests: records.length, inputTokens: 0, outputTokens: 0, costMicroUsd };
    },
    async record(owner, month, delta, source = "server") {
      sources.push(source);
      records.push(delta.costMicroUsd);
      if (source === "server") costMicroUsd += delta.costMicroUsd;
      return { owner, month, source, requests: records.length, inputTokens: 0, outputTokens: 0, costMicroUsd };
    },
  };
  return store;
}

function authAs(userId: string | null): AuthProvider {
  const notUsed = async (): Promise<Response> => {
    throw new Error("the chat API never calls the login routes");
  };
  return { mode: "stub", getSession: async () => (userId ? { userId, mode: "stub" } : null), beginLogin: notUsed, completeLogin: notUsed, logout: notUsed };
}

/** 決まった答えを順に返す偽のモデル。 */
function stubBackend(answers: Turn[]): AiComposeBackend & { calls: number } {
  let index = 0;
  const backend = {
    model: "claude-sonnet-5-5",
    provider: "claude" as const,
    route: "server" as const,
    engine: "anthropic:claude-sonnet-5-5",
    client: {
      complete: async () => {
        throw new Error("the chat uses converse");
      },
      converse: async () => {
        const answer = answers[index];
        index += 1;
        if (!answer) throw new Error("the model was called more times than the test planned");
        return answer;
      },
    },
  };
  return Object.defineProperty(backend, "calls", { get: () => index }) as unknown as AiComposeBackend & { calls: number };
}

type Options = {
  store?: MemoryStore | null;
  conversations?: ChatConversationStore | null;
  usage?: ReturnType<typeof memoryUsage> | null;
  ai?: AiComposeBackend | null;
  limitUsd?: number | null;
};

function deps(userId: string | null, store: MemoryStore, options: Options = {}): ChatApiDeps {
  return {
    auth: () => authAs(userId),
    store: () => (options.store === undefined ? store : options.store),
    conversations: () => (options.conversations === undefined ? memoryConversations(store) : options.conversations),
    usage: () => (options.usage === undefined ? memoryUsage() : options.usage),
    ai: () => (options.ai === undefined ? stubBackend([turn({ text: "何もしていません。" })]) : options.ai),
    limitUsd: () => options.limitUsd ?? null,
    now: () => NOW,
    env: {},
  };
}

function request(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method, headers: { host: "editor.test", origin: ORIGIN, "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

const chat = (id: string, body: unknown, d: ChatApiDeps) => runAiChat(request("POST", `/api/pages/${id}/ai/chat`, body), id, d);
const undo = (id: string, messageId: string, d: ChatApiDeps) =>
  undoAiChat(request("POST", `/api/pages/${id}/ai/chat/${messageId}/undo`, {}), id, messageId, d);
const deviceTurn = (id: string, body: unknown, d: ChatApiDeps) => recordDeviceChatTurn(request("POST", `/api/pages/${id}/ai/chat/turns`, body), id, d);

const writeTurn = (pageId: string, markdown: string, reply = "直しました。") => [
  turn({ toolCalls: [{ id: "t1", name: "write_page", input: { page_id: pageId, markdown } }], stopReason: "tool_use" }),
  turn({ text: reply }),
];

describe("POST /api/pages/{id}/ai/chat", () => {
  it("lets the model write the page, leaves the body it replaced as a version, and records the turn", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { title: "合成の座談会", blocks: [p("合成の一段落目")] });
    const chats = memoryConversations(store);
    const d = deps("user-a", store, { ai: stubBackend(writeTurn(page.id, "## 見出し\n\n新しい本文")), conversations: chats });

    const response = await chat(page.id, { text: "見出しを付けて" }, d);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { message: { result: string; changes: { version: number; delta: number }[] }; page: Page | null };

    // ページは依頼の中で書き換わる（採用を待たない）
    expect(store.rows.get(page.id)!.blocks).toEqual([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "見出し" }] },
      p("新しい本文"),
    ]);
    // 書く前の本文は版に残る（元に戻せる）
    expect(store.versions).toEqual([{ pageId: page.id, version: 1, blocks: [p("合成の一段落目")] }]);
    expect(body.message.result).toBe("done");
    expect(body.message.changes[0]).toMatchObject({ version: 1 });
    expect(body.page?.blocks).toHaveLength(2);
    expect(chats.turns[0]).toMatchObject({ input: "見出しを付けて", reply: "直しました。", result: "done" });
  });

  it("keeps the work summary of the turn (tool, page and whether it worked)", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { title: "合成の座談会", blocks: [p("本文")] });
    const chats = memoryConversations(store);
    const ai = stubBackend([
      turn({ text: "読みます。", toolCalls: [{ id: "t1", name: "read_page", input: { page_id: page.id } }], stopReason: "tool_use" }),
      turn({ toolCalls: [{ id: "t2", name: "write_page", input: { page_id: page.id, markdown: "直した本文" } }], stopReason: "tool_use" }),
      turn({ text: "直しました。" }),
    ]);
    await chat(page.id, { text: "直して" }, deps("user-a", store, { ai, conversations: chats }));
    expect(chats.turns[0]!.items).toEqual([
      { kind: "narration", text: "読みます。" },
      { kind: "tool", tool: "read_page", page: "合成の座談会", ok: true },
      { kind: "tool", tool: "write_page", page: "合成の座談会", ok: true },
    ]);
  });

  it("refuses a page outside the conversation's workspace without writing anything", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { blocks: [p("本文")] });
    const other = store.add("user-b", { blocks: [p("他人の本文")] });
    const far = store.add("user-a", { blocks: [p("同じ人の別の場所")] });
    const ai = stubBackend([
      turn({
        toolCalls: [
          { id: "t1", name: "write_page", input: { page_id: other.id, markdown: "書き換え" } },
          { id: "t2", name: "write_page", input: { page_id: far.id, markdown: "書き換え" } },
        ],
        stopReason: "tool_use",
      }),
      turn({ text: "書けませんでした。" }),
    ]);
    const chats = memoryConversations(store);
    expect((await chat(page.id, { text: "全部書き換えて" }, deps("user-a", store, { ai, conversations: chats }))).status).toBe(200);
    expect(store.rows.get(other.id)!.blocks).toEqual([p("他人の本文")]);
    expect(store.rows.get(far.id)!.blocks).toEqual([p("同じ人の別の場所")]);
    expect(store.versions).toEqual([]);
    expect(chats.turns[0]!.changes).toEqual([]);
    expect(chats.turns[0]!.items).toEqual([
      { kind: "tool", tool: "write_page", page: null, ok: false },
      { kind: "tool", tool: "write_page", page: null, ok: false },
    ]);
  });

  it("can read and write the subpages and the parent of the open page", async () => {
    const store = memoryStore();
    const parent = store.add("user-a", { title: "合成の録音", blocks: [p("文字起こし")] });
    const page = store.add("user-a", { title: "記事本文", blocks: [p("本文")], parent: parent.id });
    const sibling = store.add("user-a", { title: "記事方針", blocks: [p("方針")], parent: parent.id });
    const ai = stubBackend([
      turn({ toolCalls: [{ id: "t1", name: "list_pages", input: {} }], stopReason: "tool_use" }),
      turn({ toolCalls: [{ id: "t2", name: "write_page", input: { page_id: parent.id, markdown: "直した文字起こし" } }], stopReason: "tool_use" }),
      turn({ text: "直しました。" }),
    ]);
    const chats = memoryConversations(store);
    await chat(page.id, { text: "親を直して" }, deps("user-a", store, { ai, conversations: chats }));
    expect(store.rows.get(parent.id)!.blocks).toEqual([p("直した文字起こし")]);
    expect(chats.turns[0]!.changes).toHaveLength(1);
    // 兄弟は作業場に入らない（開いているページの親・子だけ）
    expect(store.rows.get(sibling.id)!.blocks).toEqual([p("方針")]);
  });

  it("refuses a page whose body cannot be text (an image or a recording), and writes nothing", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { title: "写真のページ", blocks: [p("本文"), { type: "image", attrs: { assetId: randomUUID() } }] });
    const ai = stubBackend([
      turn({ toolCalls: [{ id: "t1", name: "write_page", input: { page_id: page.id, markdown: "置き換え" } }], stopReason: "tool_use" }),
      turn({ text: "直せませんでした。" }),
    ]);
    const before = structuredClone(store.rows.get(page.id)!.blocks);
    const chats = memoryConversations(store);
    await chat(page.id, { text: "直して" }, deps("user-a", store, { ai, conversations: chats }));
    expect(store.rows.get(page.id)!.blocks).toEqual(before);
    expect(store.versions).toEqual([]);
    expect(chats.turns[0]!.items).toEqual([{ kind: "tool", tool: "write_page", page: "写真のページ", ok: false }]);
  });

  it("reports the page size limit instead of a revision conflict when an AI write is too large", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { title: "合成のページ", blocks: [p("元の本文")] });
    const originalSave = store.savePage;
    store.savePage = async () => ({ status: "page_full" });
    const ai = stubBackend([
      turn({ toolCalls: [{ id: "t1", name: "write_page", input: { page_id: page.id, markdown: "長い画像付き本文" } }], stopReason: "tool_use" }),
      turn({ text: "容量を超えたので保存できませんでした。" }),
    ]);
    const chats = memoryConversations(store);

    await chat(page.id, { text: "本文を更新して" }, deps("user-a", store, { ai, conversations: chats }));

    expect(store.rows.get(page.id)!.blocks).toEqual([p("元の本文")]);
    expect(chats.turns[0]!.items).toEqual([{ kind: "tool", tool: "write_page", page: "合成のページ", ok: false }]);
    expect(ai.calls).toBe(2);
    store.savePage = originalSave;
  });

  it("keeps one version per turn when the model writes the same page twice", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { blocks: [p("もとの本文")] });
    const ai = stubBackend([
      turn({ toolCalls: [{ id: "t1", name: "write_page", input: { page_id: page.id, markdown: "一度目" } }], stopReason: "tool_use" }),
      turn({ toolCalls: [{ id: "t2", name: "write_page", input: { page_id: page.id, markdown: "二度目" } }], stopReason: "tool_use" }),
      turn({ text: "直しました。" }),
    ]);
    const chats = memoryConversations(store);
    await chat(page.id, { text: "直して" }, deps("user-a", store, { ai, conversations: chats }));
    expect(store.rows.get(page.id)!.blocks).toEqual([p("二度目")]);
    // 戻す先は「依頼の前の本文」の版（最初の 1 つ）
    expect(chats.turns[0]!.changes).toEqual([{ pageId: page.id, change: "edited", version: 1, revision: 3, chars: 3, delta: -2 }]);
  });

  it("creates a page when the model asks for one, and records it as created", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { blocks: [p("本文")] });
    const ai = stubBackend([
      turn({ toolCalls: [{ id: "t1", name: "create_page", input: { title: "合成のまとめ", markdown: "まとめの本文" } }], stopReason: "tool_use" }),
      turn({ text: "作りました。" }),
    ]);
    const chats = memoryConversations(store);
    await chat(page.id, { text: "まとめを作って" }, deps("user-a", store, { ai, conversations: chats }));
    const created = [...store.rows.values()].find((row) => row.title === "合成のまとめ");
    expect(created?.blocks).toEqual([p("まとめの本文")]);
    expect(chats.turns[0]!.changes).toEqual([{ pageId: created!.id, change: "created", version: null, revision: 1, chars: 6, delta: 6 }]);
  });

  it("does not call the model when the month is over the limit, and writes nothing", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { blocks: [p("本文")] });
    const ai = stubBackend(writeTurn(page.id, "書き換え"));
    const chats = memoryConversations(store);
    const response = await chat(page.id, { text: "直して" }, deps("user-a", store, { ai, conversations: chats, usage: memoryUsage(10_000_000), limitUsd: 10 }));
    expect([response.status, await response.text()]).toEqual([429, '{"error":"quota_exceeded"}']);
    expect(ai.calls).toBe(0);
    expect(store.versions).toEqual([]);
    expect(chats.turns).toEqual([]);
  });

  it("stops in the middle when the limit is reached during the turn, and keeps what it wrote", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { blocks: [p("もとの本文")] });
    const usageStore = memoryUsage();
    const ai = stubBackend([
      turn({ toolCalls: [{ id: "t1", name: "write_page", input: { page_id: page.id, markdown: "書き換え" } }], stopReason: "tool_use" }),
      turn({ text: "まだ途中です。" }),
    ]);
    const chats = memoryConversations(store);
    const d = deps("user-a", store, { ai, conversations: chats, usage: usageStore, limitUsd: 0.000001 });
    const response = await chat(page.id, { text: "直して" }, d);
    expect(response.status).toBe(200);
    // 1 往復目は通り、2 往復目の前で止まる（書いた分はそのまま・版も残る）
    expect(ai.calls).toBe(1);
    expect(store.rows.get(page.id)!.blocks).toEqual([p("書き換え")]);
    expect(chats.turns[0]).toMatchObject({ result: "stopped", resultCode: "quota_exceeded" });
  });

  it("answers 401, 404, 503 and 400 before doing anything", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { blocks: [p("本文")] });
    const ai = stubBackend(writeTurn(page.id, "書き換え"));

    expect((await chat(page.id, { text: "直して" }, deps(null, store, { ai }))).status).toBe(401);
    // 他人のページと無いページは同じ 404
    const theirs = await chat(page.id, { text: "直して" }, deps("user-b", store, { ai }));
    const missing = await chat(randomUUID(), { text: "直して" }, deps("user-a", store, { ai }));
    expect([theirs.status, await theirs.text()]).toEqual([404, '{"error":"not_found"}']);
    expect([missing.status, await missing.text()]).toEqual([404, '{"error":"not_found"}']);
    expect((await chat(page.id, { text: "直して" }, deps("user-a", store, { ai: null }))).status).toBe(503);
    expect((await chat(page.id, { text: "   " }, deps("user-a", store, { ai }))).status).toBe(400);
    expect((await chat(page.id, { text: "あ".repeat(2_001) }, deps("user-a", store, { ai }))).status).toBe(400);
    expect(ai.calls).toBe(0);
    expect(store.versions).toEqual([]);
  });

  it("refuses a conversation that is not this page's, before calling the model", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { blocks: [p("本文")] });
    const ai = stubBackend(writeTurn(page.id, "書き換え"));
    const chats = memoryConversations(store);
    const response = await chat(page.id, { text: "直して", conversationId: "someone-elses" }, deps("user-a", store, { ai, conversations: chats }));
    expect(response.status).toBe(404);
    expect(ai.calls).toBe(0);
  });
});

describe("POST /api/pages/{id}/ai/chat/{messageId}/undo", () => {
  it("puts the body back to what it was before the turn", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { blocks: [p("もとの本文")] });
    const chats = memoryConversations(store);
    const ai = stubBackend(writeTurn(page.id, "AI が書いた本文"));
    const d = deps("user-a", store, { ai, conversations: chats });
    const body = (await (await chat(page.id, { text: "直して" }, d)).json()) as { conversation: { messageId: string } };
    expect(store.rows.get(page.id)!.blocks).toEqual([p("AI が書いた本文")]);

    const response = await undo(page.id, body.conversation.messageId, d);
    expect(response.status).toBe(200);
    const undone = (await response.json()) as { undone: string[]; kept: unknown[]; page: Page | null };
    expect(undone.undone).toEqual([page.id]);
    expect(undone.kept).toEqual([]);
    expect(store.rows.get(page.id)!.blocks).toEqual([p("もとの本文")]);
    expect(undone.page?.blocks).toEqual([p("もとの本文")]);

    // 二度目は戻すものが無い
    const again = (await (await undo(page.id, body.conversation.messageId, d)).json()) as { undone: string[] };
    expect(again.undone).toEqual([]);
  });

  it("puts a page the turn created into the trash", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { blocks: [p("本文")] });
    const ai = stubBackend([
      turn({ toolCalls: [{ id: "t1", name: "create_page", input: { title: "合成のまとめ", markdown: "まとめ" } }], stopReason: "tool_use" }),
      turn({ text: "作りました。" }),
    ]);
    const chats = memoryConversations(store);
    const d = deps("user-a", store, { ai, conversations: chats });
    const body = (await (await chat(page.id, { text: "まとめを作って" }, d)).json()) as { conversation: { messageId: string } };
    const created = [...store.rows.values()].find((row) => row.title === "合成のまとめ")!;
    expect(created.deleted).toBe(false);

    await undo(page.id, body.conversation.messageId, d);
    expect(store.rows.get(created.id)!.deleted).toBe(true);
  });

  it("leaves a page the person changed afterwards, and says so", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { blocks: [p("もとの本文")] });
    const chats = memoryConversations(store);
    const d = deps("user-a", store, { ai: stubBackend(writeTurn(page.id, "AI が書いた本文")), conversations: chats });
    const body = (await (await chat(page.id, { text: "直して" }, d)).json()) as { conversation: { messageId: string } };
    // 人がそのあと直した（revision が進む）
    const row = store.rows.get(page.id)!;
    row.blocks = [p("人が直した本文")];
    row.revision += 1;

    const undone = (await (await undo(page.id, body.conversation.messageId, d)).json()) as { undone: string[]; kept: { reason: string }[] };
    expect(undone.undone).toEqual([]);
    expect(undone.kept).toEqual([{ pageId: page.id, reason: "changed" }]);
    expect(store.rows.get(page.id)!.blocks).toEqual([p("人が直した本文")]);
  });

  it("answers 401 and the same 404 for another owner's turn", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { blocks: [p("本文")] });
    const chats = memoryConversations(store);
    const d = deps("user-a", store, { ai: stubBackend(writeTurn(page.id, "書き換え")), conversations: chats });
    const body = (await (await chat(page.id, { text: "直して" }, d)).json()) as { conversation: { messageId: string } };

    expect((await undo(page.id, body.conversation.messageId, deps(null, store, { conversations: chats }))).status).toBe(401);
    expect((await undo(page.id, "message-99", d)).status).toBe(404);
    expect(store.rows.get(page.id)!.blocks).toEqual([p("書き換え")]);
  });
});

describe("the chat never leaks what it is working on", () => {
  it("logs only the route and the name of a failure", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { title: "秘密の題名", blocks: [p("秘密の本文")] });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // 作業場を読む所で落ちる（ここは書く前なので 500 で止めてよい）
      const broken: ChatConversationStore = {
        workspace: async () => {
          throw new Error("合成の失敗");
        },
        history: async () => ({ messages: [] }),
        append: async () => null,
        changes: async () => null,
        undone: async () => 0,
      };
      const response = await chat(page.id, { text: "秘密の指示" }, deps("user-a", store, { conversations: broken }));
      expect(response.status).toBe(500);
      const text = JSON.stringify(logged.mock.calls);
      expect(text).not.toContain("秘密の本文");
      expect(text).not.toContain("秘密の指示");
      expect(text).not.toContain("秘密の題名");
    } finally {
      logged.mockRestore();
    }
  });
});

describe("the chat reads the other pages of the folder", () => {
  it("lets the model read them but not write them", async () => {
    const store = memoryStore();
    const folder = store.add("user-a", { title: "合成のフォルダ" });
    const page = store.add("user-a", { title: "開いているページ", blocks: [p("本文")], parent: folder.id });
    const other = store.add("user-a", { title: "同じフォルダのページ", blocks: [p("参考の本文")], parent: folder.id });
    const ai = stubBackend([
      turn({ toolCalls: [{ id: "t1", name: "list_pages", input: {} }], stopReason: "tool_use" }),
      turn({ toolCalls: [{ id: "t2", name: "read_page", input: { page_id: other.id } }], stopReason: "tool_use" }),
      turn({ toolCalls: [{ id: "t3", name: "write_page", input: { page_id: other.id, markdown: "書き換え" } }], stopReason: "tool_use" }),
      turn({ text: "読むだけにしました。" }),
    ]);
    const chats = memoryConversations(store);
    await chat(page.id, { text: "同じフォルダを見て" }, deps("user-a", store, { ai, conversations: chats }));
    // 読めるが書けない（書き換えは断られ、版も残らない）
    expect(store.rows.get(other.id)!.blocks).toEqual([p("参考の本文")]);
    expect(store.versions).toEqual([]);
    expect(chats.turns[0]!.items).toEqual([
      { kind: "tool", tool: "list_pages", page: null, ok: true },
      { kind: "tool", tool: "read_page", page: "同じフォルダのページ", ok: true },
      { kind: "tool", tool: "write_page", page: "同じフォルダのページ", ok: false },
    ]);
  });
});

describe("POST /api/pages/{id}/ai/chat/turns (この Mac の CLI の結果)", () => {
  const body = (pageId: string, markdown = "CLI が書いた本文") => ({
    input: "直して",
    reply: "直しました。",
    engine: "cli:claude-code",
    writes: [{ pageId, markdown, baseRevision: 1 }],
  });

  it("writes through the same path: a version is left, the turn is recorded as device, and the model is never called", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { title: "合成のページ", blocks: [p("もとの本文")] });
    const chats = memoryConversations(store);
    const ai = stubBackend([]);
    const usage = memoryUsage();
    const response = await deviceTurn(page.id, body(page.id), deps("user-a", store, { ai, conversations: chats, usage }));
    expect(response.status).toBe(200);

    expect(ai.calls).toBe(0);
    expect(store.rows.get(page.id)!.blocks).toEqual([p("CLI が書いた本文")]);
    expect(store.versions).toEqual([{ pageId: page.id, version: 1, blocks: [p("もとの本文")] }]);
    expect(chats.turns[0]).toMatchObject({ input: "直して", reply: "直しました。", result: "done", author: { route: "device", engine: "cli:claude-code" } });
    // サブスクなので金額は数えず、device の行に回数だけ残る
    expect(usage.sources).toEqual(["device"]);
    expect(usage.records).toEqual([0]);
    expect(usage.total()).toBe(0);
  });

  it("is not stopped by the month's limit (the CLI does not cost per use)", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { title: "合成のページ", blocks: [p("もとの本文")] });
    const usage = memoryUsage(10_000_000);
    const response = await deviceTurn(page.id, body(page.id), deps("user-a", store, { usage, limitUsd: 10 }));
    expect(response.status).toBe(200);
    expect(store.rows.get(page.id)!.blocks).toEqual([p("CLI が書いた本文")]);
  });

  it("can be undone like any other turn", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { title: "合成のページ", blocks: [p("もとの本文")] });
    const chats = memoryConversations(store);
    const d = deps("user-a", store, { conversations: chats });
    const answer = (await (await deviceTurn(page.id, body(page.id), d)).json()) as { conversation: { messageId: string } };
    await undo(page.id, answer.conversation.messageId, d);
    expect(store.rows.get(page.id)!.blocks).toEqual([p("もとの本文")]);
  });

  it("refuses a CLI write made against an older page revision", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { title: "合成のページ", blocks: [p("もとの本文")] });
    await store.savePage("user-a", page.id, { blocks: [p("別端末の保存")] }, { baseRevision: 1 });
    const response = await deviceTurn(page.id, body(page.id), deps("user-a", store));
    expect(response.status).toBe(409);
    expect(store.rows.get(page.id)!.blocks).toEqual([p("別端末の保存")]);
    expect(store.versions).toEqual([]);
  });

  it("keeps the save CAS when another write races after the device preflight", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { title: "合成のページ", blocks: [p("もとの本文")] });
    const originalVersion = store.createVersion;
    store.createVersion = async (owner, id, reason) => {
      const version = await originalVersion(owner, id, reason);
      await store.savePage(owner, id, { blocks: [p("競合した保存")] }, { baseRevision: 1 });
      return version;
    };
    const response = await deviceTurn(page.id, body(page.id), deps("user-a", store));
    expect(response.status).toBe(200);
    expect((await response.json()).message).toMatchObject({ result: "stopped", resultCode: "revision_conflict" });
    expect(store.rows.get(page.id)!.blocks).toEqual([p("競合した保存")]);
  });

  it("checks every pageId against the workspace itself (it does not trust what the Mac sends)", async () => {
    const store = memoryStore();
    const folder = store.add("user-a", { title: "合成のフォルダ" });
    const page = store.add("user-a", { title: "合成のページ", blocks: [p("もとの本文")], parent: folder.id });
    // 他人のページ・同じ人の別の場所のページ・同じフォルダのページ（読むだけ）は、どれも書けない
    const theirs = store.add("user-b", { blocks: [p("他人の本文")] });
    const far = store.add("user-a", { blocks: [p("同じ人の別の場所")] });
    const sibling = store.add("user-a", { title: "同じフォルダのページ", blocks: [p("参考の本文")], parent: folder.id });
    const chats = memoryConversations(store);

    for (const target of [theirs, far, sibling]) {
      const before = structuredClone(store.rows.get(target.id)!.blocks);
      const response = await deviceTurn(page.id, body(target.id), deps("user-a", store, { conversations: chats }));
      expect(response.status).toBe(200);
      expect(store.rows.get(target.id)!.blocks, target.id).toEqual(before);
      expect(chats.turns.at(-1)).toMatchObject({ result: "stopped", resultCode: "write_refused" });
      expect(chats.turns.at(-1)!.changes).toEqual([]);
    }
    // 版も残らない（書く前に断っている）
    expect(store.versions).toEqual([]);
  });

  it("answers 401, 404 and 400 before writing anything", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { title: "合成のページ", blocks: [p("もとの本文")] });
    expect((await deviceTurn(page.id, body(page.id), deps(null, store))).status).toBe(401);
    expect((await deviceTurn(page.id, body(page.id), deps("user-b", store))).status).toBe(404);
    expect((await deviceTurn(randomUUID(), body(page.id), deps("user-a", store))).status).toBe(404);
    for (const bad of [
      { ...body(page.id), engine: "CLI Claude Code" },
      { ...body(page.id), input: "" },
      { ...body(page.id), writes: [{ pageId: page.id }] },
      { ...body(page.id), writes: [{ pageId: page.id, markdown: "合成", baseRevision: 0 }] },
      { ...body(page.id), writes: "nope" },
      { ...body(page.id), extra: 1 },
    ]) {
      expect((await deviceTurn(page.id, bad, deps("user-a", store))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(store.versions).toEqual([]);
  });

  it("refuses a conversation that is not this page's", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { title: "合成のページ", blocks: [p("もとの本文")] });
    const chats = memoryConversations(store);
    const response = await deviceTurn(page.id, { ...body(page.id), conversationId: "someone-elses" }, deps("user-a", store, { conversations: chats }));
    expect(response.status).toBe(404);
    expect(store.versions).toEqual([]);
  });
});

describe("会話に書けなくても、書いたページは返す", () => {
  it("answers 200 with the page it wrote when the conversation cannot keep the turn", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { title: "合成のページ", blocks: [p("もとの本文")] });
    const chats = memoryConversations(store);
    const broken: ChatConversationStore = {
      ...chats,
      append: async () => {
        throw new Error("synthetic database failure");
      },
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await chat(page.id, { text: "直して" }, deps("user-a", store, { ai: stubBackend(writeTurn(page.id, "書き換え")), conversations: broken }));
      // 書いた分と版は残っているので、500 にはしない（ページが変わったのに失敗に見せない）
      expect(response.status).toBe(200);
      const body = (await response.json()) as { conversation: unknown; page: Page | null };
      expect(body.conversation).toBeNull();
      expect(body.page?.blocks).toEqual([p("書き換え")]);
      expect(store.rows.get(page.id)!.blocks).toEqual([p("書き換え")]);
      expect(store.versions).toHaveLength(1);
      expect(JSON.stringify(log.mock.calls)).not.toContain("書き換え");
    } finally {
      log.mockRestore();
    }
  });

  it("answers 200 for the CLI's write-back when the conversation cannot keep it", async () => {
    const store = memoryStore();
    const page = store.add("user-a", { title: "合成のページ", blocks: [p("もとの本文")] });
    const chats = memoryConversations(store);
    const broken: ChatConversationStore = {
      ...chats,
      append: async () => {
        throw new Error("synthetic database failure");
      },
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await deviceTurn(
        page.id,
        { input: "直して", reply: "直しました。", engine: "cli:claude-code", writes: [{ pageId: page.id, markdown: "CLI が書いた本文", baseRevision: 1 }] },
        deps("user-a", store, { conversations: broken }),
      );
      expect(response.status).toBe(200);
      expect(store.rows.get(page.id)!.blocks).toEqual([p("CLI が書いた本文")]);
    } finally {
      log.mockRestore();
    }
  });
});
