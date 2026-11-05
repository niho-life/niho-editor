// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_MAC_AI_CHOICE, readMacAiChoice, writeMacAiChoice } from "./mac-ai-choice";

const KEY = "niho-editor:mac-ai-choice";

afterEach(() => {
  window.localStorage.removeItem(KEY);
  vi.restoreAllMocks();
});

describe("Mac の AI の選択を覚える", () => {
  it("書いたものをそのまま読める", () => {
    const choice = { route: "cli:antigravity" as const, models: { "cli:antigravity": "gemini-3.8-flash" }, efforts: { "cli:claude-code": "high" as const } };
    writeMacAiChoice(choice);
    expect(readMacAiChoice()).toEqual(choice);
  });

  it("知らない実行先・形の合わない値は捨てる（壊れていても開ける）", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ route: "cli:other", models: { "cli:codex": "--danger", "cli:claude-code": "opus", other: "x" }, efforts: { "cli:codex": "extreme", "cli:antigravity": "low" } }));
    expect(readMacAiChoice()).toEqual({ route: "", models: { "cli:claude-code": "opus" }, efforts: { "cli:antigravity": "low" } });
    window.localStorage.setItem(KEY, "{not json");
    expect(readMacAiChoice()).toEqual(EMPTY_MAC_AI_CHOICE);
    window.localStorage.setItem(KEY, JSON.stringify(["server"]));
    expect(readMacAiChoice()).toEqual(EMPTY_MAC_AI_CHOICE);
  });

  it("localStorage が使えなくても落ちない", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readMacAiChoice()).toEqual(EMPTY_MAC_AI_CHOICE);
    expect(() => writeMacAiChoice({ route: "server", models: {}, efforts: {} })).not.toThrow();
  });
});
