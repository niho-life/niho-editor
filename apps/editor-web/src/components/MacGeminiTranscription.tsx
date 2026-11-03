"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isShellWindow, type ShellBridge } from "niho-desktop-bridge/shell-bridge";
import { MacGeminiTranscriptionError, runMacGeminiTranscription, type MacGeminiProgress } from "@/lib/mac-gemini-transcription";
import { getMacTranscription } from "@/lib/mac-transcription-client";

const ROW: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 };

const ERROR_TEXT: Record<MacGeminiTranscriptionError["code"], string> = {
  unsupported: "この版のMacアプリはGemini CLI文字起こしに対応していません。アプリを更新してください。",
  unavailable: "このMacでAntigravity CLIまたはgemini-3.8-flashを使えません。CLIの導入とモデルを確かめてください。",
  auth: "Antigravity CLIへのログインが必要です。CLIでログインしてから、もう一度お試しください。",
  changed: "音声または実行設定が変わりました。古いcheckpointはこのMacに残しています。現在の音声で新しい文字起こしを開始できます。",
  checkpoint: "このMacに残した文字起こしの検査に失敗しました。結果を上書きせず停止しました。",
  incomplete: "音声の区切りを書き切れませんでした。終わった区切りまで残してあります。もう一度で続けられます。",
  failed: "Gemini CLIの文字起こしを終えられませんでした。終わった区切りまで残してあります。",
  saving: "生成結果はこのMacに保存待ちで残っています。ページを読み直し、保存を再試行してください。",
  stopped: "止めました。終わった区切りまでこのMacに残してあります。",
  usage: "Geminiの利用上限に達しました。上限が戻ってから、続きから再開してください。",
};

function progressText(progress: MacGeminiProgress | null): string | null {
  if (!progress) return null;
  switch (progress.phase) {
    case "staging": return `音声をこのMacに準備しています（${progress.completed}/${progress.total}）`;
    case "preparing": return "音声を10分ずつに分けています";
    case "transcribing": return `Geminiで文字起こししています（${progress.completed}/${progress.total}）`;
    case "saving": return "結果を保存しています";
    case "done": return "文字起こしを保存しました";
  }
}

type MacGeminiTranscriptionProps = {
  pageId: string;
  hasTranscript: boolean;
  disabled?: boolean;
  onSucceeded: () => void;
};

export function MacGeminiTranscription(props: MacGeminiTranscriptionProps) {
  return <MacGeminiTranscriptionPage key={props.pageId} {...props} />;
}

function MacGeminiTranscriptionPage({ pageId, hasTranscript, disabled, onSucceeded }: MacGeminiTranscriptionProps) {
  const [shell, setShell] = useState<ShellBridge | null>(null);
  const [supported, setSupported] = useState(false);
  const [running, setRunning] = useState(false);
  const [resumable, setResumable] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [progress, setProgress] = useState<MacGeminiProgress | null>(null);
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
        if (cancelled || capabilities.features.geminiCliTranscription !== true) return;
        setShell(detected);
        setSupported(true);
        const latest = await getMacTranscription(pageId).catch(() => null);
        if (cancelled || !latest || latest.run.status === "succeeded") return;
        setOperationId(latest.operationId);
        setResumable(latest.run.status === "failed" || latest.run.status === "running");
      } catch {
        // capabilityを確認できない旧版・壊れたbridgeでは入口を出さない。
      }
    });
    return () => {
      cancelled = true;
      controller.current?.abort();
      controller.current = null;
    };
  }, [pageId]);

  if (!supported || !shell) return null;

  const start = async () => {
    if (running || disabled) return;
    const next = new AbortController();
    const startedPage = pageId;
    const active = () => controller.current === next;
    controller.current = next;
    setRunning(true);
    setError(null);
    try {
      await runMacGeminiTranscription({
        shell,
        pageId,
        ...(operationId ? { operationId } : {}),
        signal: next.signal,
        onProgress: (value) => { if (active()) setProgress(value); },
      });
      if (!active()) return;
      setResumable(false);
      setSavePending(false);
      setOperationId(null);
      onSucceeded();
    } catch (cause) {
      if (!active()) return;
      const known = cause instanceof MacGeminiTranscriptionError ? cause : new MacGeminiTranscriptionError("failed");
      setError(ERROR_TEXT[known.code]);
      setSavePending(known.code === "saving");
      const canStartFresh = known.code === "changed";
      setResumable(!canStartFresh);
      if (canStartFresh) {
        // 音声・revisionが変わって旧runを再開できない場合、次回は新しいoperation IDを発行する。
        // 旧checkpointはそのrun IDに結び付いたまま保持し、ここでは破棄しない。
        setOperationId(null);
      } else {
        const latest = await getMacTranscription(startedPage).catch(() => null);
        if (active() && latest) setOperationId(latest.operationId);
      }
    } finally {
      if (active()) {
        controller.current = null;
        setRunning(false);
      }
    }
  };

  return (
    <div data-mac-gemini-transcription={running ? "running" : resumable ? "resumable" : "idle"}>
      <div style={ROW}>
        {!running ? (
          <button type="button" className="es-btn es-btn--outline es-btn--sm" disabled={disabled} onClick={() => void start()}>
            {savePending ? "生成結果の保存を再試行" : resumable ? "Gemini（このMacのCLI）で続ける" : hasTranscript ? "Gemini（このMacのCLI）で別案を作る" : "Gemini（このMacのCLI）で文字起こし"}
          </button>
        ) : (
          <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={() => controller.current?.abort()}>
            止める
          </button>
        )}
        <span className="es-note">このMacのAntigravity CLIから音声をGoogle Geminiへ送ります</span>
      </div>
      {progressText(progress) && <p role="status" aria-live="polite" className="es-note">{progressText(progress)}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
