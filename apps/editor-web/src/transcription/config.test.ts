import { describe, expect, it } from "vitest";
import { TranscriptionConfigError, availableTranscriptionEngines, resolveTranscriptionConfig, type TranscriptionEnv } from "./config";

// 鍵は明らかなダミーだけ
const KEY = "test-key-not-secret";

function errorOf(env: TranscriptionEnv): TranscriptionConfigError {
  try {
    resolveTranscriptionConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(TranscriptionConfigError);
    return error as TranscriptionConfigError;
  }
  throw new Error("expected a configuration error");
}

describe("resolveTranscriptionConfig", () => {
  it("refuses the fake engine in production, and is off in production when unset", () => {
    expect(errorOf({ NODE_ENV: "production", EDITOR_TRANSCRIBE_ENGINE: "fake" }).message).toMatch(/EDITOR_TRANSCRIBE_ENGINE=fake is not allowed when NODE_ENV=production/);
    expect(resolveTranscriptionConfig({ NODE_ENV: "production" })).toEqual({ engine: "off" });
    expect(resolveTranscriptionConfig({ NODE_ENV: "production", EDITOR_TRANSCRIBE_ENGINE: "  " })).toEqual({ engine: "off" });
    expect(resolveTranscriptionConfig({ NODE_ENV: "production", EDITOR_TRANSCRIBE_ENGINE: "off" })).toEqual({ engine: "off" });
  });

  it("uses the fake engine outside production when unset, and off when asked", () => {
    expect(resolveTranscriptionConfig({})).toEqual({ engine: "fake", timeoutMs: 1_200_000 });
    expect(resolveTranscriptionConfig({ NODE_ENV: "development", EDITOR_TRANSCRIBE_ENGINE: "fake" })).toEqual({ engine: "fake", timeoutMs: 1_200_000 });
    expect(resolveTranscriptionConfig({ NODE_ENV: "test", EDITOR_TRANSCRIBE_ENGINE: "off" })).toEqual({ engine: "off" });
  });

  it("requires a well-formed Deepgram key, keeps it out of the value, and never prints it", () => {
    expect(errorOf({ NODE_ENV: "production", EDITOR_TRANSCRIBE_ENGINE: "deepgram" }).message).toMatch(/DEEPGRAM_API_KEY is required/);
    expect(errorOf({ NODE_ENV: "production", EDITOR_TRANSCRIBE_ENGINE: "deepgram", DEEPGRAM_API_KEY: "   " }).message).toMatch(/DEEPGRAM_API_KEY is required/);
    for (const bad of ["test key with space", "test-key\nsecond-line", "test-key\u0000", "あ".repeat(10), "x".repeat(513)]) {
      const error = errorOf({ NODE_ENV: "production", EDITOR_TRANSCRIBE_ENGINE: "deepgram", DEEPGRAM_API_KEY: bad });
      expect(error.message).toBe("DEEPGRAM_API_KEY is not a valid key");
      expect(error.message).not.toContain(bad);
    }
    const config = resolveTranscriptionConfig({ NODE_ENV: "production", EDITOR_TRANSCRIBE_ENGINE: "deepgram", DEEPGRAM_API_KEY: `${KEY}\n` });
    expect(config.engine).toBe("deepgram");
    if (config.engine !== "deepgram") throw new Error("unreachable");
    expect(config.timeoutMs).toBe(1_200_000);
    expect(config.apiKey()).toBe(KEY);
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(String(config)).not.toContain(KEY);
    expect(`${config.apiKey}`).not.toContain(KEY);
    expect(resolveTranscriptionConfig({ EDITOR_TRANSCRIBE_ENGINE: "deepgram", DEEPGRAM_API_KEY: KEY }).engine).toBe("deepgram");
  });

  it("reads the Gemini key and model (the key never leaves the function)", () => {
    const config = resolveTranscriptionConfig({ EDITOR_TRANSCRIBE_ENGINE: "gemini", GEMINI_API_KEY: ` ${KEY} ` });
    expect(config.engine).toBe("gemini");
    if (config.engine !== "gemini") throw new Error("unreachable");
    expect(config.apiKey()).toBe(KEY);
    expect(config.model).toBe("gemini-3.8-flash");
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(resolveTranscriptionConfig({ EDITOR_TRANSCRIBE_ENGINE: "gemini", GEMINI_API_KEY: KEY, EDITOR_GEMINI_MODEL: "gemini-3.1-pro-preview" })).toMatchObject({
      model: "gemini-3.1-pro-preview",
    });
    expect(errorOf({ EDITOR_TRANSCRIBE_ENGINE: "gemini" }).message).toBe("GEMINI_API_KEY is required when EDITOR_TRANSCRIBE_ENGINE=gemini");
    expect(errorOf({ EDITOR_TRANSCRIBE_ENGINE: "gemini", GEMINI_API_KEY: "鍵 に 空白" }).message).toBe("GEMINI_API_KEY is not a valid key");
    for (const model of ["Gemini", "../models", "a".repeat(65), "gemini 3"]) {
      expect(errorOf({ EDITOR_TRANSCRIBE_ENGINE: "gemini", GEMINI_API_KEY: KEY, EDITOR_GEMINI_MODEL: model }).message).toBe("EDITOR_GEMINI_MODEL is not a valid model name");
    }
  });

  it("lists the engines that can run now (the default plus the keys that are set)", () => {
    expect(availableTranscriptionEngines({})).toEqual(["fake"]);
    expect(availableTranscriptionEngines({ NODE_ENV: "production" })).toEqual([]);
    expect(availableTranscriptionEngines({ EDITOR_TRANSCRIBE_ENGINE: "off", DEEPGRAM_API_KEY: KEY })).toEqual([]);
    expect(availableTranscriptionEngines({ EDITOR_TRANSCRIBE_ENGINE: "deepgram", DEEPGRAM_API_KEY: KEY })).toEqual(["deepgram"]);
    // 鍵が両方あれば、既定でないエンジンも使える（案を別のエンジンで作れる）
    expect(availableTranscriptionEngines({ EDITOR_TRANSCRIBE_ENGINE: "deepgram", DEEPGRAM_API_KEY: KEY, GEMINI_API_KEY: KEY })).toEqual(["deepgram", "gemini"]);
    expect(availableTranscriptionEngines({ EDITOR_TRANSCRIBE_ENGINE: "gemini", GEMINI_API_KEY: KEY, DEEPGRAM_API_KEY: KEY })).toEqual(["deepgram", "gemini"]);
    // 形の不正な鍵・モデルは足さない（そのエンジンを出さないだけ）
    expect(availableTranscriptionEngines({ EDITOR_TRANSCRIBE_ENGINE: "deepgram", DEEPGRAM_API_KEY: KEY, GEMINI_API_KEY: "鍵 に 空白" })).toEqual(["deepgram"]);
    expect(availableTranscriptionEngines({ EDITOR_TRANSCRIBE_ENGINE: "deepgram", DEEPGRAM_API_KEY: KEY, GEMINI_API_KEY: KEY, EDITOR_GEMINI_MODEL: "だめ" })).toEqual(["deepgram"]);
    // 偽物は既定のときだけ（開発と CI）
    expect(availableTranscriptionEngines({ DEEPGRAM_API_KEY: KEY })).toEqual(["deepgram", "fake"]);
    // 設定の誤り（時間切れ）は空
    expect(availableTranscriptionEngines({ EDITOR_TRANSCRIBE_TIMEOUT_SEC: "1" })).toEqual([]);
  });

  it("refuses unknown engines and timeouts outside 60 to 3300 seconds", () => {
    for (const value of ["whisper", "FAKE", "Deepgram", "Gemini"]) {
      expect(errorOf({ EDITOR_TRANSCRIBE_ENGINE: value }).message).toBe("EDITOR_TRANSCRIBE_ENGINE must be one of: fake, deepgram, gemini, off");
    }
    for (const value of ["59", "3301", "0", "-60", "1.5", "abc", "1e3", "600s"]) {
      expect(errorOf({ EDITOR_TRANSCRIBE_TIMEOUT_SEC: value }).message).toMatch(/EDITOR_TRANSCRIBE_TIMEOUT_SEC must be an integer between 60 and 3300/);
      // 使わない設定でも、時間切れの誤りは誤り
      errorOf({ NODE_ENV: "production", EDITOR_TRANSCRIBE_TIMEOUT_SEC: value });
    }
    expect(resolveTranscriptionConfig({ EDITOR_TRANSCRIBE_TIMEOUT_SEC: "60" })).toEqual({ engine: "fake", timeoutMs: 60_000 });
    expect(resolveTranscriptionConfig({ EDITOR_TRANSCRIBE_TIMEOUT_SEC: " 3300 " })).toEqual({ engine: "fake", timeoutMs: 3_300_000 });
    expect(resolveTranscriptionConfig({ EDITOR_TRANSCRIBE_TIMEOUT_SEC: "" })).toEqual({ engine: "fake", timeoutMs: 1_200_000 });
  });
});
