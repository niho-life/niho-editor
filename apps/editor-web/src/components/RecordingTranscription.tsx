"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { RecordingAudio } from "@niho/editor-store";
import {
  audioExpiryLabel,
  canRetry,
  failureReason,
  isAudioExpired,
  runStatusLabel,
} from "@/lib/transcription-view";
import { canDiscloseTranscriptionEngine, transcriptionServiceNote } from "@/recording/candidate-names";
import { useTranscription } from "@/lib/use-transcription";

const ROW_STYLE: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 };

/**
 * 録音ページの文字起こしの開始と状態（#36 段 3b-1。音声のある録音だけ）。
 * - 音声がアップロード済みで段落が空なら「文字起こしをはじめる」。状態（待機中・文字起こし中）は読み上げ、失敗は理由と「もう一度」。
 * - 段落があるときに始める（「もう一度文字起こしする」・失敗の「もう一度」）は、置き換えることを 1 回確かめてから `replace: true`。
 *   文字起こしするのはこのページの音声だけなので、あとから足した分（RecordingAppend）も置き換えで消える。確かめる欄でそう言う。
 * - 音声の期限（30 日で削除）を小さく出し、過ぎていたら「音声は削除されました」（段落は残る）。
 * - 音声を送る先は、始める・置き換える前にサービス名まで表示する。送信先が分からない場合は開始させない。
 */
export function RecordingTranscription({
  pageId,
  audio,
  engine,
  hasTranscript,
  onSucceeded,
  onHasTranscript,
}: {
  pageId: string;
  audio: RecordingAudio;
  engine: string | null;
  hasTranscript: boolean;
  /** 実行が済んだ（録音を読み直す）。 */
  onSucceeded: () => void;
  /** 段落がすでにあると断られた（録音を読み直す）。 */
  onHasTranscript: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const uploaded = audio.status === "uploaded";
  const expired = isAudioExpired(audio, now);
  const { state, start, resume } = useTranscription(pageId, { enabled: uploaded, hasTranscript, onSucceeded, onHasTranscript });
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // やめたあと、押したボタンへフォーカスを戻す（ボタンは確かめる欄を閉じてから描かれる）
  const refocus = useRef(false);

  // 確かめる欄を開いたら「やめる」へ（置き換えない側）。閉じたら押したボタンへ戻す
  useEffect(() => {
    if (confirming) {
      cancelRef.current?.focus();
    } else if (refocus.current) {
      refocus.current = false;
      triggerRef.current?.focus();
    }
  }, [confirming]);

  const { phase, run } = state;
  const starting = phase === "starting";
  const canStart = canDiscloseTranscriptionEngine(engine) && uploaded && !expired && (phase === "idle" || phase === "starting" || (phase === "failed" && canRetry(run)));
  const label = phase === "failed" ? "もう一度" : hasTranscript ? "もう一度文字起こしする" : "文字起こしをはじめる";
  const statusText = starting ? "始めています" : phase === "active" ? runStatusLabel(run) : null;
  const expiry = audioExpiryLabel(audio, now);

  const begin = () => {
    if (starting) return;
    if (hasTranscript) setConfirming(true);
    else void start(false);
  };
  const closeConfirm = () => {
    refocus.current = true;
    setConfirming(false);
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
      {canStart && !confirming && (
        <div style={ROW_STYLE}>
          <button
            ref={triggerRef}
            type="button"
            className={`es-btn es-btn--sm ${hasTranscript && phase !== "failed" ? "es-btn--outline" : "es-btn--primary"}`}
            aria-disabled={starting || undefined}
            onClick={begin}
          >
            {label}
          </button>
          {/* 段落があるときは、送る前の確かめる欄に出す */}
          {!hasTranscript && <span className="es-note">{transcriptionServiceNote(engine)}</span>}
        </div>
      )}
      {canStart && confirming && (
        <div
          role="group"
          aria-label="文字起こしの置き換え"
          style={ROW_STYLE}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeConfirm();
            }
          }}
        >
          <span>いまの文字起こしは、足した分も含めて置き換えられます</span>
          <button
            type="button"
            className="es-btn es-btn--primary es-btn--sm"
            onClick={() => {
              setConfirming(false);
              void start(true);
            }}
          >
            置き換える
          </button>
          <button ref={cancelRef} type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={closeConfirm}>
            やめる
          </button>
          <span className="es-note">{transcriptionServiceNote(engine)}</span>
        </div>
      )}
      {expiry && <p className="es-note">{expiry}</p>}
    </div>
  );
}
