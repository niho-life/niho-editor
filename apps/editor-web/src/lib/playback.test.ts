import { describe, expect, it } from "vitest";
import { isPlayable, playbackClock, playbackDuration, playbackPartAt, playbackPartMessage, playbackParts, playbackSrc, playbackTimelineDuration, segmentAt, segmentStart, segmentTimeline } from "./playback";
import type { AudioPartView } from "./audio-upload-client";

const at = (start: number | null) => ({ start });
const NOW = Date.parse("2030-01-10T00:00:00.000Z");
const audioPart = (partIndex: number, extra: Partial<AudioPartView> = {}): AudioPartView => ({
  partIndex,
  status: "uploaded",
  bytes: 10,
  contentType: "audio/mp4",
  durationSec: 600,
  offsetSec: partIndex * 600,
  sourceName: null,
  expiresAt: "2030-02-10T00:00:00.000Z",
  ...extra,
});

describe("segmentAt: いまの再生位置の段落（二分探索）", () => {
  const timeline = segmentTimeline([at(0), at(4), at(9), at(12)]);

  it("先頭・途中・末尾・段落の境目", () => {
    expect(segmentAt(timeline, 0)).toBe("0");
    expect(segmentAt(timeline, 3.99)).toBe("0");
    expect(segmentAt(timeline, 4)).toBe("1");
    expect(segmentAt(timeline, 8.5)).toBe("1");
    expect(segmentAt(timeline, 9)).toBe("2");
    expect(segmentAt(timeline, 12)).toBe("3");
    // 最後の段落のあとも、最後の段落のまま（終わりの時刻は見ない）
    expect(segmentAt(timeline, 9999)).toBe("3");
  });

  it("最初の段落より前・時刻の無い録音・数でない位置は null", () => {
    expect(segmentAt(segmentTimeline([at(2), at(5)]), 1.5)).toBeNull();
    expect(segmentAt(segmentTimeline([]), 3)).toBeNull();
    expect(segmentAt(segmentTimeline([at(null), at(null)]), 3)).toBeNull();
    expect(segmentAt(timeline, Number.NaN)).toBeNull();
  });

  it("時刻の無い段落は飛ばす（id は段落の位置のまま）", () => {
    const mixed = segmentTimeline([at(0), at(null), at(5), at(null), at(8)]);
    expect(mixed.ids).toEqual(["0", "2", "4"]);
    expect(segmentAt(mixed, 1)).toBe("0");
    expect(segmentAt(mixed, 6)).toBe("2");
    expect(segmentAt(mixed, 8)).toBe("4");
  });

  it("同じ時刻に始まる段落が並ぶときは、その最初の段落", () => {
    const ties = segmentTimeline([at(0), at(3), at(3), at(3), at(7)]);
    expect(segmentAt(ties, 3)).toBe("1");
    expect(segmentAt(ties, 5)).toBe("1");
    expect(segmentAt(ties, 7)).toBe("4");
    expect(segmentAt(segmentTimeline([at(0), at(0)]), 0)).toBe("0");
  });

  it("時刻の順に並んでいない録音は並べ直す（同じ時刻は段落の順）", () => {
    const shuffled = segmentTimeline([at(9), at(0), at(4), at(4)]);
    expect(shuffled.starts).toEqual([0, 4, 4, 9]);
    expect(shuffled.ids).toEqual(["1", "2", "3", "0"]);
    expect(segmentAt(shuffled, 5)).toBe("2");
    expect(segmentAt(shuffled, 10)).toBe("0");
  });

  it("段落が 20,000 でも、どの位置も正しく引ける", () => {
    const many = Array.from({ length: 20_000 }, (_, index) => at(index * 1.5));
    const big = segmentTimeline(many);
    expect(segmentAt(big, 0)).toBe("0");
    expect(segmentAt(big, 1.49)).toBe("0");
    expect(segmentAt(big, 15_000)).toBe("10000");
    expect(segmentAt(big, 15_000.7)).toBe("10000");
    expect(segmentAt(big, 29_998.5)).toBe("19999");
    expect(segmentAt(big, 1e9)).toBe("19999");
  });
});

describe("再生の小さな関数", () => {
  it("segmentStart: 段落の始まりの時刻（時刻が無い・知らない id は null）", () => {
    const segments = [at(0), at(null), at(12.5)];
    expect(segmentStart(segments, "0")).toBe(0);
    expect(segmentStart(segments, "2")).toBe(12.5);
    expect(segmentStart(segments, "1")).toBeNull();
    expect(segmentStart(segments, "3")).toBeNull();
    expect(segmentStart(segments, "x")).toBeNull();
    expect(segmentStart(segments, "-1")).toBeNull();
  });

  it("isPlayable: アップロード済みで期限の前だけ", () => {
    const base = { bytes: 10, contentType: "audio/mp4" };
    expect(isPlayable(null, NOW)).toBe(false);
    expect(isPlayable({ ...base, status: "uploaded", expiresAt: "2030-01-31T00:00:00.000Z" }, NOW)).toBe(true);
    expect(isPlayable({ ...base, status: "uploaded", expiresAt: null }, NOW)).toBe(true);
    expect(isPlayable({ ...base, status: "uploading", expiresAt: "2030-01-31T00:00:00.000Z" }, NOW)).toBe(false);
    expect(isPlayable({ ...base, status: "uploaded", expiresAt: "2030-01-09T00:00:00.000Z" }, NOW)).toBe(false);
  });

  it("playbackSrc は同じ origin の route", () => {
    expect(playbackSrc("6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11")).toBe("/api/pages/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11/recording/audio?part=0");
    expect(playbackSrc("x/y", 2)).toBe("/api/pages/x%2Fy/recording/audio?part=2");
  });

  it("複数Partのoffsetを全体時間軸にし、穴・取り込み中・期限切れを区別する", () => {
    const parts = playbackParts([
      audioPart(0),
      audioPart(2, { offsetSec: 1200, durationSec: 300 }),
      audioPart(3, { status: "uploading", offsetSec: 1500, durationSec: 90 }),
      audioPart(4, { offsetSec: 1590, durationSec: 40, expiresAt: "2030-01-09T00:00:00.000Z" }),
    ], NOW, 1630);
    expect(parts.map(({ partIndex, offsetSec, durationSec, state }) => [partIndex, offsetSec, durationSec, state])).toEqual([
      [0, 0, 600, "ready"],
      [1, 600, 600, "missing"],
      [2, 1200, 300, "ready"],
      [3, 1500, 90, "uploading"],
      [4, 1590, 40, "expired"],
    ]);
    expect(playbackTimelineDuration(parts, null)).toBe(1630);
    expect(playbackPartAt(parts, 599.99)?.partIndex).toBe(0);
    expect(playbackPartAt(parts, 600)?.state).toBe("missing");
    expect(playbackPartAt(parts, 1200)?.partIndex).toBe(2);
    expect(playbackPartAt(parts, 1520)?.state).toBe("uploading");
    expect(playbackPartAt(parts, 1600)?.state).toBe("expired");
    expect(playbackPartMessage(playbackPartAt(parts, 600))).toContain("音声 2");
    expect(playbackPartMessage(playbackPartAt(parts, 1520))).toContain("取り込み中");
    expect(playbackPartMessage(playbackPartAt(parts, 1600))).toContain("期限切れ");
  });

  it("Part長が不明なら次のoffsetまたは録音全体の長さで範囲を埋める", () => {
    const parts = playbackParts([
      audioPart(0, { durationSec: null }),
      audioPart(1, { offsetSec: 75, durationSec: null }),
    ], NOW, 130);
    expect(parts.map(({ offsetSec, durationSec }) => [offsetSec, durationSec])).toEqual([[0, 75], [75, 55]]);
    expect(playbackTimelineDuration(parts, 130)).toBe(130);
  });

  it("playbackClock と playbackDuration", () => {
    expect(playbackClock(83.9, 878)).toBe("01:23 / 14:38");
    expect(playbackClock(0, null)).toBe("00:00");
    expect(playbackClock(Number.NaN, 3700)).toBe("00:00 / 1:01:40");
    expect(playbackDuration(12.3, 99)).toBe(12.3);
    // マイク録音の webm はブラウザが Infinity を返すことがある: 録音の長さを使う
    expect(playbackDuration(Number.POSITIVE_INFINITY, 99)).toBe(99);
    expect(playbackDuration(Number.NaN, null)).toBeNull();
    expect(playbackDuration(0, 0)).toBeNull();
  });
});
