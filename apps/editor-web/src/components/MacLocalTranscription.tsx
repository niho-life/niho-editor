"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isShellWindow, type ShellBridge } from "niho-desktop-bridge/shell-bridge";
import { getMacLocalTranscription } from "@/lib/mac-local-transcription-client";
import { MacLocalTranscriptionError, runMacLocalTranscription, type MacLocalProgress } from "@/lib/mac-local-transcription";

const ROW: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 };
const ERRORS: Record<MacLocalTranscriptionError["code"], string> = {
  unsupported: "この版のMacアプリはApple端末内文字起こしの現行方式に対応していません。アプリを更新してください。",
  changed: "ページ、音声、設定、または書き先のタブが変わったため、古い結果は保存しませんでした。",
  failed: "このMacで文字起こしを終えられませんでした。音声はサーバーとこのMacに残っています。",
  saving: "認識結果はこのMacに保存待ちで残っています。再試行しても認識はやり直しません。",
  stopped: "止めました。成功としては保存していません。",
};

function progressText(value: MacLocalProgress | null): string | null {
  if (!value) return null;
  if (value.phase === "staging") return `音声をこのMacに準備しています（${value.completed}/${value.total}）`;
  if (value.phase === "transcribing") return "Appleの端末内音声認識で文字起こししています";
  if (value.phase === "saving") return "結果をサーバーへ保存しています";
  return "文字起こしを保存しました";
}

type Props = { pageId: string; disabled?: boolean; /** 保存した（結果は「文字起こし」ページの新しいタブ）。 */ onSucceeded: () => void };

export function MacLocalTranscription(props: Props) {
  return <MacLocalTranscriptionPage key={props.pageId} {...props} />;
}

function MacLocalTranscriptionPage({ pageId, disabled, onSucceeded }: Props) {
  const [shell, setShell] = useState<ShellBridge | null>(null);
  const [oldShell, setOldShell] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<MacLocalProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (typeof window === "undefined" || !isShellWindow(window)) return;
    void import("niho-desktop-bridge/tauri-shell-transport").then(async ({ detectShell }) => {
      const detected = detectShell();
      if (!detected) return;
      try {
        const capabilities = await detected.capabilities();
        if (cancelled) return;
        if (capabilities.features.localTranscriptionV2 !== true) {
          setOldShell(true);
          return;
        }
        setShell(detected);
        const latest = await getMacLocalTranscription(pageId).catch(() => null);
        if (!cancelled && latest?.run.status !== "succeeded") setOperationId(latest?.operationId ?? null);
      } catch { /* 壊れた bridge では実行入口を出さない。 */ }
    });
    return () => { cancelled = true; controller.current?.abort(); };
  }, [pageId]);

  if (oldShell) return <p className="es-note">Apple端末内文字起こしを使うにはMacアプリを更新してください。</p>;
  if (!shell) return null;

  const start = async () => {
    if (disabled || running) return;
    const next = new AbortController();
    controller.current = next;
    setRunning(true);
    setError(null);
    try {
      await runMacLocalTranscription({ shell, pageId, ...(operationId ? { operationId } : {}), signal: next.signal, onProgress: setProgress });
      setOperationId(null);
      onSucceeded();
    } catch (cause) {
      const known = cause instanceof MacLocalTranscriptionError ? cause : new MacLocalTranscriptionError("failed");
      setError(ERRORS[known.code]);
      if (known.code === "changed") setOperationId(null);
      else {
        const latest = await getMacLocalTranscription(pageId).catch(() => null);
        setOperationId(latest?.operationId ?? operationId);
      }
    } finally {
      if (controller.current === next) controller.current = null;
      setRunning(false);
    }
  };

  return <div data-mac-local-transcription={running ? "running" : operationId ? "resumable" : "idle"}>
    <div style={ROW}>
      {running
        ? <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={() => controller.current?.abort()}>止める</button>
        : <button type="button" className="es-btn es-btn--outline es-btn--sm" disabled={disabled} onClick={() => void start()}>{operationId ? "Apple端末内文字起こしを再開" : "Apple端末内で文字起こし"}</button>}
      <span className="es-note">音声認識はこのMac内で行い、他のproviderへ自動送信しません</span>
    </div>
    {progressText(progress) && <p role="status" aria-live="polite" className="es-note">{progressText(progress)}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
