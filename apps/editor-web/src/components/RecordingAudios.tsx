"use client";

import { useRef, useState, type CSSProperties, type DragEvent } from "react";
import { AUDIO_FILE_ACCEPT, isAudioFileName } from "@/lib/audio-formats";
import { probeAudioDuration } from "@/lib/audio-duration";
import { AudioUploadError, audioUploadMessage, discardAudioPartUpload, uploadAudioPart, type AudioPartView, type UploadAudioFileInput } from "@/lib/audio-upload-client";
import type { MicRecording } from "@/lib/mic-recorder";
import { formatClock } from "@/lib/recording-view";
import { audioExpiryLabel, isAudioExpired } from "@/lib/transcription-view";
import { AUDIO_STAGE_LABELS, useAudioImport } from "@/lib/use-audio-import";
import { micErrorMessage, useMicCapture } from "@/lib/use-mic-capture";

const ROW_STYLE: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 };
const PROGRESS_STYLE: CSSProperties = { flex: "1 1 160px", minWidth: 0, width: "100%" };
const LIST_STYLE: CSSProperties = { listStyle: "none", margin: "6px 0 0", padding: 0 };

type Message = { kind: "info" | "error"; text: string };

function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** 1 本の音声の説明（長さ・大きさ・状態・期限）。状態は文で出す（色だけで表さない）。 */
function partDetail(part: AudioPartView, now: number): string {
  const parts = [part.durationSec !== null && part.durationSec > 0 ? formatClock(part.durationSec) : null, sizeLabel(part.bytes)].filter(
    (item): item is string => item !== null,
  );
  if (part.status !== "uploaded") parts.push("取り込み中");
  else if (isAudioExpired(part, now)) parts.push("音声は削除されました");
  else {
    const expiry = audioExpiryLabel(part, now);
    if (expiry) parts.push(expiry);
  }
  return parts.join(" · ");
}

/**
 * 録音ページの音声の列（#36 段 3b-4）。1 本目（録音を作った音声）に続けて、あとの音声を足せる。
 * - 足した音声は、文字起こしを**やり直す**と前の音声の長さだけ時刻をずらして 1 本につながる（compose-parts.ts）。
 * - ファイルを選ぶ（何本でも。順に送る）か、その場で録音する（マイク）。進み具合が見え、中止できる。
 * - 期限（30 日で削除）と取り込み中は、それぞれの行に文で出す。
 */
export function RecordingAudios({
  pageId,
  audios,
  onChanged,
  disabled,
}: {
  pageId: string;
  audios: readonly AudioPartView[];
  /** 音声が増えた（録音を読み直す）。 */
  onChanged: () => void;
  disabled?: boolean;
}) {
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [now] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const audio = useAudioImport({ upload: (request: UploadAudioFileInput) => uploadAudioPart({ ...request, pageId }) });

  const send = async (file: File, durationSec: number | null): Promise<boolean> => {
    const outcome = await audio.run(file, { durationSec });
    if (outcome.ok) return true;
    setMessage({ kind: outcome.kind === "aborted" ? "info" : "error", text: audioUploadMessage(outcome.kind) });
    return false;
  };

  /** 選んだファイルを順に足す（途中で失敗したらそこで止める）。 */
  const addFiles = async (files: readonly File[]) => {
    if (running.current || disabled) return;
    const chosen = files.filter((file) => isAudioFileName(file.name));
    if (chosen.length === 0) {
      setMessage({ kind: "error", text: "足せるのは音声ファイルです。文字起こし済みの .vtt は「文字起こしを足す」から足せます。" });
      return;
    }
    running.current = true;
    setBusy(true);
    let added = 0;
    for (const file of chosen) {
      setMessage({ kind: "info", text: chosen.length > 1 ? `音声を足しています（${added + 1}/${chosen.length} 本目）` : "音声を足しています" });
      const duration = await probeAudioDuration(file).catch(() => null);
      if (!(await send(file, duration))) break;
      added += 1;
      onChanged();
    }
    if (added === chosen.length) {
      setMessage({ kind: "info", text: `音声を ${added} 本足しました。文字起こしをやり直すと 1 本につながります` });
    }
    running.current = false;
    setBusy(false);
  };

  const mic = useMicCapture({
    onRecorded: (recording: MicRecording) => {
      void (async () => {
        if (running.current) return;
        running.current = true;
        setBusy(true);
        setMessage({ kind: "info", text: "録音を足しています" });
        const ok = await send(recording.file, recording.durationSec);
        if (ok) {
          setMessage({ kind: "info", text: "録音を足しました。文字起こしをやり直すと 1 本につながります" });
          mic.discard();
          onChanged();
        }
        running.current = false;
        setBusy(false);
      })();
    },
  });
  const micStatus = mic.capture.status;
  const micBusy = micStatus === "requesting" || micStatus === "recording" || micStatus === "stopping";
  const locked = busy || micBusy || disabled === true;

  const startMic = async () => {
    setMessage(null);
    setConfirmDiscard(false);
    const failed = await mic.start();
    if (failed) setMessage({ kind: "error", text: micErrorMessage(failed) });
  };

  /**
   * 途中でやめた（アップロードが済んでいない）音声を取り除く。残しておくと、その録音は文字起こしを始められない。
   * 取り込みの最中に出す必要はないので、取り込み中（この画面が送っている間）は押せない。
   */
  const discardUnfinished = async (part: AudioPartView) => {
    if (running.current || disabled) return;
    running.current = true;
    setBusy(true);
    try {
      await discardAudioPartUpload(pageId, part.partIndex);
      setMessage({ kind: "info", text: `音声 ${part.partIndex + 1} の取り込みを取り消しました` });
      onChanged();
    } catch (error) {
      // 既に済んでいた（409）なら、読み直せば普通の音声として出る
      if (error instanceof AudioUploadError && error.status === 409) onChanged();
      setMessage({ kind: "error", text: error instanceof AudioUploadError && error.status === 409 ? "この音声はもう取り込みが済んでいます" : audioUploadMessage(error instanceof AudioUploadError && error.status === 401 ? "unauthorized" : "other") });
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const progress = audio.progress;
  return (
    <section
      aria-label="音声"
      data-recording-audios={busy ? "busy" : "idle"}
      onDragOver={(event: DragEvent) => event.preventDefault()}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        void addFiles([...event.dataTransfer.files]);
      }}
    >
      <h3 className="es-note">音声</h3>
      <ul style={LIST_STYLE}>
        {audios.map((part) => (
          <li key={part.partIndex} className="es-note" data-audio-part={part.partIndex}>
            音声 {part.partIndex + 1}
            {part.sourceName ? `（${part.sourceName}）` : ""} · {partDetail(part, now)}
            {part.status !== "uploaded" && part.partIndex > 0 && (
              <>
                {" "}
                <button
                  type="button"
                  className="es-btn es-btn--quiet es-btn--sm"
                  aria-disabled={locked || undefined}
                  aria-label={`音声 ${part.partIndex + 1} の取り込みを取り消す`}
                  onClick={() => void discardUnfinished(part)}
                >
                  取り消す
                </button>
              </>
            )}
          </li>
        ))}
        {audios.length === 0 && (
          <li className="es-note" data-audio-part="none">
            この録音には音声がありません
          </li>
        )}
      </ul>
      {micStatus === "recording" || micStatus === "stopping" ? (
        <div style={ROW_STYLE} data-mic="recording">
          <span className="es-note">録音中</span>
          <time role="timer" aria-label="録音の経過時間" dateTime={`PT${Math.floor((mic.capture.status === "recording" ? mic.capture.elapsedMs : 0) / 1000)}S`}>
            {formatClock(mic.capture.status === "recording" ? mic.capture.elapsedMs / 1000 : 0)}
          </time>
          <span className="es-sp" />
          <button type="button" className="es-btn es-btn--primary es-btn--sm" onClick={() => void mic.stop()}>
            止めて足す
          </button>
          {!confirmDiscard && (
            <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={() => setConfirmDiscard(true)}>
              やめる
            </button>
          )}
        </div>
      ) : (
        !busy && (
          <div style={ROW_STYLE}>
            <button
              type="button"
              className="es-btn es-btn--outline es-btn--sm"
              aria-disabled={locked || undefined}
              onClick={() => {
                if (locked) return;
                setMessage(null);
                input.current?.click();
              }}
            >
              音声を足す
            </button>
            <button type="button" className="es-btn es-btn--outline es-btn--sm" aria-disabled={locked || undefined} onClick={() => void startMic()}>
              録音して足す
            </button>
            <span className="es-note">足した音声は、文字起こしをやり直すと 1 本につながります</span>
          </div>
        )
      )}
      {confirmDiscard && (micStatus === "recording" || micStatus === "stopping") && (
        <div style={ROW_STYLE} role="group" aria-label="録音を消す">
          <span className="es-note">いまの録音を消しますか</span>
          <span className="es-sp" />
          <button
            type="button"
            className="es-btn es-btn--outline es-btn--sm"
            onClick={() => {
              mic.discard();
              setConfirmDiscard(false);
            }}
          >
            消す
          </button>
          <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={() => setConfirmDiscard(false)}>
            やめる
          </button>
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept={AUDIO_FILE_ACCEPT}
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          void addFiles([...(event.target.files ?? [])]);
          // 同じファイルをもう一度選んでも change が起きるように
          event.target.value = "";
        }}
      />
      {progress && (
        <div style={ROW_STYLE} data-audio-part-import={progress.stage}>
          <progress max={100} value={progress.percent} aria-label="取り込みの進み具合" style={PROGRESS_STYLE} />
          <span className="es-note" aria-hidden="true">
            {progress.percent}%
          </span>
          <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={audio.cancel}>
            中止
          </button>
        </div>
      )}
      <p role="status" aria-live="polite" className="es-note">
        {progress ? AUDIO_STAGE_LABELS[progress.stage] : message?.kind === "info" ? message.text : ""}
      </p>
      {message?.kind === "error" && (
        <p role="alert" data-recording-audios-error="">
          {message.text}
        </p>
      )}
    </section>
  );
}
