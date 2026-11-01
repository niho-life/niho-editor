import { describe, expect, it } from "vitest";
import {
  AUDIO_CONTENT_TYPES,
  AUDIO_EXTENSIONS,
  AUDIO_FORMATS,
  AUDIO_MAX_BYTES,
  AUDIO_MAX_DURATION_SEC,
  AUDIO_RETENTION_DAYS,
  audioLimits,
  audioRequestHash,
  validateAudioStart,
  type AudioStartInput,
} from "./audio-limits";

// 合成のファイル名とダミーのハッシュだけを使う
const SHA = "b".repeat(64);
const valid = (extra: Partial<AudioStartInput> = {}): AudioStartInput => ({ name: "合成の会議.m4a", contentType: "audio/mp4", sizeBytes: 1024, sha256: SHA, ...extra });

function reason(extra: Partial<AudioStartInput>) {
  const result = validateAudioStart(valid(extra));
  return result.ok ? "ok" : result.reason;
}

describe("audio limits", () => {
  it("keeps the confirmed product limits in one place: 2 GiB, 6 hours, 30 days", () => {
    expect(AUDIO_MAX_BYTES).toBe(2 * 1024 ** 3);
    expect(AUDIO_MAX_DURATION_SEC).toBe(21_600);
    expect(AUDIO_RETENTION_DAYS).toBe(30);
    expect(audioLimits()).toEqual({
      maxBytes: AUDIO_MAX_BYTES,
      maxDurationSec: AUDIO_MAX_DURATION_SEC,
      retentionDays: 30,
      extensions: ["m4a", "mp3", "wav", "aac", "ogg", "flac", "webm"],
      contentTypes: [...AUDIO_CONTENT_TYPES],
    });
    expect(AUDIO_EXTENSIONS).not.toContain("vtt");
    expect(AUDIO_CONTENT_TYPES).not.toContain("text/vtt");
  });

  it("accepts every extension with each of its content types, and normalizes the value", () => {
    for (const [extension, types] of Object.entries(AUDIO_FORMATS)) {
      for (const type of types) {
        const result = validateAudioStart(valid({ name: `合成.${extension.toUpperCase()}`, contentType: ` ${type.toUpperCase()} ` }));
        expect(result.ok, `${extension} ${type}`).toBe(true);
        if (result.ok) {
          expect(result.value.contentType).toBe(type);
          expect(result.value.extension).toBe(extension);
          expect(result.value.title).toBe("合成");
        }
      }
    }
    const result = validateAudioStart(valid({ name: "合成 の 録音.v2.mp3", contentType: "audio/mpeg", lang: "en", durationSec: 61.5 }));
    expect(result).toEqual({
      ok: true,
      value: { name: "合成 の 録音.v2.mp3", title: "合成 の 録音.v2", extension: "mp3", contentType: "audio/mpeg", sizeBytes: 1024, sha256: SHA, lang: "en", durationSec: 61.5 },
    });
    const defaults = validateAudioStart(valid());
    expect(defaults.ok && defaults.value.lang).toBe("ja");
    expect(defaults.ok && defaults.value.durationSec).toBeNull();
    expect(reason({ durationSec: null })).toBe("ok");
  });

  it("refuses an extension that does not match the content type, an unknown extension, and VTT", () => {
    expect(reason({ name: "合成.m4a", contentType: "audio/mpeg" })).toBe("extension");
    expect(reason({ name: "合成.mp3", contentType: "audio/wav" })).toBe("extension");
    expect(reason({ name: "合成.flac", contentType: "audio/ogg" })).toBe("extension");
    expect(reason({ name: "合成.vtt", contentType: "text/vtt" })).toBe("extension");
    expect(reason({ name: "合成.vtt", contentType: "audio/mp4" })).toBe("extension");
    expect(reason({ name: "合成.mp4", contentType: "audio/mp4" })).toBe("extension");
    expect(reason({ name: "合成", contentType: "audio/mp4" })).toBe("extension");
    expect(reason({ name: ".m4a" })).toBe("extension");
    expect(reason({ name: "合成." })).toBe("extension");
    expect(reason({ name: "合成.m4a.exe" })).toBe("extension");
    expect(reason({ name: "合成.constructor" })).toBe("extension");
    for (const contentType of ["text/vtt", "video/mp4", "video/webm", "application/octet-stream", ";codecs=opus", "", 1, null]) {
      expect(reason({ contentType }), String(contentType)).toBe("content_type");
    }
  });

  it("accepts the browser's recording (.webm) and compares content types without their parameters", () => {
    for (const contentType of ["audio/webm", "audio/webm;codecs=opus", 'AUDIO/WEBM; codecs="opus"', " audio/webm ;codecs=opus "]) {
      const result = validateAudioStart(valid({ name: "録音 2030-01-01 09-05.webm", contentType }));
      expect(result.ok, contentType).toBe(true);
      if (result.ok) {
        expect(result.value.contentType).toBe("audio/webm");
        expect(result.value.extension).toBe("webm");
        expect(result.value.title).toBe("録音 2030-01-01 09-05");
      }
    }
    // パラメータを除いた形で比べるので、他の形式でも同じ（拡張子との対応も除いた形で見る）
    expect(reason({ contentType: "audio/mp4; codecs=mp4a" })).toBe("ok");
    expect(reason({ name: "合成.webm", contentType: "audio/ogg;codecs=opus" })).toBe("extension");
    expect(reason({ name: "合成.m4a", contentType: "audio/webm;codecs=opus" })).toBe("extension");
    // 冪等の比較も除いた形（パラメータの有無で別の要求にならない）
    const plain = validateAudioStart(valid({ name: "合成.webm", contentType: "audio/webm" }));
    const withCodecs = validateAudioStart(valid({ name: "合成.webm", contentType: "audio/webm;codecs=opus" }));
    expect(plain.ok && withCodecs.ok).toBe(true);
    if (plain.ok && withCodecs.ok) expect(audioRequestHash(withCodecs.value)).toBe(audioRequestHash(plain.value));
  });

  it("refuses names with paths, control characters, or over 200 characters", () => {
    for (const name of ["dir/合成.m4a", "C:\\fakepath\\合成.m4a", "合\u0000成.m4a", "合\n成.m4a", "合\u202e成.m4a", "合\u2028成.m4a", "\uD800.m4a", "", "   ", 1, null, undefined]) {
      expect(reason({ name }), JSON.stringify(name)).toBe("name");
    }
    expect(reason({ name: `${"あ".repeat(196)}.m4a` })).toBe("ok");
    expect(reason({ name: `${"あ".repeat(197)}.m4a` })).toBe("name");
    expect(reason({ name: `${"😀".repeat(196)}.m4a` }), "counted in code points").toBe("ok");
  });

  it("checks the size at its boundaries", () => {
    expect(reason({ sizeBytes: 1 })).toBe("ok");
    expect(reason({ sizeBytes: AUDIO_MAX_BYTES })).toBe("ok");
    expect(reason({ sizeBytes: AUDIO_MAX_BYTES + 1 })).toBe("too_large");
    expect(reason({ sizeBytes: Number.MAX_SAFE_INTEGER })).toBe("too_large");
    for (const sizeBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1024", null, 2 ** 53]) {
      expect(reason({ sizeBytes }), String(sizeBytes)).toBe("size");
    }
  });

  it("checks the declared hash, the language and the duration", () => {
    for (const sha256 of ["B".repeat(64), "b".repeat(63), "b".repeat(65), `${"b".repeat(63)}g`, "", null]) expect(reason({ sha256 }), String(sha256)).toBe("sha256");
    for (const lang of ["fr", "JA", "", null]) expect(reason({ lang }), String(lang)).toBe("lang");
    expect(reason({ durationSec: AUDIO_MAX_DURATION_SEC })).toBe("ok");
    expect(reason({ durationSec: AUDIO_MAX_DURATION_SEC + 0.001 })).toBe("too_long");
    for (const durationSec of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "60"]) expect(reason({ durationSec }), String(durationSec)).toBe("duration");
  });

  it("hashes the normalized request: equal for the same content, different when any field changes", () => {
    const base = validateAudioStart(valid({ contentType: "AUDIO/MP4" }));
    const same = validateAudioStart(valid({ contentType: "audio/mp4" }));
    expect(base.ok && same.ok).toBe(true);
    if (!base.ok || !same.ok) return;
    const hash = audioRequestHash(base.value);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(audioRequestHash(same.value)).toBe(hash);
    for (const extra of [{ name: "別名.m4a" }, { contentType: "audio/x-m4a" }, { sizeBytes: 1025 }, { sha256: "c".repeat(64) }, { lang: "en" }, { durationSec: 1 }]) {
      const other = validateAudioStart(valid(extra));
      expect(other.ok).toBe(true);
      if (other.ok) expect(audioRequestHash(other.value), JSON.stringify(extra)).not.toBe(hash);
    }
  });
});
