import { describe, expect, it } from "vitest";
import { AUDIO_MAX_BYTES, AUDIO_MAX_DURATION_SEC, AUDIO_RETENTION_DAYS } from "../recording/audio-limits";
import { settingsFacts, transcriptionFact } from "./facts";

// 鍵の形だけが要るところは、鍵でない文字列を使う
const KEY = "synthetic-deepgram-key";

describe("transcriptionFact", () => {
  it("answers deepgram with its timeout, and never the key itself", () => {
    const fact = transcriptionFact({ EDITOR_TRANSCRIBE_ENGINE: "deepgram", DEEPGRAM_API_KEY: KEY, EDITOR_TRANSCRIBE_TIMEOUT_SEC: "600" });
    expect(fact.engine).toBe("deepgram");
    expect(fact.timeoutSec).toBe(600);
    expect(JSON.stringify(fact)).not.toContain(KEY);
  });

  it("answers the fake engine outside production and off in production when nothing is set", () => {
    expect(transcriptionFact({ NODE_ENV: "test" }).engine).toBe("fake");
    expect(transcriptionFact({ NODE_ENV: "production" })).toEqual({ engine: "off", timeoutSec: null, audio: transcriptionFact({}).audio });
  });

  it("answers off for the off setting and for a setting that does not resolve, without saying why", () => {
    expect(transcriptionFact({ EDITOR_TRANSCRIBE_ENGINE: "off" }).engine).toBe("off");
    // 誤った設定（起動時の検査が止めるもの）は、画面には出さずに off として扱う
    for (const env of [
      { EDITOR_TRANSCRIBE_ENGINE: "gemini" },
      { EDITOR_TRANSCRIBE_ENGINE: "deepgram" },
      { EDITOR_TRANSCRIBE_ENGINE: "fake", NODE_ENV: "production" },
      { EDITOR_TRANSCRIBE_ENGINE: "deepgram", DEEPGRAM_API_KEY: KEY, EDITOR_TRANSCRIBE_TIMEOUT_SEC: "1" },
    ]) {
      expect(transcriptionFact(env), JSON.stringify(env)).toEqual({ engine: "off", timeoutSec: null, audio: transcriptionFact({}).audio });
    }
  });

  it("carries the audio limits of src/recording/audio-limits.ts (設計 §12 の明記)", () => {
    const { audio } = transcriptionFact({ NODE_ENV: "test" });
    expect(audio.maxBytes).toBe(AUDIO_MAX_BYTES);
    expect(audio.maxDurationSec).toBe(AUDIO_MAX_DURATION_SEC);
    expect(audio.retentionDays).toBe(AUDIO_RETENTION_DAYS);
    expect(audio.extensions).toContain("m4a");
  });
});

describe("settingsFacts", () => {
  it("returns server-owned transcription facts", () => {
    const facts = settingsFacts({ NODE_ENV: "test" });
    expect(facts.transcription.engine).toBe("fake");
  });
});
