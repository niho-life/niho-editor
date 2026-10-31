import { describe, expect, it } from "vitest";
import { candidateEngineLabel, nextCandidateName, primaryCandidateName } from "./candidate-names";

describe("案の名前（#36 段 3b-4）", () => {
  it("エンジンの名前を使い、同じ名前があれば数を足す", () => {
    expect(nextCandidateName([], "deepgram")).toBe("Deepgram");
    expect(nextCandidateName(["Deepgram"], "deepgram")).toBe("Deepgram 2");
    expect(nextCandidateName(["Deepgram", "Deepgram 2"], "deepgram")).toBe("Deepgram 3");
    // 別のエンジンなら、そのエンジンの名前から
    expect(nextCandidateName(["Deepgram", "Deepgram 2"], "fake")).toBe("開発の偽物");
  });

  it("知らないエンジンは id をそのまま出し、長い名前は数だけで区別する", () => {
    expect(candidateEngineLabel("whisper-x")).toBe("whisper-x");
    const long = "あ".repeat(60);
    expect(nextCandidateName([long], long)).toBe("案 2");
  });

  it("1 つ目の案の名前は、いまの文字起こしのエンジン（分からなければ「はじめの案」）", () => {
    expect(primaryCandidateName("deepgram")).toBe("Deepgram");
    expect(primaryCandidateName("vtt-import")).toBe("取り込んだ字幕");
    expect(primaryCandidateName(null)).toBe("はじめの案");
  });
});
