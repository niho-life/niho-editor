/** 録音（server の形）を、docs-ui の ShellRecording に渡す形にする純粋な関数と、時刻の表示の好み（端末ごと）。 */
import type { Recording } from "@niho/editor-store";
import { SHELL_TONES, type ShellSegment, type ShellSpeaker, type ShellTone } from "niho-docs-ui/shell";
import type { RecordingSpeaker } from "./recording-client";

/** 話者が決まっていない段落（VTT に話者の指定が無い）の呼び名。 */
export const NO_SPEAKER_LABEL = "話者なし";

/** 秒を `mm:ss`（1 時間以上は `h:mm:ss`）にする。時刻が無ければ空（段落に時刻を出さない）。 */
export function formatClock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${String(minutes).padStart(2, "0")}:${rest}`;
}

/** 話者の番号の表示名。名前があればそれ、無ければ「話者N」。 */
export function speakerLabel(speaker: number, name: string | null | undefined): string {
  return name ?? `話者${speaker}`;
}

/** 話者の色。番号の順に 6 色を巡る（話者が決まっていない段落は灰色）。 */
export function speakerTone(speaker: number | null): ShellTone {
  if (speaker === null) return "e";
  return SHELL_TONES[(speaker - 1) % SHELL_TONES.length] ?? "a";
}

/**
 * 録音の段落。id は段落の位置（0 始まり）。drafts は、まだ保存されていない（確定した）文章。
 * currentId は、いま再生している段落の id（#36 段 3b-2。その段落だけ current）。
 */
export function shellSegments(recording: Pick<Recording, "segments" | "speakerNames">, drafts: Readonly<Record<number, string>>, currentId: string | null = null): ShellSegment[] {
  return recording.segments.map((segment, index) => ({
    id: String(index),
    who: segment.speaker === null ? NO_SPEAKER_LABEL : speakerLabel(segment.speaker, recording.speakerNames[String(segment.speaker)]),
    tone: speakerTone(segment.speaker),
    time: formatClock(segment.start),
    text: drafts[index] ?? segment.text,
    ...(currentId === String(index) ? { current: true } : {}),
  }));
}

/** 話者の一覧（server が数えた番号の順）。id は話者の番号の文字列。段落の無い話者は名前を変えられない・まとめられないので出さない。 */
export function shellSpeakers(speakers: readonly RecordingSpeaker[]): ShellSpeaker[] {
  return speakers.filter((item) => item.count > 0).map((item) => ({ id: String(item.speaker), name: speakerLabel(item.speaker, item.name), tone: speakerTone(item.speaker), unnamed: item.name === null }));
}

/** 録音の長さ（ヘッダーに出す。無ければ出さない）。 */
export function durationLabel(recording: Pick<Recording, "durationSec">): string | undefined {
  const clock = formatClock(recording.durationSec);
  return clock ? `長さ ${clock}` : undefined;
}

const TIMESTAMPS_KEY = "editor:transcript-timestamps";

/** 時刻を出すか（この端末の好み。保存できなくても、読めなくても動く。既定は出す）。 */
export function readTimestampsPreference(): boolean {
  try {
    return window.localStorage.getItem(TIMESTAMPS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeTimestampsPreference(show: boolean): void {
  try {
    window.localStorage.setItem(TIMESTAMPS_KEY, show ? "on" : "off");
  } catch {
    // 保存できない（プライベートモード・容量）。この画面の間だけ有効
  }
}
