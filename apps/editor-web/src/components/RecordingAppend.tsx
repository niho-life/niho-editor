"use client";

import { useRef, useState, type CSSProperties, type DragEvent } from "react";
import { VTT_FILE_MAX_BYTES, recordingErrorMessage } from "@/lib/recording-client";

const ROW_STYLE: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 12 };

/** 足せるファイル（1 回に何件でも。順に足す）。 */
const VTT_ACCEPT = ".vtt,text/vtt";
const VTT_NAME = /\.vtt$/i;

type Message = { kind: "info" | "error"; text: string };

function isVtt(file: File): boolean {
  return VTT_NAME.test(file.name) || file.type === "text/vtt";
}

/**
 * 1 つの文字起こし（#310 では文字起こしのタブ）に、あとの音声の文字起こし（.vtt）を足す（#36 段 3b-3「複数音声」）。
 * - 時刻は server が前の音声の長さだけずらして 1 本につなぐ（src/recording/append-transcript.ts）。
 * - 何件でも選べる（複数回の録音・複数のファイル）。選んだ順に 1 件ずつ送り、途中で失敗したらそこで止めて、何件足せたかを出す
 *   （足せた分はサーバーに残る）。
 * - 書き込みは本文の保存の列（enqueue）に並べ、`baseRevision` は送る直前の revision を使う。足す関数（`append`）と、
 *   競合（409）から最新を取り出す関数（`conflictOf`）は呼ぶ側が渡す（録音の正本と文字起こしのタブで API が違う）。
 */
export function RecordingAppend<S>({
  revision,
  append,
  conflictOf,
  onSnapshot,
  enqueue,
  disabled,
}: {
  /** 送る直前の revision（別の書き込みのあとでも最新を使う）。読めなければ null。 */
  revision: () => number | null;
  /** .vtt を足す（lib/transcript-client.ts の appendTranscriptVtt など）。 */
  append: (baseRevision: number, input: { name: string; vtt: string }) => Promise<S>;
  /** 競合の失敗から最新の本文を取り出す（競合でなければ null）。 */
  conflictOf: (error: unknown) => S | null;
  onSnapshot: (snapshot: S) => void;
  enqueue: <T>(job: () => Promise<T>) => Promise<T>;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const running = useRef(false);

  const appendFiles = async (files: readonly File[]) => {
    if (running.current || files.length === 0) return;
    const chosen = files.filter(isVtt);
    if (chosen.length === 0) {
      setMessage({ kind: "error", text: "足せるのは文字起こし済みの .vtt ファイルです。" });
      return;
    }
    running.current = true;
    setBusy(true);
    let added = 0;
    for (const file of chosen) {
      setMessage({ kind: "info", text: chosen.length > 1 ? `足しています（${added + 1}/${chosen.length} 件目）` : "足しています" });
      if (file.size > VTT_FILE_MAX_BYTES) {
        setMessage({ kind: "error", text: `${file.name}は大きすぎます。足せる .vtt は 4 MiB までです。` });
        break;
      }
      const vtt = await file.text().catch(() => null);
      if (vtt === null) {
        setMessage({ kind: "error", text: `${file.name}を読み込めませんでした。選び直してください。` });
        break;
      }
      try {
        const next = await enqueue(async () => {
          const base = revision();
          if (base === null) throw new Error("no revision");
          return append(base, { name: file.name, vtt });
        });
        onSnapshot(next);
        added += 1;
      } catch (error) {
        const latest = conflictOf(error);
        if (latest !== null) onSnapshot(latest);
        const reason = recordingErrorMessage(error, "append");
        setMessage({ kind: "error", text: added > 0 ? `${added} 件足しました。${file.name}は足せませんでした。${reason}` : reason });
        break;
      }
    }
    if (added === chosen.length) setMessage({ kind: "info", text: added > 1 ? `${added} 件の文字起こしを足しました` : "文字起こしを足しました" });
    running.current = false;
    setBusy(false);
  };

  const choose = (files: FileList | null) => {
    if (busy || disabled) return;
    void appendFiles([...(files ?? [])]);
  };

  return (
    <div
      data-recording-append={busy ? "busy" : "idle"}
      onDragOver={(event: DragEvent) => event.preventDefault()}
      onDrop={(event: DragEvent) => {
        event.preventDefault();
        choose(event.dataTransfer.files);
      }}
    >
      <div style={ROW_STYLE}>
        <button
          type="button"
          className="es-btn es-btn--outline es-btn--sm"
          aria-disabled={busy || disabled || undefined}
          onClick={() => {
            if (busy || disabled) return;
            setMessage(null);
            input.current?.click();
          }}
        >
          文字起こしを足す
        </button>
        <span className="es-note">あとの録音の .vtt を足すと、前の音声の長さだけ時刻をずらして 1 本につなぎます</span>
      </div>
      <input
        ref={input}
        type="file"
        accept={VTT_ACCEPT}
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          choose(event.target.files);
          // 同じファイルをもう一度選んでも change が起きるように
          event.target.value = "";
        }}
      />
      {message?.kind === "info" && (
        <p role="status" aria-live="polite" className="es-note">
          {message.text}
        </p>
      )}
      {message?.kind === "error" && (
        <p role="alert" data-recording-append-error="">
          {message.text}
        </p>
      )}
    </div>
  );
}
