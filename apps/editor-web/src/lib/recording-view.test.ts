// @vitest-environment jsdom
import type { Recording, RecordingData } from "@niho/editor-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_SPEAKER_LABEL,
  durationLabel,
  formatClock,
  readTimestampsPreference,
  shellSegments,
  shellSpeakers,
  speakerLabel,
  speakerTone,
  writeTimestampsPreference,
} from "./recording-view";

function recording(overrides: Partial<Recording> = {}): Recording {
  return {
    revision: 2,
    source: "vtt",
    language: "ja",
    engine: null,
    durationSec: 3725,
    sourceName: null,
    sourceSha256: null,
    audio: null,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
    ...overrides,
  };
}

/** 文字起こしのタブの本文（#310）。 */
function transcript(): Pick<RecordingData, "segments" | "speakerNames"> {
  return {
    segments: [
      { start: 0, end: 4, text: "一つ目", speaker: 1 },
      { start: 75.9, end: 80, text: "二つ目", speaker: 2 },
      { start: null, end: null, text: "三つ目", speaker: null },
    ],
    speakerNames: { "1": "Takuya" },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("recording view", () => {
  it("formats the clock as mm:ss, h:mm:ss past an hour, and nothing without a time", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(75.9)).toBe("01:15");
    expect(formatClock(3599)).toBe("59:59");
    expect(formatClock(3725)).toBe("1:02:05");
    expect(formatClock(null)).toBe("");
    expect(formatClock(-1)).toBe("");
    expect(formatClock(Number.NaN)).toBe("");
  });

  it("names a speaker by the name, or 話者N", () => {
    expect(speakerLabel(2, "Mika")).toBe("Mika");
    expect(speakerLabel(2, null)).toBe("話者2");
    expect(speakerLabel(3, undefined)).toBe("話者3");
  });

  it("colours the speakers a to f in turn, and the speakerless one grey", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(speakerTone)).toEqual(["a", "b", "c", "d", "e", "f", "a", "b"]);
    expect(speakerTone(null)).toBe("e");
  });

  it("builds the segments: id is the position, the name comes from the table, a draft replaces the text", () => {
    const segments = shellSegments(transcript(), { 1: "直した文章" });
    expect(segments).toEqual([
      { id: "0", who: "Takuya", tone: "a", time: "00:00", text: "一つ目" },
      { id: "1", who: "話者2", tone: "b", time: "01:15", text: "直した文章" },
      { id: "2", who: NO_SPEAKER_LABEL, tone: "e", time: "", text: "三つ目" },
    ]);
  });

  it("marks only the paragraph being played as current (#36 段 3b-2)", () => {
    expect(shellSegments(transcript(), {}, "1").map((segment) => segment.current)).toEqual([undefined, true, undefined]);
    expect(shellSegments(transcript(), {}, null).some((segment) => "current" in segment)).toBe(false);
    expect(shellSegments(transcript(), {}, "9").some((segment) => "current" in segment)).toBe(false);
  });

  it("builds the speakers: only those with paragraphs, id is the number, unnamed ones start the input empty", () => {
    expect(
      shellSpeakers([
        { speaker: 1, name: "Takuya", count: 2 },
        { speaker: 2, name: null, count: 1 },
        { speaker: 3, name: "Ghost", count: 0 },
      ]),
    ).toEqual([
      { id: "1", name: "Takuya", tone: "a", unnamed: false },
      { id: "2", name: "話者2", tone: "b", unnamed: true },
    ]);
  });

  it("labels the length when known", () => {
    expect(durationLabel(recording())).toBe("長さ 1:02:05");
    expect(durationLabel(recording({ durationSec: null }))).toBeUndefined();
  });
});

describe("timestamps preference (this device only)", () => {
  it("defaults to shown, and remembers the choice", () => {
    expect(readTimestampsPreference()).toBe(true);
    writeTimestampsPreference(false);
    expect(readTimestampsPreference()).toBe(false);
    writeTimestampsPreference(true);
    expect(readTimestampsPreference()).toBe(true);
  });

  it("works without storage: reads fall back to shown and writes are ignored", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readTimestampsPreference()).toBe(true);
    expect(() => writeTimestampsPreference(false)).not.toThrow();
  });
});
