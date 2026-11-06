"use client";

import { useEffect, useState, type CSSProperties } from "react";
import type { RecordingAudio } from "@niho/editor-store";
import {
  audioExpiryLabel,
  canRetry,
  failureReason,
  isAudioExpired,
  runStatusLabel,
} from "@/lib/transcription-view";
import { canDiscloseTranscriptionEngine, transcriptionEngineLabel, transcriptionServiceNote } from "@/recording/engine-names";
import { useTranscription } from "@/lib/use-transcription";
import { MacGeminiTranscription } from "./MacGeminiTranscription";
import { MacLocalTranscription } from "./MacLocalTranscription";

const ROW_STYLE: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 };

/**
 * 録音のタブの文字起こしの開始と状態（#36 段 3b-1 → #310。音声のある録音だけ）。
 * - 音声がアップロード済みなら「文字起こしをはじめる」（設定の既定のエンジン。別のエンジンは「ページ」パネルの流れの ▾ から）。
 *   結果は「文字起こし」ページの新しいタブに入るので、置き換えの確認は要らない。始めたらそのタブを開く（`onStarted`）。
 * - 状態（待機中・文字起こし中）は読み上げ、失敗は理由と「もう一度」（同じタブに書き直す）。
 * - 音声の期限（30 日で削除）を小さく出し、過ぎていたら「音声は削除されました」（文字起こしのタブは残る）。
 * - 音声を送る先は、始める前にサービス名まで表示する。送信先が分からない場合は開始させない。
 */
export function RecordingTranscription({
  pageId,
  audio,
  engine,
  onStarted,
  onSucceeded,
}: {
  pageId: string;
  audio: RecordingAudio;
  /** 設定の既定のエンジン（送信先の表示に使う）。 */
  engine: string | null;
  /** 始めた（結果を書く文字起こしのタブ。画面はそれを開く）。 */
  onStarted: (tab: string | null) => void;
  /** 実行が済んだ（文字起こしのタブの一覧を読み直す）。 */
  onSucceeded: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const uploaded = audio.status === "uploaded";
  const expired = isAudioExpired(audio, now);
  const { state, start, resume } = useTranscription(pageId, { enabled: uploaded, hasTranscript: true, onSucceeded });

  const { phase, run } = state;
  const starting = phase === "starting";
  const retry = phase === "failed" && canRetry(run);
  const canStart = canDiscloseTranscriptionEngine(engine) && uploaded && !expired && (phase === "idle" || phase === "starting" || retry);
  const statusText = starting ? "始めています" : phase === "active" ? `${runStatusLabel(run)}（${transcriptionEngineLabel(run?.engine ?? engine)}）` : null;
  const expiry = audioExpiryLabel(audio, now);

  const begin = async () => {
    if (starting) return;
    // 失敗した run の「もう一度」は、同じタブに書き直す（失敗したタブを増やさない）
    const started = await start(retry && run?.tab ? { tab: run.tab, engine: run.engine } : {});
    if (started) onStarted(started.tab);
  };

  return (
    <div data-transcription={phase} data-audio-status={audio.status}>
      <p role="status" aria-live="polite" className="es-note">
        {statusText}
      </p>
      {phase === "failed" && run && (
        <p role="alert" data-transcription-error={run.errorCode ?? ""}>
          {runStatusLabel(run)}。{failureReason(run.errorCode)}
        </p>
      )}
      {phase === "stalled" && (
        <div role="alert" style={ROW_STYLE}>
          <span>文字起こしの状態を更新できません。</span>
          <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={resume}>
            更新する
          </button>
        </div>
      )}
      {state.startError && <p role="alert">{state.startError}</p>}
      {!uploaded && <p className="es-note">音声の取り込みが終わっていません</p>}
      {uploaded && !canDiscloseTranscriptionEngine(engine) && <p className="es-note">{transcriptionServiceNote(engine)}</p>}
      {canStart && (
        <div style={ROW_STYLE}>
          <button type="button" className={`es-btn es-btn--sm ${retry ? "es-btn--outline" : "es-btn--primary"}`} aria-disabled={starting || undefined} onClick={() => void begin()}>
            {retry ? "もう一度" : "文字起こしをはじめる"}
          </button>
          <span className="es-note">{transcriptionServiceNote(retry && run ? run.engine : engine)}</span>
        </div>
      )}
      {expiry && <p className="es-note">{expiry}</p>}
      {uploaded && !expired && <MacGeminiTranscription pageId={pageId} onSucceeded={onSucceeded} />}
      {uploaded && !expired && <MacLocalTranscription pageId={pageId} onSucceeded={onSucceeded} />}
    </div>
  );
}
