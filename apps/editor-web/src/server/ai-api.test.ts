import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AiConversation, AiConversationSummary, AiMessage, AiUsageSource, AiUsageTotals } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { getAiConversation, getAiUsageSummary, listAiConversations, type AiApiDeps, type AiConversationStore, type AiUsageStore, type UsageSummary } from "./ai-api";

/**
 * 会話の読み出しと使用量の API（提案 → 採用の API は #278 で外した）。合成の値だけを使う。
 */

const ORIGIN = "http://editor.test";
const NOW = new Date("2026-10-15T03:00:00Z");
const MONTH = "2026-10";

/** owner・月ごとの使用量（経路ごと）。 */
function memoryUsage() {
  const rows = new Map<string, AiUsageTotals>();
  const zero = (owner: string, month: string, source: AiUsageSource): AiUsageTotals => ({ owner, month, source, requests: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 });
  const usage = {
    rows,
    async get(owner: string, month: string, source: AiUsageSource = "server"): Promise<AiUsageTotals> {
      return { ...(rows.get(`${owner}/${month}/${source}`) ?? zero(owner, month, source)) };
    },
    seed(owner: string, month: string, totals: Partial<AiUsageTotals>, source: AiUsageSource = "server") {
      rows.set(`${owner}/${month}/${source}`, { ...zero(owner, month, source), ...totals });
    },
  };
  return usage satisfies AiUsageStore;
}

type MemoryUsage = ReturnType<typeof memoryUsage>;

/** owner とページで絞る会話（ai-conversations.ts と同じ約束: 他人のもの・無いものはどちらも null）。 */
function memoryConversations() {
  type Row = { id: string; owner: string; pageId: string; messages: AiMessage[] };
  const rows: Row[] = [];
  const summary = (row: Row): AiConversationSummary => ({
    id: row.id,
    pageId: row.pageId,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    messages: row.messages.length,
    lastText: row.messages.at(-1)?.text ?? null,
  });
  const message = (seq: number, role: AiMessage["role"], text: string): AiMessage => ({
    id: randomUUID(),
    seq,
    role,
    text,
    preset: null,
    proposal: null,
    adopted: null,
    version: null,
    adoptedAt: null,
    items: null,
    result: null,
    resultCode: null,
    route: null,
    engine: null,
    changes: [],
    pageId: null,
    pageTitle: null,
    createdAt: NOW.toISOString(),
  });
  const pages = new Map<string, string>();
  return {
    pages,
    add(owner: string, pageId: string, texts: string[]): string {
      const row: Row = { id: randomUUID(), owner, pageId, messages: texts.map((text, index) => message(index + 1, index % 2 === 0 ? "user" : "assistant", text)) };
      rows.push(row);
      return row.id;
    },
    // 会話は利用者のもの（#312）。pageId は開いているページが本人のものかの確認だけ
    async list(owner: string, pageId: string): Promise<AiConversationSummary[] | null> {
      if (pages.get(pageId) !== owner) return null;
      return rows.filter((row) => row.owner === owner).map(summary).reverse();
    },
    async get(owner: string, pageId: string, conversationId: string): Promise<AiConversation | null> {
      if (pages.get(pageId) !== owner) return null;
      const row = rows.find((item) => item.id === conversationId && item.owner === owner);
      return row ? { conversation: summary(row), messages: [...row.messages] } : null;
    },
  } satisfies AiConversationStore & Record<string, unknown>;
}

function authAs(userId: string | null): AuthProvider {
  const notUsed = async (): Promise<Response> => {
    throw new Error("the AI API never calls the login routes");
  };
  return { mode: "stub", getSession: async () => (userId ? { userId, mode: "stub" } : null), beginLogin: notUsed, completeLogin: notUsed, logout: notUsed };
}

type Options = { usage?: MemoryUsage | null; conversations?: ReturnType<typeof memoryConversations> | null; limitUsd?: number | null };

function deps(userId: string | null, options: Options = {}): AiApiDeps {
  const usage = options.usage === undefined ? memoryUsage() : options.usage;
  const chats = options.conversations === undefined ? memoryConversations() : options.conversations;
  return {
    auth: () => authAs(userId),
    usage: () => usage,
    conversations: () => chats,
    limitUsd: () => options.limitUsd ?? null,
    now: () => NOW,
  };
}

function request(path: string): Request {
  return new Request(`${ORIGIN}${path}`, { method: "GET", headers: { host: "editor.test" } });
}

const usageOf = (d: AiApiDeps) => getAiUsageSummary(request("/api/ai/usage"), d);
const listChats = (id: string, d: AiApiDeps) => listAiConversations(request(`/api/pages/${id}/ai/conversations`), id, d);
const openChat = (id: string, conversationId: string, d: AiApiDeps) => getAiConversation(request(`/api/pages/${id}/ai/conversations/${conversationId}`), id, conversationId, d);

describe("GET /api/ai/usage", () => {
  it("answers the month's server usage against the limit, and the device usage as counts only", async () => {
    const usage = memoryUsage();
    usage.seed("user-a", MONTH, { requests: 3, inputTokens: 300, outputTokens: 90, costMicroUsd: 1_600_000 });
    const response = await usageOf(deps("user-a", { usage, limitUsd: 2 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      usage: { month: MONTH, inputTokens: 300, outputTokens: 90, costUsd: 1.6, limitUsd: 2, nearLimit: true } satisfies UsageSummary,
      device: null,
    });

    const both: MemoryUsage & { bySource: NonNullable<AiUsageStore["bySource"]> } = Object.assign(memoryUsage(), {
      bySource: async (owner: string, month: string) => ({
        server: { owner, month, source: "server" as const, requests: 1, inputTokens: 10, outputTokens: 5, costMicroUsd: 0 },
        device: { owner, month, source: "device" as const, requests: 4, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
      }),
    });
    expect(await (await usageOf(deps("user-a", { usage: both }))).json()).toEqual({
      usage: { month: MONTH, inputTokens: 10, outputTokens: 5, costUsd: 0, limitUsd: null, nearLimit: false },
      device: { month: MONTH, requests: 4, inputTokens: 0, outputTokens: 0 },
    });
  });

  it("answers 401 without a session, 503 without a database, and 500 without internal details", async () => {
    expect([(await usageOf(deps(null))).status]).toEqual([401]);
    const away = await usageOf(deps("user-a", { usage: null }));
    expect([away.status, await away.text()]).toEqual([503, '{"error":"unavailable"}']);
    const broken = memoryUsage();
    broken.get = async () => {
      throw Object.assign(new Error("SELECT secret_column FROM ai_usage"), { code: "42P01" });
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failed = await usageOf(deps("user-a", { usage: broken }));
      expect([failed.status, await failed.text()]).toEqual([500, '{"error":"internal"}']);
      expect(JSON.stringify(log.mock.calls)).not.toContain("SELECT");
    } finally {
      log.mockRestore();
    }
  });
});

describe("the conversations of the owner (from any page)", () => {
  it("lists the owner's conversations newest first, from whichever page they were started on, and opens one with its messages", async () => {
    const chats = memoryConversations();
    const pageId = randomUUID();
    const otherPage = randomUUID();
    chats.pages.set(pageId, "user-a");
    chats.pages.set(otherPage, "user-a");
    const d = deps("user-a", { conversations: chats });
    expect(((await (await listChats(pageId, d)).json()) as { conversations: AiConversationSummary[] }).conversations).toEqual([]);
    const first = chats.add("user-a", pageId, ["合成の頼み", "合成の返答"]);
    const second = chats.add("user-a", otherPage, ["次の頼み", "次の返答"]);
    const list = ((await (await listChats(pageId, d)).json()) as { conversations: AiConversationSummary[] }).conversations;
    expect(list.map((item) => item.id)).toEqual([second, first]);
    expect(list[0]).toMatchObject({ pageId: otherPage, messages: 2, lastText: "次の返答" });
    // 別のページを開いていても同じ一覧・同じ会話
    expect(((await (await listChats(otherPage, d)).json()) as { conversations: AiConversationSummary[] }).conversations.map((item) => item.id)).toEqual([second, first]);
    const opened = (await (await openChat(otherPage, first, d)).json()) as AiConversation;
    expect(opened.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "合成の頼み"],
      ["assistant", "合成の返答"],
    ]);
  });

  it("is only the owner's own: another owner's conversation and a missing page are the same 404", async () => {
    const chats = memoryConversations();
    const pageId = randomUUID();
    chats.pages.set(pageId, "user-a");
    const conversationId = chats.add("user-a", pageId, ["合成の頼み", "合成の返答"]);
    const theirs = deps("user-b", { conversations: chats });
    const mine = deps("user-a", { conversations: chats });
    const missing = await openChat(randomUUID(), conversationId, mine);
    const other = await openChat(pageId, conversationId, theirs);
    expect([missing.status, await missing.text()]).toEqual([404, '{"error":"not_found"}']);
    expect([other.status, await other.text()]).toEqual([404, '{"error":"not_found"}']);
    expect((await listChats(pageId, theirs)).status).toBe(404);
  });

  it("answers 401 without a session and 503 while the database is away, marking every response uncacheable", async () => {
    const pageId = randomUUID();
    const responses = [
      await listChats(pageId, deps(null)),
      await openChat(pageId, randomUUID(), deps(null)),
      await listChats(pageId, deps("user-a", { conversations: null })),
      await openChat(pageId, randomUUID(), deps("user-a", { conversations: null })),
      await usageOf(deps("user-a")),
    ];
    expect(responses.map((response) => response.status)).toEqual([401, 401, 503, 503, 200]);
    for (const response of responses) {
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  });
});
