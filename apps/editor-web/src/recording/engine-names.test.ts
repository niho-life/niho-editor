import { describe, expect, it } from "vitest";
import { canDiscloseTranscriptionEngine, transcriptionEngineLabel, transcriptionServiceNote } from "./engine-names";

describe("文字起こしのエンジンの表示（#310）", () => {
  it("エンジンの id を画面の名前にし、知らないエンジンは id をそのまま出す", () => {
    expect(transcriptionEngineLabel("deepgram")).toBe("Deepgram");
    expect(transcriptionEngineLabel("gemini-cli")).toBe("Gemini（このMacのCLI）");
    expect(transcriptionEngineLabel("vtt-import")).toBe("取り込んだ字幕");
    expect(transcriptionEngineLabel("whisper-x")).toBe("whisper-x");
    expect(transcriptionEngineLabel(null)).toBe("文字起こし");
  });

  it("文字起こしの送信先を名前で示し、未知の engine は推測しない", () => {
    expect(transcriptionServiceNote("deepgram")).toContain("Deepgram");
    expect(transcriptionServiceNote("gemini")).toContain("Google Gemini");
    expect(transcriptionServiceNote("gemini-cli")).toContain("Antigravity CLI");
    expect(transcriptionServiceNote("fake")).toContain("外部サービスへ送られません");
    expect(canDiscloseTranscriptionEngine("deepgram")).toBe(true);
    expect(canDiscloseTranscriptionEngine("whisper-x")).toBe(false);
    expect(transcriptionServiceNote("whisper-x")).toContain("送信先を確認できません");
  });
});
