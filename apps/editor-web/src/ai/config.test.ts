import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_MESSAGES_URL } from "./anthropic";
import { DEFAULT_ANTHROPIC_MODEL, monthlyLimitUsd, resolveAiCompose, type AiEnv } from "./config";

// 合成の鍵（本物の API は呼ばない。fetch は global を差し替える）
const KEY = "synthetic-anthropic-key-0123456789";

/** global の fetch を差し替え、本物のバックエンドで 1 往復させて、送った要求を返す。 */
async function sentWith(env: AiEnv): Promise<{ url: string; model: unknown; key: string | null }> {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    return Response.json({ model: "claude-sonnet-5-5", content: [{ type: "text", text: '{"edits":[],"inserts":[]}' }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  });
  vi.stubGlobal("fetch", fetch);
  const backend = resolveAiCompose(env);
  if (!backend) throw new Error("expected a backend");
  await backend.client.complete({ system: "s", user: "合成" });
  const [input, init] = fetch.mock.calls[0]!;
  return { url: String(input), model: (JSON.parse(String(init?.body)) as { model: unknown }).model, key: new Headers(init?.headers).get("x-api-key") };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveAiCompose: on and off", () => {
  it("is off unless EDITOR_AI_MODE says fake or anthropic (with a key)", () => {
    for (const mode of [undefined, "", " ", "off", "OFF", "anthropic", "Anthropic", "gemini", "claude", "fake2"]) {
      expect(resolveAiCompose({ EDITOR_AI_MODE: mode }), String(mode)).toBeNull();
      expect(resolveAiCompose({ EDITOR_AI_MODE: mode, NODE_ENV: "development" }), String(mode)).toBeNull();
    }
    // 鍵があっても、未知の方式は使わない
    for (const mode of ["Anthropic", "claude", "openai"]) expect(resolveAiCompose({ EDITOR_AI_MODE: mode, ANTHROPIC_API_KEY: KEY }), mode).toBeNull();
  });

  it("uses the fake model in development and test, with no price table", () => {
    for (const NODE_ENV of [undefined, "development", "test"]) {
      const backend = resolveAiCompose({ EDITOR_AI_MODE: " fake ", NODE_ENV });
      expect(backend?.provider, String(NODE_ENV)).toBeNull();
      expect(typeof backend?.client.converse).toBe("function");
    }
  });

  it("refuses the fake model in production (no fake text for real users)", () => {
    expect(resolveAiCompose({ EDITOR_AI_MODE: "fake", NODE_ENV: "production" })).toBeNull();
  });

  it("uses Anthropic with the claude price table when the key is set, in production too", async () => {
    for (const NODE_ENV of [undefined, "development", "production"]) {
      const backend = resolveAiCompose({ EDITOR_AI_MODE: " anthropic ", ANTHROPIC_API_KEY: KEY, NODE_ENV });
      expect(backend?.provider, String(NODE_ENV)).toBe("claude");
    }
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-sonnet-5-5");
    expect(await sentWith({ EDITOR_AI_MODE: "anthropic", ANTHROPIC_API_KEY: KEY })).toEqual({ url: ANTHROPIC_MESSAGES_URL, model: "claude-sonnet-5-5", key: KEY });
    expect((await sentWith({ EDITOR_AI_MODE: "anthropic", ANTHROPIC_API_KEY: KEY, EDITOR_AI_MODEL: "  " })).model).toBe("claude-sonnet-5-5");
    expect((await sentWith({ EDITOR_AI_MODE: "anthropic", ANTHROPIC_API_KEY: KEY, EDITOR_AI_MODEL: " claude-opus-5-5 " })).model).toBe("claude-opus-5-5");
  });

  it("stays closed (null) without a key or with a model name of the wrong shape", () => {
    for (const ANTHROPIC_API_KEY of [undefined, "", "   "]) {
      expect(resolveAiCompose({ EDITOR_AI_MODE: "anthropic", ANTHROPIC_API_KEY, NODE_ENV: "production" }), String(ANTHROPIC_API_KEY)).toBeNull();
    }
    for (const EDITOR_AI_MODEL of ["Claude-Sonnet", "-claude", "claude sonnet", "claude/../v1", "claude\nx", "claude:latest", "a".repeat(65), "クロード"]) {
      expect(resolveAiCompose({ EDITOR_AI_MODE: "anthropic", ANTHROPIC_API_KEY: KEY, EDITOR_AI_MODEL }), EDITOR_AI_MODEL).toBeNull();
    }
  });

  it("stays closed for a model without a price (the monthly limit could not count it)", () => {
    for (const EDITOR_AI_MODEL of ["claude-haiku-5-5", "claude-unknown-9", `a${"b".repeat(63)}`, "claude-sonnet-6", "claude-opus-4-1"]) {
      expect(resolveAiCompose({ EDITOR_AI_MODE: "anthropic", ANTHROPIC_API_KEY: KEY, EDITOR_AI_MODEL }), EDITOR_AI_MODEL).toBeNull();
    }
    // a priced model, with the dated name the provider returns, opens
    for (const EDITOR_AI_MODEL of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5", "claude-sonnet-5-5-20261001"]) {
      expect(resolveAiCompose({ EDITOR_AI_MODE: "anthropic", ANTHROPIC_API_KEY: KEY, EDITOR_AI_MODEL })?.provider, EDITOR_AI_MODEL).toBe("claude");
    }
  });
});

describe("monthlyLimitUsd", () => {
  it("is unlimited when unset and reads a non-negative number", () => {
    expect(monthlyLimitUsd({})).toBeNull();
    expect(monthlyLimitUsd({ EDITOR_AI_MONTHLY_LIMIT_USD: "" })).toBeNull();
    expect(monthlyLimitUsd({ EDITOR_AI_MONTHLY_LIMIT_USD: " 12.5 " })).toBe(12.5);
    expect(monthlyLimitUsd({ EDITOR_AI_MONTHLY_LIMIT_USD: "0" })).toBe(0);
  });

  it("falls back to 0 (AI stopped) for a value that is not a non-negative number", () => {
    for (const value of ["abc", "-1", "Infinity", "NaN", "1e400", "$5"]) expect(monthlyLimitUsd({ EDITOR_AI_MONTHLY_LIMIT_USD: value }), value).toBe(0);
  });
});

describe("resolveAiCompose", () => {
  const on: AiEnv = { EDITOR_AI_MODE: "anthropic", ANTHROPIC_API_KEY: KEY };

  it("is closed without a known mode, a key, a well-formed priced model, or in production with the fake", () => {
    for (const env of [
      { EDITOR_AI_MODE: undefined },
      { EDITOR_AI_MODE: "off" },
      { EDITOR_AI_MODE: "claude", ANTHROPIC_API_KEY: KEY },
      { EDITOR_AI_MODE: "anthropic" },
      { EDITOR_AI_MODE: "anthropic", ANTHROPIC_API_KEY: "  " },
      // 名前の形が違う・単価表に無いモデルは、金額を数えられないので閉じたまま
      { ...on, EDITOR_AI_MODEL: "Claude/Sonnet" },
      { ...on, EDITOR_AI_MODEL: "claude-unknown-model" },
      // 本番で偽物は受け付けない
      { EDITOR_AI_MODE: "fake", NODE_ENV: "production" },
    ] satisfies AiEnv[]) {
      expect(resolveAiCompose(env), JSON.stringify(env)).toBeNull();
    }
  });

  it("uses the model of the settings (default claude-sonnet-5-5) and the claude price table", () => {
    expect(resolveAiCompose(on)).toMatchObject({ model: DEFAULT_ANTHROPIC_MODEL, provider: "claude" });
    expect(resolveAiCompose({ ...on, EDITOR_AI_MODEL: "claude-opus-5-5" })).toMatchObject({ model: "claude-opus-5-5", provider: "claude" });
  });

  it("answers the fake one-shot in development, with no price table", async () => {
    const compose = resolveAiCompose({ EDITOR_AI_MODE: "fake", NODE_ENV: "development" });
    expect(compose).toMatchObject({ model: "fake", provider: null });
    const completion = await compose!.client.complete({ system: "s", user: "## 頼むこと\n合成の段階\n## 資料\n<untrusted_data>\n合成の資料\n</untrusted_data>" });
    // 偽物の結果には必ず印が付く（本物と見間違えない）
    expect(completion.text).toContain("[fake]");
    expect(JSON.parse(completion.text)).toMatchObject({ blocks: [{ kind: "heading" }, { kind: "paragraph" }, { kind: "paragraph" }] });
    expect(completion.usage.model).toBe("fake");
  });

  it("calls the fixed Anthropic URL with the key of the moment", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Response.json({ model: "claude-sonnet-5-5", content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    });
    vi.stubGlobal("fetch", fetch);
    await resolveAiCompose(on)!.client.complete({ system: "s", user: "u" });
    const [input, init] = fetch.mock.calls[0]!;
    expect(String(input)).toBe(ANTHROPIC_MESSAGES_URL);
    expect(new Headers(init?.headers).get("x-api-key")).toBe(KEY);
  });
});
