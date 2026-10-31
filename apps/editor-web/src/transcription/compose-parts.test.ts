import type { RecordingSegment } from "@niho/editor-store";
import { describe, expect, it } from "vitest";
import { composeParts } from "./compose-parts";

const segment = (start: number | null, end: number | null, text: string, speaker: number | null = null): RecordingSegment => ({ start, end, text, speaker });

describe("composeParts（複数の音声を 1 本につなぐ）", () => {
  it("前の音声の長さだけ時刻をずらし、話者の番号を音声ごとに続ける", () => {
    const composed = composeParts([
      { offsetSec: 0, segments: [segment(0, 4, "1 本目のはじめ", 1), segment(4, 598, "1 本目のおわり", 2)] },
      { offsetSec: 600, segments: [segment(0, 3, "2 本目のはじめ", 1), segment(3, 298, "2 本目のおわり", 2)] },
    ]);
    expect(composed.segments.map((item) => [item.start, item.end, item.speaker])).toEqual([
      [0, 4, 1],
      [4, 598, 2],
      // 600 秒ずれる。話者は 1 本目の続きの番号（同じ人とは限らないので寄せない）
      [600, 603, 3],
      [603, 898, 4],
    ]);
    expect(composed.durationSec).toBe(898);
  });

  it("音声が申告より長くても、前の音声に重ねない", () => {
    const composed = composeParts([
      // 600 と申告したが 700 秒ぶん返ってきた
      { offsetSec: 0, segments: [segment(0, 700, "長かった 1 本目", 1)] },
      { offsetSec: 600, segments: [segment(0, 5, "2 本目", 1)] },
    ]);
    expect(composed.segments.map((item) => item.start)).toEqual([0, 700]);
    expect(composed.durationSec).toBe(705);
  });

  it("エンジンが返した音声の長さを使う: 末尾が無音でも、長さは短くならず、次の音声は後ろから始まる", () => {
    const seg = (start: number, end: number, text: string) => ({ start, end, text, speaker: 1 });
    // 1 本の録音: 100 秒の音声で、最後の発言は 10 秒で終わる → 長さは 100
    expect(composeParts([{ offsetSec: 0, segments: [seg(0, 10, "あ")], durationSec: 100 }]).durationSec).toBe(100);
    // 2 本: 1 本目は 100 秒（発言は 10 秒まで）。2 本目の時刻は 100 秒の後ろから
    const composed = composeParts([
      { offsetSec: 0, segments: [seg(0, 10, "あ")], durationSec: 100 },
      { offsetSec: 0, segments: [seg(0, 5, "い")], durationSec: 30 },
    ]);
    expect(composed.segments.map((segment) => [segment.start, segment.end])).toEqual([
      [0, 10],
      [100, 105],
    ]);
    expect(composed.durationSec).toBe(130);
    // 長さが段落の末尾より短い（エンジンの誤差）なら、段落の末尾を使う
    expect(composeParts([{ offsetSec: 0, segments: [seg(0, 10, "あ")], durationSec: 8 }]).durationSec).toBe(10);
    // 長さだけあって時刻のある段落が無くても、長さは残る
    expect(composeParts([{ offsetSec: 0, segments: [{ start: null, end: null, text: "あ", speaker: null }], durationSec: 42 }]).durationSec).toBe(42);
  });

  it("1 本だけなら、そのままの時刻", () => {
    const composed = composeParts([{ offsetSec: 0, segments: [segment(0, 4, "1 本だけ", 1), segment(4, 9, "つづき", 2)] }]);
    expect(composed.segments.map((item) => [item.start, item.end, item.speaker])).toEqual([
      [0, 4, 1],
      [4, 9, 2],
    ]);
    expect(composed.durationSec).toBe(9);
  });

  it("話者を分けない結果（speaker が null）はそのまま", () => {
    const composed = composeParts([
      { offsetSec: 0, segments: [segment(0, 4, "話者なし")] },
      { offsetSec: 10, segments: [segment(0, 4, "2 本目も話者なし")] },
    ]);
    expect(composed.segments.map((item) => item.speaker)).toEqual([null, null]);
  });

  it("時刻の無い段落はそのまま足し、時刻が 1 つも無ければ長さは null", () => {
    const composed = composeParts([{ offsetSec: 0, segments: [segment(null, null, "時刻なし", 1)] }]);
    expect(composed.segments).toEqual([segment(null, null, "時刻なし", 1)]);
    expect(composed.durationSec).toBeNull();
  });

  it("空の結果は空（段落が無い音声があっても、次の音声はずれない）", () => {
    expect(composeParts([])).toEqual({ segments: [], durationSec: null });
    const composed = composeParts([
      { offsetSec: 0, segments: [] },
      { offsetSec: 0, segments: [segment(0, 3, "2 本目だけ", 1)] },
    ]);
    expect(composed.segments.map((item) => [item.start, item.speaker])).toEqual([[0, 1]]);
  });
});
