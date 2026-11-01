/**
 * 録音ページの文字起こしの開始・状態の表示（#36 段 3b-1）の純粋な関数: 状態の遷移（reducer）・ポーリングの間隔・画面の言葉。
 * 遷移とタイマーをつなぐのは use-transcription.ts、画面は components/RecordingTranscription.tsx。
 */
import type { RecordingAudio } from "@niho/editor-store";
import { TranscriptionRequestError, type TranscriptionRun } from "./transcription-client";

/** 状態を読み直す間隔。画面が見えていないとき（document.hidden）は延ばす。 */
export const POLL_INTERVAL_MS = 3000;
export const POLL_HIDDEN_INTERVAL_MS = 15000;
/** 続けてこの回数だけ読めなかったら、読み直しをやめて「更新できません」。 */
export const POLL_MAX_FAILURES = 3;

export function pollDelayMs(hidden: boolean): number {
  return hidden ? POLL_HIDDEN_INTERVAL_MS : POLL_INTERVAL_MS;
}

/**
 * loading=最初の状態を読んでいる・idle=実行していない（run が無い・済んだ）・starting=開始を送っている・
 * active=待機中か文字起こし中（読み直しを続ける）・failed=失敗した（理由と「もう一度」）・stalled=続けて読めずに止めた。
 */
export type TranscriptionPhase = "loading" | "idle" | "starting" | "active" | "failed" | "stalled";

export type TranscriptionState = {
  phase: TranscriptionPhase;
  run: TranscriptionRun | null;
  /** 続けて読めなかった回数。 */
  failures: number;
  /** 開始を断られた理由（画面の文言）。 */
  startError: string | null;
};

export const INITIAL_TRANSCRIPTION_STATE: TranscriptionState = { phase: "loading", run: null, failures: 0, startError: null };

export type TranscriptionEvent =
  | { type: "loaded"; run: TranscriptionRun | null }
  | { type: "start" }
  | { type: "started"; run: TranscriptionRun }
  | { type: "startFailed"; message: string }
  | { type: "polled"; run: TranscriptionRun | null }
  | { type: "pollFailed" }
  | { type: "resume" };

function phaseOf(run: TranscriptionRun | null): TranscriptionPhase {
  if (!run) return "idle";
  if (run.status === "queued" || run.status === "running") return "active";
  if (run.status === "failed") return "failed";
  return "idle";
}

/** 状態の遷移（副作用なし）。読み直しの結果は、active・stalled・loading のときだけ受ける（済んだあとに遅れて届いた結果で戻さない）。 */
export function transcriptionReducer(state: TranscriptionState, event: TranscriptionEvent): TranscriptionState {
  switch (event.type) {
    case "loaded":
      return { phase: phaseOf(event.run), run: event.run, failures: 0, startError: null };
    case "start":
      return { ...state, phase: "starting", startError: null };
    case "started":
      return { phase: phaseOf(event.run), run: event.run, failures: 0, startError: null };
    case "startFailed":
      return { ...state, phase: phaseOf(state.run) === "active" ? "idle" : phaseOf(state.run), startError: event.message };
    case "polled":
      if (state.phase !== "active" && state.phase !== "stalled" && state.phase !== "loading") return state;
      return { phase: phaseOf(event.run), run: event.run, failures: 0, startError: null };
    case "pollFailed": {
      if (state.phase !== "active" && state.phase !== "loading") return state;
      const failures = state.failures + 1;
      return { ...state, failures, phase: failures >= POLL_MAX_FAILURES ? "stalled" : state.phase };
    }
    case "resume":
      return state.phase === "stalled" ? { ...state, phase: state.run && phaseOf(state.run) !== "active" ? phaseOf(state.run) : "active", failures: 0 } : state;
  }
}

/** 読み直しを続ける状態か。 */
export function shouldPoll(state: TranscriptionState): boolean {
  return state.phase === "active" || state.phase === "loading";
}

/** 実行の状態の言葉（用語表の「文字起こし」）。 */
export function runStatusLabel(run: TranscriptionRun | null): string | null {
  if (!run) return null;
  if (run.status === "queued") return "待機中";
  if (run.status === "running") return "文字起こし中";
  if (run.status === "failed") return "文字起こしに失敗しました";
  return null;
}

const FAILURE_REASONS: Record<string, string> = {
  audio_missing: "音声が見つかりませんでした。",
  audio_expired: "音声は削除されました。",
  engine_unavailable: "文字起こしのサービスにつながりませんでした。",
  engine_rejected: "文字起こしのサービスがこの音声を受け付けませんでした。",
  engine_timeout: "時間内に終わりませんでした。",
  engine_bad_response: "文字起こしの結果を読み取れませんでした。",
  too_large: "文字起こしの結果が大きすぎました。",
  internal: "サーバーで問題が起きました。",
};

/** 失敗の理由（errorCode）の短い日本語。知らない code は「うまくいきませんでした。」。 */
export function failureReason(errorCode: string | null): string {
  return (errorCode && FAILURE_REASONS[errorCode]) || "うまくいきませんでした。";
}

/** もう一度できる失敗か（音声の期限が過ぎたものはできない）。 */
export function canRetry(run: TranscriptionRun | null): boolean {
  return run?.status === "failed" && run.errorCode !== "audio_expired";
}

/** 開始の失敗の文言。has_transcript は呼ぶ側が録音を読み直す。 */
export function startErrorMessage(error: unknown): string {
  if (!(error instanceof TranscriptionRequestError)) return "つながりませんでした。ネットワークを確かめて、もう一度試してください。";
  const { status, reason } = error;
  if (status === 401) return "ログインが切れました。ログインし直してください。";
  if (status === 403) return "この画面からは始められません。ページを開き直してください。";
  if (status === 404) return "この録音が見つかりません。ページを開き直してください。";
  if (status === 409 && reason === "audio_not_ready") return "音声の取り込みが終わっていません。";
  if (status === 409 && reason === "audio_expired") return "音声は削除されました。";
  if (status === 409 && reason === "has_transcript") return "文字起こしがすでにあります。最新の文字起こしを読み込みました。";
  if (status === 502 || status === 503) return "いまは始められません。少ししてから、もう一度試してください。";
  return "いまは始められません。少ししてから、もう一度試してください。";
}

/** 音声の期限の一言。期限が分からなければ null、過ぎていれば「音声は削除されました」。日付は端末の暦。 */
export function audioExpiryLabel(audio: Pick<RecordingAudio, "expiresAt"> | null, now: number): string | null {
  if (!audio?.expiresAt) return null;
  const at = Date.parse(audio.expiresAt);
  if (!Number.isFinite(at)) return null;
  if (at <= now) return "音声は削除されました";
  const date = new Date(at);
  return `音声は ${date.getMonth() + 1}月${date.getDate()}日に削除されます`;
}

export function isAudioExpired(audio: Pick<RecordingAudio, "expiresAt"> | null, now: number): boolean {
  if (!audio?.expiresAt) return false;
  const at = Date.parse(audio.expiresAt);
  return Number.isFinite(at) && at <= now;
}
