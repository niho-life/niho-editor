import { describe, expect, it } from "vitest";
import { AUDIO_FORMATS, AUDIO_NAME_MAX_CHARS as SERVER_NAME_MAX } from "@/recording/audio-limits";
import {
  AUDIO_FILE_ACCEPT,
  AUDIO_FILE_EXTENSIONS_LABEL,
  AUDIO_FILE_FORMATS,
  AUDIO_FILE_PICKER_ACCEPT,
  AUDIO_NAME_MAX_CHARS,
  baseContentType,
  contentTypeForAudio,
  extensionOfName,
  isAudioFileName,
  isSafeAudioName,
  unsupportedAudioExtension,
  unsupportedAudioFormatMessage,
} from "./audio-formats";

describe("audio formats（ブラウザ側の写し）", () => {
  it("is the same as the server's list (the server stays the source of truth)", () => {
    expect(AUDIO_FILE_FORMATS).toEqual(AUDIO_FORMATS);
    expect(AUDIO_NAME_MAX_CHARS).toBe(SERVER_NAME_MAX);
  });

  it("builds the picker's accept and the label from the list", () => {
    expect(AUDIO_FILE_EXTENSIONS_LABEL).toBe(".m4a .mp3 .wav .aac .ogg .flac .webm");
    expect(AUDIO_FILE_ACCEPT.split(",")).toEqual(expect.arrayContaining([".m4a", ".webm", "audio/webm", "audio/x-m4a"]));
    expect(AUDIO_FILE_ACCEPT).not.toContain("vtt");
    expect(AUDIO_FILE_ACCEPT).not.toContain(".aifc");
    expect(AUDIO_FILE_PICKER_ACCEPT.split(",")).toEqual(expect.arrayContaining([".aif", ".aiff", ".aifc", ".caf", "audio/aiff"]));
    expect(unsupportedAudioExtension("meeting.AIFC")).toBe("aifc");
    expect(unsupportedAudioExtension("meeting.AIFF")).toBe("aiff");
    expect(unsupportedAudioExtension("meeting.wav")).toBeNull();
    expect(unsupportedAudioFormatMessage(["meeting.aifc", "voice.CAF", "other.aifc"])).toBe(
      "AIFC・CAFはWeb版では直接取り込めません。端末内の音声変換アプリでPCM WAVまたはFLACに変換してから選び直してください。",
    );
  });

  it("reads extensions and content types the same way as the server", () => {
    expect(extensionOfName("合成.M4A")).toBe("m4a");
    expect(extensionOfName(".m4a")).toBeNull();
    expect(extensionOfName("合成.")).toBeNull();
    expect(baseContentType(" Audio/WebM ; codecs=opus")).toBe("audio/webm");
    expect(isAudioFileName("合成.webm")).toBe(true);
    expect(isAudioFileName("合成.vtt")).toBe(false);
    expect(isAudioFileName("合成.constructor")).toBe(false);
    expect(contentTypeForAudio("合成.ogg", "audio/ogg; codecs=opus")).toBe("audio/ogg");
    expect(contentTypeForAudio("合成.m4a", "")).toBe("audio/mp4");
    expect(contentTypeForAudio("合成.txt", "text/plain")).toBeNull();
    expect(isSafeAudioName("録音 2030-01-01 09-05.webm")).toBe(true);
    expect(isSafeAudioName("a\\b.m4a")).toBe(false);
    expect(isSafeAudioName("a\u202eb.m4a")).toBe(false);
  });
});
