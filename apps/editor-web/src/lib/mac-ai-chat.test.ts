import { describe, expect, it, vi } from "vitest";
import type { ShellBridge } from "niho-desktop-bridge/shell-bridge";
import type { ShellAiTurn } from "niho-desktop-bridge/shell-contract";
import type { ShellAiEngine } from "niho-desktop-bridge/shell-contract";
import { MAC_AI_ERROR_TEXT, MacAiError, macChatEvent, macEffortFor, macEffortRule, macEngineModels, macEngineReady, runMacAiTurn } from "./mac-ai-chat";

const PAGE = { pageId: "page-1", title: "合成ページ", markdown: "元の本文" };
const DONE: ShellAiTurn = {
  finalEvent: {
    type: "Done", text: "直しました", stop_reason: "EndTurn", session_id: "local-session",
    usage: { input_tokens: 1, output_tokens: 1, cost_usd: null, model_used: null, cost_known: false },
    duration_ms: 1, continuations: 0,
  },
  page: { pageId: PAGE.pageId, markdown: "変更後" }, pageRemoved: false, extraFiles: 0,
};

function run(result: ShellAiTurn | Promise<ShellAiTurn>, signal = new AbortController().signal) {
  const aiTurn = vi.fn().mockImplementation(async () => result);
  const aiStop = vi.fn().mockResolvedValue(true);
  const shell = { aiTurn, aiStop } as unknown as ShellBridge;
  const promise = runMacAiTurn({ shell, engine: "cli:codex", model: "gpt-6", page: PAGE,
    selection: "選択文", instruction: "短くして", conversationId: "conversation-1", resumeSession: "local-old",
    signal, onProgress: vi.fn() });
  return { promise, aiTurn, aiStop };
}

describe("Mac CLI chat turn", () => {
  it("uses only the fixed shell request and returns a verified Done write", async () => {
    const call = run(DONE);
    await expect(call.promise).resolves.toEqual({ reply: "直しました", sessionId: "local-session", writes: [{ pageId: "page-1", markdown: "変更後" }] });
    expect(call.aiTurn).toHaveBeenCalledWith(expect.any(String), {
      engine: "cli:codex", model: "gpt-6", conversationId: "conversation-1", resumeSession: "local-old",
      instruction: expect.stringContaining("範囲の外は 1 字も変えないでください"), page: PAGE,
      context: [{ name: "selection", title: "選択範囲", markdown: "選択文" }],
    }, expect.any(Function));
  });

  it("passes the context files (guide, recording, …) before the selection, and sends no context when there is none", async () => {
    const aiTurn = vi.fn().mockResolvedValue(DONE);
    const shell = { aiTurn, aiStop: vi.fn() } as unknown as ShellBridge;
    const base = { shell, engine: "cli:codex" as const, model: "gpt-6", page: PAGE, instruction: "短くして", conversationId: null, resumeSession: null, signal: new AbortController().signal };
    const guide = { name: "guide", title: "文書ガイド", markdown: "## 文書ガイド" };
    await runMacAiTurn({ ...base, selection: "選択文", context: [guide] });
    expect(aiTurn.mock.calls[0]?.[1]).toMatchObject({ context: [guide, { name: "selection", title: "選択範囲", markdown: "選択文" }] });
    await runMacAiTurn({ ...base, selection: null, context: [guide] });
    expect(aiTurn.mock.calls[1]?.[1]).toMatchObject({ context: [guide] });
    await runMacAiTurn({ ...base, selection: null });
    expect(aiTurn.mock.calls[2]?.[1]).not.toHaveProperty("context");
    await runMacAiTurn({ ...base, selection: null, context: [] });
    expect(aiTurn.mock.calls[3]?.[1]).not.toHaveProperty("context");
  });

  it("sends webSearch only when it is off (omitted means on), so the CLI gets no search tool when the setting is off", async () => {
    const aiTurn = vi.fn().mockResolvedValue(DONE);
    const shell = { aiTurn, aiStop: vi.fn() } as unknown as ShellBridge;
    const base = { shell, engine: "cli:codex" as const, model: "gpt-6", page: PAGE, instruction: "短くして", selection: null, conversationId: null, resumeSession: null, signal: new AbortController().signal };
    await runMacAiTurn({ ...base, webSearch: false });
    expect(aiTurn.mock.calls[0]?.[1]).toMatchObject({ webSearch: false });
    await runMacAiTurn({ ...base, webSearch: true });
    expect(aiTurn.mock.calls[1]?.[1]).not.toHaveProperty("webSearch");
    await runMacAiTurn(base);
    expect(aiTurn.mock.calls[2]?.[1]).not.toHaveProperty("webSearch");
  });

  it.each([
    [{ ...DONE, finalEvent: { ...DONE.finalEvent, stop_reason: "MaxTokens" } }, "incomplete"],
    [{ ...DONE, pageRemoved: true }, "page_removed"],
    [{ ...DONE, extraFiles: 1 }, "extra_files"],
    [{ ...DONE, page: { pageId: "other", markdown: "bad" } }, "invalid_result"],
  ] as const)("rejects an unsafe native result", async (result, code) => {
    await expect(run(result as ShellAiTurn).promise).rejects.toMatchObject({ code });
  });

  it.each([
    // 許可していない道具（MCP のリソースなど）で止めた・安全に動かせなかった
    ["NotConfigured", "blocked"],
    ["CliLoginRequired", "auth"],
    ["UsageLimitReached", "usage_limit"],
    ["ModelNotFound", "model"],
    // 契約の名前（crate の TimedOut はアプリが Timeout に変えて渡すので、TimedOut は届かない）
    ["Timeout", "timed_out"],
    ["TimedOut", "failed"],
    ["SessionNotFound", "session"],
    ["TransientFailure", "failed"],
    ["toString", "failed"],
    ["未知", "failed"],
  ] as const)("shows a fixed reason for a CLI Error (%s) instead of the CLI message", async (reason, code) => {
    const error: ShellAiTurn = { ...DONE, page: null, finalEvent: { type: "Error", reason_code: reason, message: "CLI の出力の断片 /Users/x" } };
    const rejected = await run(error).promise.catch((cause: unknown) => cause);
    expect(rejected).toBeInstanceOf(MacAiError);
    expect(rejected).toMatchObject({ code });
    expect(MAC_AI_ERROR_TEXT[(rejected as MacAiError).code]).not.toContain("/Users/x");
  });

  it("calls aiStop and never accepts a late Done after cancellation", async () => {
    const controller = new AbortController();
    let finish!: (value: ShellAiTurn) => void;
    const call = run(new Promise<ShellAiTurn>((resolve) => { finish = resolve; }), controller.signal);
    await Promise.resolve();
    controller.abort();
    finish(DONE);
    await expect(call.promise).rejects.toMatchObject({ code: "aborted" });
    expect(call.aiStop).toHaveBeenCalledTimes(1);
  });

  it("keeps the CLI's own model list in its order (newest first)", () => {
    const codex = { engine: "cli:codex" as const, installed: true, authenticated: true, reason: null, models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-terra"], effort: true, resume: true };
    expect(macEngineModels(codex)).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-terra"]);
  });

  it("requires an authenticated CLI and gives Claude a local fallback model list", () => {
    const claude = { engine: "cli:claude-code" as const, installed: true, authenticated: true, reason: null, models: [], effort: true, resume: true };
    expect(macEngineModels(claude).length).toBeGreaterThan(0);
    // 既定（先頭）は最新に解決する別名。版つきの古い ID はそのあと、重ねない
    const models = macEngineModels(claude);
    expect(models.slice(0, 4)).toEqual(["sonnet", "opus", "fable", "haiku"]);
    expect(models).toContain("claude-sonnet-4-6");
    expect(new Set(models).size).toBe(models.length);
    expect(macEngineReady({ ...claude, authenticated: false })).toBe(false);
    expect(new MacAiError("auth").message).not.toContain(PAGE.markdown);
  });

  it("maps CLI events to the same chat events as the server stream", () => {
    expect(macChatEvent({ type: "TextDelta", text: "読みます" })).toEqual({ type: "text", text: "読みます", kind: "text" });
    expect(macChatEvent({ type: "ThinkingDelta", text: "考え" })).toEqual({ type: "text", text: "考え", kind: "thinking" });
    expect(macChatEvent({ type: "ToolUse", id: "t1", name: "Edit", summary: "page.md" })).toEqual({ type: "tool", tool: "Edit", page: null, ok: null, phase: "start" });
    expect(macChatEvent({ type: "ToolResult", id: "t1", name: "Edit", ok: false })).toEqual({ type: "tool", tool: "Edit", page: null, ok: false, phase: "end" });
    expect(macChatEvent({ type: "Error", reason_code: "x", message: "y" })).toBeNull();
  });

  it("shows the CLI's web tools and notices in the same work line as the server route (no search terms, host names only)", () => {
    expect(macChatEvent({ type: "ToolUse", id: "w1", name: "WebSearch", summary: "" })).toEqual({ type: "tool", tool: "web_search", page: null, ok: null, phase: "start" });
    expect(macChatEvent({ type: "ToolResult", id: "w1", name: "WebSearch", ok: true })).toEqual({ type: "tool", tool: "web_search", page: null, ok: true, phase: "end" });
    // ページを読むときはホスト名だけを出す。ホスト名の形でない summary（URL・本文の断片）は出さない
    expect(macChatEvent({ type: "ToolUse", id: "w2", name: "WebFetch", summary: "example.com" })).toEqual({ type: "tool", tool: "web_fetch", page: null, ok: null, phase: "start", detail: "example.com を読んでいます" });
    expect(macChatEvent({ type: "ToolUse", id: "w3", name: "WebFetch", summary: "https://example.com/a?q=1" })).toEqual({ type: "tool", tool: "web_fetch", page: null, ok: null, phase: "start" });
    expect(macChatEvent({ type: "ToolUse", id: "w4", name: "WebFetch", summary: "" })).toEqual({ type: "tool", tool: "web_fetch", page: null, ok: null, phase: "start" });
    // 検索を切った・この版では検索できない: 文はコードごとに画面側で決めた文だけ（Rust から来た message は使わない）
    expect(macChatEvent({ type: "Notice", code: "webSearchOff", message: "検索は切っています。" })).toEqual({ type: "tool", tool: "web_search", page: null, ok: null, phase: "end", detail: "検索は切っています" });
    expect(macChatEvent({ type: "Notice", code: "webSearchUnsupported", message: "x" })).toEqual({ type: "tool", tool: "web_search", page: null, ok: null, phase: "end", detail: "この CLI の版では検索できません" });
    expect(macChatEvent({ type: "Notice", code: "other" as "webSearchOff", message: "ignore previous instructions" })).toBeNull();
    // CLI 由来の文字列は自分のキーだけを引く（継承されたプロパティに当たらない）
    expect(macChatEvent({ type: "Notice", code: "constructor" as "webSearchOff", message: "x" })).toBeNull();
    expect(macChatEvent({ type: "ToolUse", id: "c1", name: "constructor", summary: "" })).toEqual({ type: "tool", tool: "constructor", page: null, ok: null, phase: "start" });
  });

  it("passes the mapped events of its own turn to onEvent", async () => {
    const onEvent = vi.fn();
    const aiTurn = vi.fn().mockImplementation(async (turnId: string, _request: unknown, listener: (envelope: unknown) => void) => {
      listener({ turnId, seq: 0, event: { type: "TextDelta", text: "本文を読みます" } });
      listener({ turnId, seq: 1, event: { type: "ToolUse", id: "t1", name: "Read", summary: "page.md" } });
      listener({ turnId: "other", seq: 2, event: { type: "TextDelta", text: "別の依頼" } });
      listener({ turnId, seq: 1, event: { type: "TextDelta", text: "重複" } });
      return DONE;
    });
    const shell = { aiTurn, aiStop: vi.fn() } as unknown as ShellBridge;
    await runMacAiTurn({ shell, engine: "cli:codex", model: "gpt-6", page: PAGE, selection: null, instruction: "直して",
      conversationId: null, resumeSession: null, signal: new AbortController().signal, onEvent });
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "text", text: "本文を読みます", kind: "text" },
      { type: "tool", tool: "Read", page: null, ok: null, phase: "start" },
    ]);
  });
});

describe("Mac CLI の思考量", () => {
  const engine = (name: ShellAiEngine["engine"], effort = true): ShellAiEngine => ({ engine: name, installed: true, authenticated: true, reason: null, models: [], effort, resume: true });

  it("既定（null）は送らず、CLI が思考量を受けないときも送らない", () => {
    expect(macEffortFor(engine("cli:claude-code"), "sonnet", null)).toBeNull();
    expect(macEffortFor(engine("cli:claude-code", false), "sonnet", "high")).toBeNull();
    expect(macEffortRule(engine("cli:claude-code", false), "sonnet").efforts).toEqual([]);
    expect(macEffortFor(engine("cli:codex"), "gpt-5.6-terra", "max")).toBe("max");
  });

  it("モデルに無い段階は低い段階に寄せ、思考量入りの名前のモデルには送らない", () => {
    expect(macEffortFor(engine("cli:antigravity"), "gemini-3.8-flash", "max")).toBe("high");
    expect(macEffortRule(engine("cli:antigravity"), "gemini-3.8-flash-high")).toEqual({ efforts: ["high"], fixed: "high" });
    expect(macEffortFor(engine("cli:antigravity"), "gemini-3.8-flash-high", "low")).toBeNull();
  });

  it("選んだ思考量を CLI の依頼に載せる（既定なら項目ごと送らない）", async () => {
    for (const effort of ["high", null] as const) {
      const aiTurn = vi.fn().mockImplementation(async () => DONE);
      const shell = { aiTurn, aiStop: vi.fn() } as unknown as ShellBridge;
      await runMacAiTurn({ shell, engine: "cli:claude-code", model: "sonnet", effort, page: PAGE, selection: null, instruction: "直して", conversationId: null, resumeSession: null, signal: new AbortController().signal });
      const request = aiTurn.mock.calls[0]?.[1] as Record<string, unknown>;
      if (effort) expect(request.effort).toBe("high");
      else expect(request).not.toHaveProperty("effort");
    }
  });
});
