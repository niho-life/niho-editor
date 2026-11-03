import { describe, expect, it, vi } from "vitest";
import type { ShellBridge } from "niho-desktop-bridge/shell-bridge";
import type { ShellAiTurn } from "niho-desktop-bridge/shell-contract";
import { MacAiError, macEngineModels, macEngineReady, runMacAiTurn } from "./mac-ai-chat";

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
      instruction: expect.stringContaining("選択範囲を主な対象"), page: PAGE,
      context: [{ name: "selection", title: "選択範囲", markdown: "選択文" }],
    }, expect.any(Function));
  });

  it.each([
    [{ ...DONE, finalEvent: { ...DONE.finalEvent, stop_reason: "MaxTokens" } }, "incomplete"],
    [{ ...DONE, pageRemoved: true }, "page_removed"],
    [{ ...DONE, extraFiles: 1 }, "extra_files"],
    [{ ...DONE, page: { pageId: "other", markdown: "bad" } }, "invalid_result"],
  ] as const)("rejects an unsafe native result", async (result, code) => {
    await expect(run(result as ShellAiTurn).promise).rejects.toMatchObject({ code });
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

  it("requires an authenticated CLI and gives Claude a local fallback model list", () => {
    const claude = { engine: "cli:claude-code" as const, installed: true, authenticated: true, reason: null, models: [], effort: true, resume: true };
    expect(macEngineModels(claude).length).toBeGreaterThan(0);
    expect(macEngineReady({ ...claude, authenticated: false })).toBe(false);
    expect(new MacAiError("auth").message).not.toContain(PAGE.markdown);
  });
});
