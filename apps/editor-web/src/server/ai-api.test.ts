import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EDITOR_SETTINGS, type AiUsageDelta, type AiUsageTotals, type Block, type CreatePageInput, type EditorSettings, type Page, type PagePatch, type PageVersionSummary, type SaveOptions, type SaveResult, type VersionReason } from "@niho/editor-store";
import { AnthropicError, createAnthropicModel } from "../ai/anthropic";
import { resolveAiBackend, type AiBackend } from "../ai/config";
import type { Proposal } from "../ai/engine";
import type { AiModel, AiRequest, AiUsageReport } from "../ai/model";
import type { AuthProvider } from "../auth/types";
import { adoptAiProposal, createAiProposal, getAiUsageSummary, type AiApiDeps, type AiPagesStore, type AiUsageStore, type UsageSummary } from "./ai-api";
import { MAX_BODY_BYTES } from "./http";

const ORIGIN = "http://editor.test";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOW = new Date("2026-10-15T03:00:00Z");
const MONTH = "2026-10";

type Row = Page & { owner: string; deleted: boolean };
type VersionRow = { pageId: string; version: number; reason: VersionReason; blocks: Block[] };

/** owner ごとに分けた、メモリの中だけの合成の store（EditorStore と同じ約束: 該当なしは null、revision の不一致は conflict）。 */
function memoryStore() {
  const rows = new Map<string, Row>();
  const versions: VersionRow[] = [];
  /** 呼ばれた更新の順（版を残す → 保存 の順を確かめる）。 */
  const writes: string[] = [];
  const visible = (owner: string, id: string) => {
    if (!UUID.test(id)) return null;
    const row = rows.get(id);
    return row && row.owner === owner && !row.deleted ? row : null;
  };
  const strip = (row: Row): Page => {
    const page: Partial<Row> = structuredClone(row);
    delete page.owner;
    delete page.deleted;
    return page as Page;
  };
  const store = {
    rows,
    versions,
    writes,
    async createPage(owner: string, input: CreatePageInput = {}): Promise<Page> {
      const now = new Date().toISOString();
      const page: Page = { id: randomUUID(), kind: input.kind ?? "note", title: input.title ?? "", lang: input.lang ?? "ja", blocks: input.blocks ?? [], cover: null, lead: null, parent: null, recipe: null, stepStatus: null, sortOrder: 0, revision: 1, createdAt: now, updatedAt: now };
      rows.set(page.id, { ...structuredClone(page), owner, deleted: false });
      return page;
    },
    async getPage(owner: string, id: string): Promise<Page | null> {
      const row = visible(owner, id);
      return row ? strip(row) : null;
    },
    async savePage(owner: string, id: string, patch: PagePatch, options: SaveOptions): Promise<SaveResult | null> {
      writes.push("savePage");
      const row = visible(owner, id);
      if (!row) return null;
      if (row.revision !== options.baseRevision) return { status: "conflict", page: strip(row) };
      Object.assign(row, structuredClone(patch), { revision: row.revision + 1, updatedAt: new Date().toISOString() });
      return { status: "saved", page: strip(row) };
    },
    async createVersion(owner: string, id: string, reason: VersionReason): Promise<PageVersionSummary | null> {
      writes.push(`createVersion:${reason}`);
      const row = visible(owner, id);
      if (!row) return null;
      const version = (versions.filter((item) => item.pageId === id).at(-1)?.version ?? 0) + 1;
      versions.push({ pageId: id, version, reason, blocks: structuredClone(row.blocks) });
      return { version, reason, createdAt: new Date().toISOString(), blockCount: row.blocks.length };
    },
  };
  return store satisfies AiPagesStore;
}

type MemoryStore = ReturnType<typeof memoryStore>;

/** owner・月ごとの使用量（recordAiUsage と同じ約束: 足した後の合計を返す）。 */
function memoryUsage() {
  const rows = new Map<string, AiUsageTotals>();
  const zero = (owner: string, month: string): AiUsageTotals => ({ owner, month, requests: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 });
  const usage = {
    rows,
    async get(owner: string, month: string): Promise<AiUsageTotals> {
      return { ...(rows.get(`${owner}/${month}`) ?? zero(owner, month)) };
    },
    async record(owner: string, month: string, delta: AiUsageDelta): Promise<AiUsageTotals> {
      const current = rows.get(`${owner}/${month}`) ?? zero(owner, month);
      const next = {
        owner,
        month,
        requests: current.requests + delta.requests,
        inputTokens: current.inputTokens + delta.inputTokens,
        outputTokens: current.outputTokens + delta.outputTokens,
        costMicroUsd: current.costMicroUsd + delta.costMicroUsd,
      };
      rows.set(`${owner}/${month}`, next);
      return { ...next };
    },
    seed(owner: string, month: string, costMicroUsd: number) {
      rows.set(`${owner}/${month}`, { ...zero(owner, month), requests: 1, costMicroUsd });
    },
  };
  return usage satisfies AiUsageStore;
}

type MemoryUsage = ReturnType<typeof memoryUsage>;

/** 決まった出力と使用量を返す合成のモデル（呼ばれた要求を残す）。 */
function stubBackend(respond: (request: AiRequest) => unknown, report: Partial<AiUsageReport> = {}, provider: AiBackend["provider"] = null) {
  const calls: AiRequest[] = [];
  const model: AiModel = {
    async run(request) {
      calls.push(request);
      return { output: respond(request), usage: { model: "synthetic-model", inputTokens: 10, outputTokens: 5, ...report } };
    },
  };
  return { backend: { model, provider } satisfies AiBackend, calls };
}

const fake = (): AiBackend | null => resolveAiBackend({ EDITOR_AI_MODE: "fake", NODE_ENV: "test" });

/** AI の API が呼ぶのは getSession だけ。ログインの経路（AuthProvider の残り）は使わない。 */
const notUsed = async (): Promise<Response> => {
  throw new Error("the AI API never calls the login routes");
};

function authAs(userId: string | null): AuthProvider {
  return {
    mode: "stub",
    getSession: async () => (userId ? { userId, mode: "stub" } : null),
    beginLogin: notUsed,
    completeLogin: notUsed,
    logout: notUsed,
  };
}

type Options = { usage?: MemoryUsage | null; ai?: () => AiBackend | null; limitUsd?: number | null; settings?: EditorSettings | null };

function deps(userId: string | null, store: MemoryStore | null, options: Options = {}): AiApiDeps {
  const usage = options.usage === undefined ? memoryUsage() : options.usage;
  return {
    auth: () => authAs(userId),
    store: () => store,
    usage: () => (store ? usage : null),
    settings: options.settings === undefined ? undefined : () => (options.settings === null ? null : async () => options.settings!),
    ai: options.ai ?? fake,
    limitUsd: () => options.limitUsd ?? null,
    now: () => NOW,
    env: {},
  };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method, headers: { host: "editor.test", ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }), ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

const propose = (id: string, body: unknown, d: AiApiDeps, headers?: Record<string, string>) => createAiProposal(request("POST", `/api/pages/${id}/ai/proposals`, body, headers), id, d);
const adopt = (id: string, body: unknown, d: AiApiDeps, headers?: Record<string, string>) => adoptAiProposal(request("POST", `/api/pages/${id}/ai/adoptions`, body, headers), id, d);
const usageOf = (d: AiApiDeps) => getAiUsageSummary(request("GET", "/api/ai/usage"), d);

/** date 以外の header を並べたもの（同じ応答かどうかを比べる）。 */
async function snapshot(response: Response) {
  const headers = [...response.headers.entries()].filter(([name]) => name !== "date").sort();
  return { status: response.status, headers, body: await response.text() };
}

const p = (value: string): Block => ({ type: "paragraph", content: [{ type: "text", text: value }] });
const heading = (value: string): Block => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: value }] });
const bullet = (value: string): Block => ({ type: "bulletList", content: [{ type: "listItem", content: [p(value)] }] });
const bold = (value: string): Block => ({ type: "paragraph", content: [{ type: "text", text: value, marks: [{ type: "bold" }] }] });

const sample = (): Block[] => [p("合成の  一段落目"), heading("合成の見出し"), bullet("合成の項目"), bold("すでに整っています。")];

type ProposalBody = { proposal: Proposal; usage: UsageSummary };

describe("POST /api/pages/{id}/ai/proposals", () => {
  it("returns a proposal with word diffs and the month's usage, and writes nothing to the page", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: sample() });
    const before = structuredClone(store.rows.get(page.id));
    const usage = memoryUsage();

    const response = await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store, { usage }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as ProposalBody;
    expect(Object.keys(body).sort()).toEqual(["proposal", "usage"]);
    expect(body.proposal).toEqual({
      label: "整える",
      baseRevision: 1,
      changes: [{ index: 0, before: "合成の  一段落目", after: "[fake] 合成の 一段落目。", parts: [{ ins: "[fake] " }, "合成の", { del: "  " }, { ins: " " }, "一段落目", { ins: "。" }] }],
      inserts: [],
      unchanged: 2,
    });
    // 偽物の usage: 送った文字数（9 + 6 + 5 + 10）・返した文字数（16）の 1/4（切り上げ）。金額は 0
    expect(body.usage).toEqual({ month: MONTH, inputTokens: 8, outputTokens: 4, costUsd: 0, limitUsd: null, nearLimit: false });

    // 提案ではページに何も書かない（保存も版も無い）
    expect(store.writes).toEqual([]);
    expect(store.versions).toEqual([]);
    expect(store.rows.get(page.id)).toEqual(before);
  });

  it("sends the 固有名詞 and the 提案の言語 from the settings (#108) to the model", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("合成の 一")], lang: "ja" });
    const glossary = [{ term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌"], note: "合成" }];
    const stub = stubBackend(() => ({ edits: [], inserts: [] }));
    const settings: EditorSettings = { aiLang: "en", glossary, recipes: [] };
    const d = deps("user-a", store, { ai: () => stub.backend, settings });
    expect((await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, d)).status).toBe(200);
    expect(stub.calls[0]?.glossary).toEqual(glossary);
    expect(stub.calls[0]?.lang).toBe("en");
  });

  it("falls back to the page's language and no 語彙 when the settings say 書いた言語のまま or cannot be read", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("合成の 一")], lang: "ja" });
    for (const settings of [DEFAULT_EDITOR_SETTINGS, null, undefined]) {
      const stub = stubBackend(() => ({ edits: [], inserts: [] }));
      const d = deps("user-a", store, { ai: () => stub.backend, settings });
      expect((await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, d)).status).toBe(200);
      expect(stub.calls[0]?.glossary).toEqual([]);
      expect(stub.calls[0]?.lang).toBe("ja");
    }
  });

  it("adds the usage of every proposal to the owner's month", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("合成の 一")] });
    const usage = memoryUsage();
    const d = deps("user-a", store, { usage });
    const first = (await (await propose(page.id, { baseRevision: 1, intent: { preset: "toEnglish" } }, d)).json()) as ProposalBody;
    const second = (await (await propose(page.id, { baseRevision: 1, intent: { preset: "toEnglish" } }, d)).json()) as ProposalBody;
    expect(second.usage.inputTokens).toBe(first.usage.inputTokens * 2);
    expect(second.usage.outputTokens).toBe(first.usage.outputTokens * 2);
    expect(usage.rows.get(`user-a/${MONTH}`)?.requests).toBe(2);
    expect(usage.rows.has(`user-b/${MONTH}`)).toBe(false);

    const read = await usageOf(d);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ usage: second.usage });
  });

  it("estimates the cost from the price table, warns near the limit, and stops with 429 before calling the model", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("合成")] });
    const usage = memoryUsage();
    // claude-sonnet-5: 入力 $2・出力 $10 / 100 万トークン → 1 回 $3
    const { backend, calls } = stubBackend(() => ({ edits: [], inserts: [] }), { model: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 100_000 }, "claude");
    const d = deps("user-a", store, { usage, ai: () => backend, limitUsd: 5 });
    const ask = () => propose(page.id, { baseRevision: 1, intent: { text: "短く" } }, d);

    const first = (await (await ask()).json()) as ProposalBody;
    expect(first.usage).toEqual({ month: MONTH, inputTokens: 1_000_000, outputTokens: 100_000, costUsd: 3, limitUsd: 5, nearLimit: false });
    const second = (await (await ask()).json()) as ProposalBody;
    expect(second.usage).toMatchObject({ costUsd: 6, limitUsd: 5, nearLimit: true });
    expect(calls).toHaveLength(2);

    const refused = await ask();
    expect(refused.status).toBe(429);
    expect(await refused.text()).toBe('{"error":"quota_exceeded"}');
    expect(calls).toHaveLength(2);
    expect(usage.rows.get(`user-a/${MONTH}`)?.costMicroUsd).toBe(6_000_000);

    // 単価表に無いモデルは 0（推測しない）
    const unknown = stubBackend(() => ({}), { model: "claude-unknown", inputTokens: 1_000_000 }, "claude");
    const free = (await (await propose(page.id, { baseRevision: 1, intent: { text: "短く" } }, deps("user-a", store, { ai: () => unknown.backend }))).json()) as ProposalBody;
    expect(free.usage.costUsd).toBe(0);
  });

  it("answers 429 at exactly the limit and flags 80% as near the limit", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("合成")] });
    const at = memoryUsage();
    at.seed("user-a", MONTH, 2_000_000);
    const { backend, calls } = stubBackend(() => ({}));
    expect((await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store, { usage: at, ai: () => backend, limitUsd: 2 }))).status).toBe(429);
    expect(calls).toHaveLength(0);
    // 別の月・別の owner の使用量は数えない
    expect((await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store, { ai: () => backend, limitUsd: 2 }))).status).toBe(200);

    const near = memoryUsage();
    near.seed("user-a", MONTH, 1_600_000);
    expect(((await (await usageOf(deps("user-a", store, { usage: near, limitUsd: 2 }))).json()) as { usage: UsageSummary }).usage.nearLimit).toBe(true);
    near.seed("user-a", MONTH, 1_599_999);
    expect(((await (await usageOf(deps("user-a", store, { usage: near, limitUsd: 2 }))).json()) as { usage: UsageSummary }).usage).toEqual({
      month: MONTH,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 1.599999,
      limitUsd: 2,
      nearLimit: false,
    });
    // 上限 0（数として読めない設定も 0）は全て止める
    expect((await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store, { ai: () => backend, limitUsd: 0 }))).status).toBe(429);
  });

  it("drops edits for a preset that only adds text and keeps the inserts", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("一"), p("二")] });
    const { backend } = stubBackend(() => ({ edits: [{ index: 0, text: "勝手な書き換え" }], inserts: [{ afterIndex: -1, kind: "paragraph", text: "要約" }] }));
    const body = (await (await propose(page.id, { baseRevision: 1, intent: { preset: "summarize" } }, deps("user-a", store, { ai: () => backend }))).json()) as ProposalBody;
    expect(body.proposal).toEqual({ label: "要約", baseRevision: 1, changes: [], inserts: [{ afterIndex: -1, kind: "paragraph", text: "要約" }], unchanged: 2 });
  });

  it("sends only the selected range, splits a long page into several requests, and answers an empty proposal for an empty page", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("一"), p("二"), p("三")] });
    const scoped = (await (await propose(page.id, { baseRevision: 1, intent: { preset: "toEnglish" }, scope: { fromIndex: 1, toIndex: 1 } }, deps("user-a", store))).json()) as ProposalBody;
    expect(scoped.proposal.changes.map((change) => [change.index, change.after])).toEqual([[1, "[fake EN] 二"]]);
    expect(scoped.proposal.unchanged).toBe(0);

    const long = await store.createPage("user-a", { blocks: [p("あ".repeat(7000)), p("い".repeat(7000)), p("う".repeat(7000))] });
    const usage = memoryUsage();
    const { backend, calls } = stubBackend((aiRequest) => ({ edits: aiRequest.paragraphs.map((paragraph) => ({ index: paragraph.index, text: `${paragraph.index}` })) }));
    const split = (await (await propose(long.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store, { usage, ai: () => backend }))).json()) as ProposalBody;
    expect(calls.map((call) => call.paragraphs.map((paragraph) => paragraph.index))).toEqual([[0], [1], [2]]);
    expect(split.proposal.changes.map((change) => change.after)).toEqual(["0", "1", "2"]);
    expect(usage.rows.get(`user-a/${MONTH}`)?.requests).toBe(3);

    const empty = await store.createPage("user-a");
    const before = calls.length;
    const response = await propose(empty.id, { baseRevision: 1, intent: { preset: "summarize" } }, deps("user-a", store, { ai: () => backend }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as ProposalBody).proposal).toEqual({ label: "要約", baseRevision: 1, changes: [], inserts: [], unchanged: 0 });
    expect(calls.length).toBe(before);
  });

  it("answers 409 with the current page to a stale baseRevision without calling the model", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("一")] });
    await store.savePage("user-a", page.id, { blocks: [p("別の画面")] }, { baseRevision: 1 });
    const { backend, calls } = stubBackend(() => ({}));
    const response = await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store, { ai: () => backend }));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; page: Page };
    expect(Object.keys(body).sort()).toEqual(["error", "page"]);
    expect(body).toMatchObject({ error: "conflict", page: { id: page.id, revision: 2, blocks: [p("別の画面")] } });
    expect(body.page).not.toHaveProperty("owner");
    expect(calls).toEqual([]);
  });

  it("answers 502 when the model fails or returns output that does not pass the checks, still recording what was used", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("一"), bullet("項目")] });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bad = [
      "not json",
      { edits: [{ index: 1, text: "箇条書きは変えない" }] },
      { edits: [{ index: 5, text: "範囲外" }] },
      { edits: [{ index: 0, text: "" }] },
      { inserts: [{ afterIndex: 0, kind: "script", text: "x" }] },
      { edits: [{ index: 0, text: "秘密の出力 a\u0000b" }] },
    ];
    for (const output of bad) {
      const usage = memoryUsage();
      const { backend } = stubBackend(() => output);
      const response = await propose(page.id, { baseRevision: 1, intent: { text: "直して" } }, deps("user-a", store, { usage, ai: () => backend }));
      expect(response.status, JSON.stringify(output)).toBe(502);
      expect(await response.text()).toBe('{"error":"ai_failed"}');
      expect(usage.rows.get(`user-a/${MONTH}`)?.requests).toBe(1);
    }

    const usage = memoryUsage();
    const throwing: AiModel = {
      async run() {
        throw Object.assign(new Error("upstream said: secret prompt text"), { name: "ProviderError" });
      },
    };
    const failed = await propose(page.id, { baseRevision: 1, intent: { text: "直して" } }, deps("user-a", store, { usage, ai: () => ({ model: throwing, provider: null }) }));
    expect(failed.status).toBe(502);
    expect(await failed.text()).toBe('{"error":"ai_failed"}');
    expect(usage.rows.size).toBe(0);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain("secret prompt text");
    expect(logged).not.toContain("秘密の出力");
    expect(logged).toContain("ProviderError");
    log.mockRestore();
    expect(store.writes).toEqual([]);
  });

  it("answers 413 above 1 MiB and too_large above 30,000 characters of text", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("一")] });
    const big = JSON.stringify({ baseRevision: 1, intent: { text: "a".repeat(MAX_BODY_BYTES) } });
    const tooBig = await propose(page.id, big, deps("user-a", store));
    expect(tooBig.status).toBe(413);
    expect(await tooBig.text()).toBe('{"error":"payload_too_large"}');

    const huge = await store.createPage("user-a", { blocks: Array.from({ length: 4 }, () => p("あ".repeat(10_000))) });
    const { backend, calls } = stubBackend(() => ({}));
    const tooLarge = await propose(huge.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store, { ai: () => backend }));
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.text()).toBe('{"error":"too_large"}');
    // 範囲を選べば送れる
    expect((await propose(huge.id, { baseRevision: 1, intent: { preset: "tidy" }, scope: { fromIndex: 0, toIndex: 2 } }, deps("user-a", store, { ai: () => backend }))).status).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("answers 400 to bodies that are not JSON or not the right shape, and to a range outside the page", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("一"), p("二")] });
    const { backend, calls } = stubBackend(() => ({}));
    const bad: Array<[unknown, Record<string, string>?]> = [
      ["{", undefined],
      [{ baseRevision: 1, intent: { preset: "tidy" } }, { "content-type": "text/plain" }],
      [{}, undefined],
      [{ intent: { preset: "tidy" } }, undefined],
      [{ baseRevision: 0, intent: { preset: "tidy" } }, undefined],
      [{ baseRevision: "1", intent: { preset: "tidy" } }, undefined],
      [{ baseRevision: 1 }, undefined],
      [{ baseRevision: 1, intent: "tidy" }, undefined],
      [{ baseRevision: 1, intent: { preset: "rewriteEverything" } }, undefined],
      [{ baseRevision: 1, intent: { text: "" } }, undefined],
      [{ baseRevision: 1, intent: { text: "あ".repeat(501) } }, undefined],
      [{ baseRevision: 1, intent: { preset: "tidy", text: "x" } }, undefined],
      [{ baseRevision: 1, intent: { preset: "tidy" }, owner: "user-b" }, undefined],
      [{ baseRevision: 1, intent: { preset: "tidy" }, scope: { fromIndex: -1, toIndex: 0 } }, undefined],
      [{ baseRevision: 1, intent: { preset: "tidy" }, scope: { fromIndex: 1, toIndex: 0 } }, undefined],
      [{ baseRevision: 1, intent: { preset: "tidy" }, scope: { fromIndex: 0, toIndex: 1.5 } }, undefined],
      [{ baseRevision: 1, intent: { preset: "tidy" }, scope: { fromIndex: 0 } }, undefined],
      [{ baseRevision: 1, intent: { preset: "tidy" }, scope: { fromIndex: 0, toIndex: 0, extra: 1 } }, undefined],
      // 範囲が本文の外（ページを読んでから確かめる）
      [{ baseRevision: 1, intent: { preset: "tidy" }, scope: { fromIndex: 0, toIndex: 2 } }, undefined],
    ];
    for (const [body, headers] of bad) {
      const response = await propose(page.id, body, deps("user-a", store, { ai: () => backend }), headers);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).toBe('{"error":"bad_request"}');
    }
    expect(calls).toEqual([]);
  });
});

describe("POST /api/pages/{id}/ai/adoptions", () => {
  it("keeps the current body as an ai version first, then saves only the adopted changes with the baseRevision", async () => {
    const store = memoryStore();
    const original = [p("合成の  一段落目"), bold("太字のまま"), bullet("項目")];
    const page = await store.createPage("user-a", { blocks: original });
    const d = deps("user-a", store);
    const proposal = ((await (await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, d)).json()) as ProposalBody).proposal;
    expect(proposal.changes.map((change) => change.index)).toEqual([0, 1]);
    const save = vi.spyOn(store, "savePage");

    // 1 つ目だけ採用し、見出しを 1 つ差し込む
    const response = await adopt(
      page.id,
      { baseRevision: proposal.baseRevision, changes: [{ index: 0, text: proposal.changes[0]!.after }], inserts: [{ afterIndex: -1, kind: "heading", text: "見出し" }] },
      d,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { page: Page };
    expect(Object.keys(body)).toEqual(["page"]);
    expect(body.page.revision).toBe(2);
    expect(body.page.blocks).toEqual([heading("見出し"), p("[fake] 合成の 一段落目。"), bold("太字のまま"), bullet("項目")]);
    expect(store.writes).toEqual(["createVersion:ai", "savePage"]);
    expect(save.mock.calls[0]?.[3]).toEqual({ baseRevision: 1 });
    // 履歴から戻せる（採用の前の本文が ai の版に残る）
    expect(store.versions).toEqual([{ pageId: page.id, version: 1, reason: "ai", blocks: original }]);
  });

  it("answers 409 with the current page to a stale baseRevision and writes nothing", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("一")] });
    await store.savePage("user-a", page.id, { blocks: [p("別の画面")] }, { baseRevision: 1 });
    store.writes.length = 0;
    const response = await adopt(page.id, { baseRevision: 1, changes: [{ index: 0, text: "採用" }], inserts: [] }, deps("user-a", store));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "conflict", page: { revision: 2, blocks: [p("別の画面")] } });
    expect(store.writes).toEqual([]);
    expect(store.versions).toEqual([]);
  });

  it("answers 409 when another save lands between keeping the version and saving", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("一")] });
    const keep = store.createVersion.bind(store);
    store.createVersion = async (owner, id, reason) => {
      const kept = await keep(owner, id, reason);
      // 別の画面の保存が先に入る
      Object.assign(store.rows.get(id)!, { blocks: [p("別の画面")], revision: 2 });
      return kept;
    };
    const response = await adopt(page.id, { baseRevision: 1, changes: [{ index: 0, text: "採用" }], inserts: [] }, deps("user-a", store));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "conflict", page: { revision: 2, blocks: [p("別の画面")] } });
    expect(store.rows.get(page.id)?.blocks).toEqual([p("別の画面")]);
  });

  it("answers 400 to bodies of the wrong shape and to adoptions that do not fit the current body, writing nothing", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("一"), bullet("項目")] });
    const bad: unknown[] = [
      {},
      { baseRevision: 1 },
      { baseRevision: 1, changes: [], inserts: [] },
      { changes: [{ index: 0, text: "x" }] },
      { baseRevision: 0, changes: [{ index: 0, text: "x" }] },
      { baseRevision: 1, changes: {} },
      { baseRevision: 1, changes: [{ index: "0", text: "x" }] },
      { baseRevision: 1, changes: [{ index: -1, text: "x" }] },
      { baseRevision: 1, changes: [{ index: 0, text: 1 }] },
      { baseRevision: 1, changes: [{ index: 0, text: "x", marks: [] }] },
      { baseRevision: 1, inserts: [{ afterIndex: -2, kind: "paragraph", text: "x" }] },
      { baseRevision: 1, inserts: [{ afterIndex: 0, kind: "image", text: "x" }] },
      { baseRevision: 1, inserts: [{ afterIndex: 0, kind: "paragraph" }] },
      { baseRevision: 1, changes: [{ index: 0, text: "x" }], blocks: [] },
      // 今の本文に合わない（ページを読んでから確かめる）
      { baseRevision: 1, changes: [{ index: 1, text: "箇条書き" }] },
      { baseRevision: 1, changes: [{ index: 2, text: "範囲外" }] },
      { baseRevision: 1, changes: [{ index: 0, text: "" }] },
      { baseRevision: 1, changes: [{ index: 0, text: "一" }, { index: 0, text: "二" }] },
      { baseRevision: 1, inserts: [{ afterIndex: 2, kind: "paragraph", text: "範囲外" }] },
    ];
    for (const body of bad) {
      const response = await adopt(page.id, body, deps("user-a", store));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).toBe('{"error":"bad_request"}');
    }
    expect(store.writes).toEqual([]);
    expect(store.rows.get(page.id)?.revision).toBe(1);
  });
});

describe("AI routes: shared rules", () => {
  it("answers the same 404 for another owner's page, an unknown id, a malformed id and a deleted page — even when the baseRevision would conflict", async () => {
    const store = memoryStore();
    const theirs = await store.createPage("user-b", { blocks: [p("theirs")] });
    const removed = await store.createPage("user-a", { blocks: [p("removed")] });
    store.rows.get(removed.id)!.deleted = true;
    const ids = [theirs.id, randomUUID(), "not-a-uuid", "../../etc", removed.id];
    const { backend, calls } = stubBackend(() => ({}));
    const d = deps("user-a", store, { ai: () => backend });
    const cases: Array<[string, (id: string) => Promise<Response>]> = [
      ["propose current", (id) => propose(id, { baseRevision: 1, intent: { preset: "tidy" } }, d)],
      ["propose stale", (id) => propose(id, { baseRevision: 9, intent: { text: "x" } }, d)],
      ["propose scope", (id) => propose(id, { baseRevision: 1, intent: { preset: "tidy" }, scope: { fromIndex: 0, toIndex: 0 } }, d)],
      ["adopt current", (id) => adopt(id, { baseRevision: 1, changes: [{ index: 0, text: "x" }] }, d)],
      ["adopt stale", (id) => adopt(id, { baseRevision: 9, inserts: [{ afterIndex: -1, kind: "paragraph", text: "x" }] }, d)],
      ["adopt unfit", (id) => adopt(id, { baseRevision: 1, changes: [{ index: 5, text: "x" }] }, d)],
    ];
    let first: Awaited<ReturnType<typeof snapshot>> | undefined;
    for (const [label, call] of cases) {
      const results = await Promise.all(ids.map(async (id) => snapshot(await call(id))));
      first ??= results[0];
      for (const result of results) expect(result, label).toEqual(first);
    }
    expect(first?.status).toBe(404);
    expect(first?.body).toBe('{"error":"not_found"}');
    expect(calls).toEqual([]);
    expect(store.writes).toEqual([]);
    expect(store.rows.get(theirs.id)).toMatchObject({ revision: 1, blocks: [p("theirs")] });
  });

  it("answers 401 without a session on every route", async () => {
    const store = memoryStore();
    const id = randomUUID();
    for (const response of [
      await propose(id, { baseRevision: 1, intent: { preset: "tidy" } }, deps(null, store)),
      await adopt(id, { baseRevision: 1, changes: [{ index: 0, text: "x" }] }, deps(null, store)),
      await usageOf(deps(null, store)),
    ]) {
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('{"error":"unauthorized"}');
    }
  });

  it("answers 403 to proposals and adoptions from another origin or without an Origin", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("一")] });
    const { backend, calls } = stubBackend(() => ({}));
    for (const origin of ["https://evil.example", "null", ""]) {
      const d = deps("user-a", store, { ai: () => backend });
      for (const response of [
        await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, d, { origin }),
        await adopt(page.id, { baseRevision: 1, changes: [{ index: 0, text: "x" }] }, d, { origin }),
      ]) {
        expect(response.status, origin).toBe(403);
        expect(await response.text()).toBe('{"error":"forbidden"}');
      }
    }
    expect(calls).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  it("answers 413 to an adoption above 1 MiB", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("一")] });
    const big = JSON.stringify({ baseRevision: 1, changes: [{ index: 0, text: "a".repeat(MAX_BODY_BYTES) }] });
    expect((await adopt(page.id, big, deps("user-a", store))).status).toBe(413);
    expect(store.writes).toEqual([]);
  });

  it("answers 503 without a database, and ai_unavailable when AI is off or the fake model is asked for in production", async () => {
    const id = randomUUID();
    for (const response of [
      await propose(id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", null)),
      await adopt(id, { baseRevision: 1, changes: [{ index: 0, text: "x" }] }, deps("user-a", null)),
      await usageOf(deps("user-a", null)),
    ]) {
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('{"error":"unavailable"}');
    }

    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("一")] });
    const off = () => resolveAiBackend({});
    const productionFake = () => resolveAiBackend({ EDITOR_AI_MODE: "fake", NODE_ENV: "production" });
    const unknown = () => resolveAiBackend({ EDITOR_AI_MODE: "some-provider" });
    for (const ai of [off, productionFake, unknown]) {
      for (const response of [
        await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store, { ai })),
        await adopt(page.id, { baseRevision: 1, changes: [{ index: 0, text: "x" }] }, deps("user-a", store, { ai })),
      ]) {
        expect(response.status).toBe(503);
        expect(await response.text()).toBe('{"error":"ai_unavailable"}');
      }
      // 使用量は AI が無効でも読める
      expect((await usageOf(deps("user-a", store, { ai }))).status).toBe(200);
    }
    expect(store.writes).toEqual([]);
  });

  it("answers 500 without internal details when the store or the usage fails", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("一")] });
    const failure = () => Object.assign(new Error('relation "ai_usage" does not exist at SELECT secret_column FROM pages'), { code: "42P01" });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const broken = memoryStore();
    broken.getPage = async () => {
      throw failure();
    };
    const usage = memoryUsage();
    usage.get = async () => {
      throw failure();
    };
    for (const response of [
      await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", broken)),
      await adopt(page.id, { baseRevision: 1, changes: [{ index: 0, text: "x" }] }, deps("user-a", broken)),
      await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store, { usage })),
      await usageOf(deps("user-a", store, { usage })),
    ]) {
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"error":"internal"}');
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain("SELECT");
    log.mockRestore();
  });

  it("marks every response noindex, nofollow and uncacheable", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("一")] });
    const usage = memoryUsage();
    usage.seed("user-a", MONTH, 9_000_000);
    const { backend } = stubBackend(() => "not json");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const responses = [
      await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store)),
      await propose(page.id, { baseRevision: 9, intent: { preset: "tidy" } }, deps("user-a", store)),
      await propose(page.id, "{", deps("user-a", store)),
      await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store, { usage, limitUsd: 1 })),
      await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store, { ai: () => backend })),
      await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store, { ai: () => null })),
      await propose(randomUUID(), { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store)),
      await adopt(page.id, { baseRevision: 1, changes: [{ index: 0, text: "x" }] }, deps("user-a", store)),
      await adopt(page.id, { baseRevision: 1, changes: [{ index: 0, text: "x" }] }, deps("user-a", store)),
      await usageOf(deps("user-a", store)),
      await usageOf(deps(null, store)),
      await usageOf(deps("user-a", null)),
    ];
    log.mockRestore();
    expect(responses.map((response) => response.status)).toEqual([200, 409, 400, 429, 502, 503, 404, 200, 409, 200, 401, 503]);
    for (const response of responses) {
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    }
  });
});

describe("AI routes with the Anthropic adapter (fake fetch)", () => {
  it("proposes from the model's answer and records the cost from the claude-sonnet-5-5 price table", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("合成の  一段落目"), heading("合成の見出し")] });
    const usage = memoryUsage();
    // 合成の鍵。本物の API は呼ばない（fetch は差し替える）
    const key = "synthetic-anthropic-key-0123456789";
    const sent: { url: string; body: { model: string; messages: { content: string }[] }; key: string | null }[] = [];
    let answer = (): Response =>
      Response.json({
        model: "claude-sonnet-5-5",
        content: [{ type: "text", text: '```json\n{"edits":[{"index":0,"text":"合成の一段落目。"}],"inserts":[]}\n```' }],
        stop_reason: "end_turn",
        usage: { input_tokens: 30_000, output_tokens: 4_000 },
      });
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("x-api-key") });
      return answer();
    }) as typeof globalThis.fetch;
    const backend: AiBackend = { model: createAnthropicModel({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: key }, fetch }), provider: "claude" };
    const d = deps("user-a", store, { usage, ai: () => backend, limitUsd: 0.15 });

    const response = await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, d);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ProposalBody;
    expect(body.proposal.changes).toEqual([{ index: 0, before: "合成の  一段落目", after: "合成の一段落目。", parts: ["合成の", { del: "  " }, "一段落目", { ins: "。" }] }]);
    // claude-sonnet-5-5: 入力 $2・出力 $10 / 100 万トークン → 30,000 × 2 + 4,000 × 10 = $0.10
    expect(body.usage).toEqual({ month: MONTH, inputTokens: 30_000, outputTokens: 4_000, costUsd: 0.1, limitUsd: 0.15, nearLimit: false });
    expect(usage.rows.get(`user-a/${MONTH}`)).toMatchObject({ requests: 1, costMicroUsd: 100_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]!.key).toBe(key);
    expect(sent[0]!.body.model).toBe("claude-sonnet-5-5");
    expect(sent[0]!.body.messages[0]!.content).toContain("<untrusted_data>");
    expect(store.writes).toEqual([]);

    // 上流の失敗・読めない出力は 502（鍵・本文はログに出さない）
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    answer = () => new Response("synthetic upstream failure", { status: 529 });
    const overloaded = await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, d);
    expect([overloaded.status, await overloaded.text()]).toEqual([502, '{"error":"ai_failed"}']);
    // トークン数が返らない失敗（HTTP の失敗）は数えない
    expect(usage.rows.get(`user-a/${MONTH}`)).toMatchObject({ requests: 1, costMicroUsd: 100_000 });
    // JSON でない応答も課金されているので数える（10 × 2 + 10 × 10 = 120 micro-USD）
    answer = () => Response.json({ model: "claude-sonnet-5-5", content: [{ type: "text", text: "合成の一段落目 は JSON ではない" }], usage: { input_tokens: 10, output_tokens: 10 } });
    expect((await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, d)).status).toBe(502);
    expect(usage.rows.get(`user-a/${MONTH}`)).toMatchObject({ requests: 2, inputTokens: 30_010, outputTokens: 4_010, costMicroUsd: 100_120 });
    // 出力の上限で途中で切れた応答も 502 で、数える
    answer = () => Response.json({ model: "claude-sonnet-5-5", content: [{ type: "text", text: '{"edits":[{"index":0,"text":"合成' }], stop_reason: "max_tokens", usage: { input_tokens: 10, output_tokens: 12_000 } });
    expect((await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, d)).status).toBe(502);
    expect(usage.rows.get(`user-a/${MONTH}`)).toMatchObject({ requests: 3, costMicroUsd: 100_120 + 120_020 });
    const logged = JSON.stringify(log.mock.calls);
    log.mockRestore();
    expect(logged).not.toContain(key);
    expect(logged).not.toContain("一段落目");
    expect(logged).toContain("AnthropicError");
    expect(logged).toContain('"kind":"overloaded","status":529');
    expect(logged).toContain('"kind":"invalid_output","reason":"max_tokens"');

    // 上限（$0.15）に届いたらモデルを呼ばずに 429（いまは $0.22014）
    const calls = sent.length;
    const refused = await propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, d);
    expect([refused.status, await refused.text()]).toEqual([429, '{"error":"quota_exceeded"}']);
    expect(sent).toHaveLength(calls);
  });
});

describe("AI routes: usage of a failed model call", () => {
  it("counts the usage a model error carries (an answer that came back unusable) and nothing for an error without it", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [p("合成"), p("合成の二")] });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = (error: unknown): AiBackend => ({
      model: {
        async run() {
          throw error;
        },
      },
      provider: "claude",
    });
    const ask = (backend: AiBackend, usage: MemoryUsage) => propose(page.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store, { usage, ai: () => backend }));

    // JSON でない応答（AnthropicError に使用量）: 502 で、使用量が増える
    const counted = memoryUsage();
    const notJson = new AnthropicError("invalid_output", { reason: "not_json", usage: { model: "claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 500 } });
    const response = await ask(failing(notJson), counted);
    expect([response.status, await response.text()]).toEqual([502, '{"error":"ai_failed"}']);
    // 1,000 × 2 + 500 × 10 = 7,000 micro-USD
    expect(counted.rows.get(`user-a/${MONTH}`)).toEqual({ owner: "user-a", month: MONTH, requests: 1, inputTokens: 1_000, outputTokens: 500, costMicroUsd: 7_000 });

    // 使用量の無い例外（HTTP の失敗・時間切れ・AnthropicError でないもの）では増えない
    for (const error of [new AnthropicError("overloaded", { status: 529 }), new AnthropicError("timeout"), Object.assign(new Error("synthetic"), { usage: { model: "claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 500 } })]) {
      const untouched = memoryUsage();
      expect((await ask(failing(error), untouched)).status).toBe(502);
      expect(untouched.rows.size).toBe(0);
    }

    // 先に通った要求の分と、失敗した要求の分を両方数える（長いページを分けたとき）
    const long = await store.createPage("user-a", { blocks: [p("あ".repeat(3_000)), p("い".repeat(3_000))] });
    const both = memoryUsage();
    let call = 0;
    const second: AiBackend = {
      model: {
        async run() {
          call += 1;
          if (call === 1) return { output: { edits: [], inserts: [] }, usage: { model: "claude-sonnet-5-5", inputTokens: 100, outputTokens: 10 } };
          throw new AnthropicError("invalid_output", { reason: "max_tokens", usage: { model: "claude-sonnet-5-5", inputTokens: 200, outputTokens: 20 } });
        },
      },
      provider: "claude",
    };
    expect((await propose(long.id, { baseRevision: 1, intent: { preset: "tidy" } }, deps("user-a", store, { usage: both, ai: () => second }))).status).toBe(502);
    expect(call).toBe(2);
    expect(both.rows.get(`user-a/${MONTH}`)).toMatchObject({ requests: 2, inputTokens: 300, outputTokens: 30, costMicroUsd: 900 });
    log.mockRestore();
    expect(store.writes).toEqual([]);
  });
});
