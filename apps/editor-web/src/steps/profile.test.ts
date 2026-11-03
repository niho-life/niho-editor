import { describe, expect, it } from "vitest";
import { stepGenerationOptions, supportsAdaptiveEffort } from "./profile";

describe("step generation profiles", () => {
  it.each([
    ["light", "low", 32_000],
    ["standard", "medium", 12_000],
    ["advanced", "high", 20_000],
  ] as const)("maps %s to effort and a bounded token ceiling", (profile, effort, limit) => {
    expect(stepGenerationOptions("claude-sonnet-5-5", profile, 40_000, 40_000)).toEqual({
      maxTokens: limit,
      thinking: { type: "adaptive" },
      outputConfig: { effort },
    });
  });

  it("keeps the request within both the computed request size and server ceiling", () => {
    expect(stepGenerationOptions("claude-opus-4-8", "advanced", 8_000, 16_000).maxTokens).toBe(8_000);
    expect(stepGenerationOptions("claude-opus-4-8", "advanced", 40_000, 16_000).maxTokens).toBe(16_000);
  });

  it("uses standard for an unknown profile and omits unsupported model options", () => {
    expect(stepGenerationOptions("claude-sonnet-4-5", "future-profile", 40_000, 32_000)).toEqual({ maxTokens: 12_000 });
    expect(supportsAdaptiveEffort("claude-sonnet-4-5")).toBe(false);
    expect(supportsAdaptiveEffort("claude-sonnet-4-6-20250514")).toBe(true);
    expect(supportsAdaptiveEffort("claude-opus-5-2")).toBe(true);
    expect(supportsAdaptiveEffort("claude-haiku-4-5")).toBe(false);
  });
});
