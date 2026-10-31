import type { RecordingSegment } from "@niho/editor-store";

/**
 * 複数の音声の文字起こしを 1 本につなぐ（#36 段 3b-4）。エンジンは音声 1 本ずつに呼ぶので、その結果を
 * **前の音声の長さだけずらして**並べる（docs-core の audio-transcription.ts と同じ規則。録音ページに .vtt を足すときの
 * append-transcript.ts と同じ考え方）。
 *
 * - ずらす量は、その音声に記録してある `offsetSec`（足したときに決めた「それまでの長さ」）と、ここまでの段落の末尾のうち
 *   大きいほう（音声が申告より長くても、前の音声に重ならない）。
 * - 話者の番号は音声ごとに振り直す（1 本目の話者 1 と 2 本目の話者 1 が同じ人とは限らない。同じ人なら、画面で話者をまとめる）。
 * - 長さは、つないだ音声の長さ（エンジンが返した長さと段落の末尾の大きいほうを、ずらしながら足す。時刻も長さも無ければ null）。
 */

/** 音声 1 本の結果（その音声の先頭を 0 とした時刻）。 */
export type TranscribedPart = {
  /** その音声の文字起こしをずらす量（秒）。 */
  offsetSec: number;
  segments: readonly RecordingSegment[];
  /**
   * エンジンが返した、音声そのものの長さ（秒）。末尾が無音の音声は、最後の段落の終わりより長い。次の音声はこの長さの
   * 後ろから始まる（段落の末尾だけで数えると、無音の分だけ短く記録され、次の音声の時刻が前にずれる）。分からなければ無し。
   */
  durationSec?: number | null;
};

export type ComposedTranscript = { segments: RecordingSegment[]; durationSec: number | null };

function endOf(segments: readonly RecordingSegment[]): number {
  let end = 0;
  for (const segment of segments) {
    if (segment.end !== null && Number.isFinite(segment.end)) end = Math.max(end, segment.end);
  }
  return end;
}

/** その音声の長さ（秒）: エンジンが返した長さと、段落の末尾の大きいほう。 */
function lengthOf(part: TranscribedPart): number {
  const reported = part.durationSec;
  return Math.max(endOf(part.segments), typeof reported === "number" && Number.isFinite(reported) && reported > 0 ? reported : 0);
}

export function composeParts(parts: readonly TranscribedPart[]): ComposedTranscript {
  const segments: RecordingSegment[] = [];
  let tail = 0;
  let lastSpeaker = 0;
  let timed = false;
  for (const part of parts) {
    const offset = Math.max(Number.isFinite(part.offsetSec) && part.offsetSec > 0 ? part.offsetSec : 0, tail);
    // この音声の中の話者番号 → 録音全体の話者番号（音声ごとに続きの番号を振る）
    const speakers = new Map<number, number>();
    for (const segment of part.segments) {
      let speaker: number | null = null;
      if (segment.speaker !== null) {
        const known = speakers.get(segment.speaker);
        if (known === undefined) {
          lastSpeaker += 1;
          speakers.set(segment.speaker, lastSpeaker);
          speaker = lastSpeaker;
        } else {
          speaker = known;
        }
      }
      if (segment.start === null || segment.end === null) {
        segments.push({ start: null, end: null, text: segment.text, speaker });
        continue;
      }
      timed = true;
      segments.push({ start: segment.start + offset, end: segment.end + offset, text: segment.text, speaker });
    }
    const length = lengthOf(part);
    if (length > 0) timed = true;
    tail = Math.max(offset + length, tail);
  }
  return { segments, durationSec: timed ? tail : null };
}
