"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ShellAudioRecovery } from "niho-desktop-bridge/shell-contract";
import { isShellWindow, type ShellBridge } from "niho-desktop-bridge/shell-bridge";
import { macNativeAudioOwnerScope, uploadMacNativeAudio } from "@/lib/mac-native-audio";

const ROW: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 12 };

export function MacNativeAudioImport({ onCreated }: { onCreated: (page: { id: string; title: string }) => void }) {
  const [shell, setShell] = useState<ShellBridge | null>(null);
  const [scope, setScope] = useState<string | null>(null);
  const [oldShell, setOldShell] = useState(false);
  const [recoveries, setRecoveries] = useState<ShellAudioRecovery[]>([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<{ recordingId: string; stagingId: string } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const recordingRef = useRef<{ recordingId: string; stagingId: string } | null>(null);
  const shellRef = useRef<ShellBridge | null>(null);
  const scopeRef = useRef<string | null>(null);
  const acquiring = useRef(false);
  const stopping = useRef(false);

  const refresh = async (activeShell: ShellBridge, ownerScope: string) => {
    const found = await activeShell.audioRecovery(ownerScope);
    setRecoveries(found);
  };

  useEffect(() => {
    let cancelled = false;
    if (typeof window === "undefined" || !isShellWindow(window)) return;
    void import("niho-desktop-bridge/tauri-shell-transport").then(async ({ detectShell }) => {
      const detected = detectShell();
      if (!detected) return;
      try {
        const capabilities = await detected.capabilities();
        if (cancelled) return;
        if (capabilities.features.nativeAudioV2 !== true) {
          setOldShell(true);
          return;
        }
        const ownerScope = await macNativeAudioOwnerScope();
        if (cancelled) return;
        shellRef.current = detected;
        scopeRef.current = ownerScope;
        setShell(detected);
        setScope(ownerScope);
        await refresh(detected, ownerScope);
      } catch { /* browser/旧 bridge では既存 Web 経路だけを残す。 */ }
    });
    return () => {
      cancelled = true;
      stopping.current = true;
      controller.current?.abort();
      const activeShell = shellRef.current;
      const ownerScope = scopeRef.current;
      const activeRecording = recordingRef.current;
      if (activeShell && ownerScope && activeRecording) {
        void activeShell.recordingStop(activeRecording.recordingId)
          .then(() => activeShell.audioPrepareResume(crypto.randomUUID(), activeRecording.stagingId, ownerScope))
          .catch(() => undefined);
      }
    };
  }, []);

  if (oldShell) return <p className="es-note">Macのマイク・AIFC等の取り込みと復旧を使うにはMacアプリを更新してください。</p>;
  if (!shell || !scope) return null;

  const assertCurrentOwner = async () => {
    if (await macNativeAudioOwnerScope() !== scope) throw new Error("native audio owner changed");
  };

  const prepareWithCancellation = async <T,>(run: (jobId: string) => Promise<T>): Promise<T> => {
    const active = new AbortController();
    const jobId = crypto.randomUUID();
    const stop = () => { void shell.transcribeStop(jobId).catch(() => undefined); };
    active.signal.addEventListener("abort", stop, { once: true });
    controller.current = active;
    try {
      const result = await run(jobId);
      if (active.signal.aborted) throw new DOMException("aborted", "AbortError");
      return result;
    } finally {
      active.signal.removeEventListener("abort", stop);
      if (controller.current === active) controller.current = null;
    }
  };

  const upload = async (recovery: ShellAudioRecovery) => {
    const active = new AbortController();
    controller.current = active;
    setBusy(true);
    setError(null);
    try {
      const result = await uploadMacNativeAudio({
        shell,
        recovery,
        ownerScope: scope,
        signal: active.signal,
        onProgress: ({ file, files, fraction }) => setProgress(`音声を送っています（${file + 1}/${files}、${Math.floor(fraction * 100)}%）`),
      });
      setRecoveries((items) => items.filter((item) => item.stagingId !== recovery.stagingId));
      onCreated(result.page);
    } catch {
      setError(active.signal.aborted ? "中止しました。一時音声はこのMacに残っています。" : "取り込みを完了できませんでした。一時音声を残したので「再開」できます。");
      await refresh(shell, scope).catch(() => undefined);
    } finally {
      if (controller.current === active) controller.current = null;
      setBusy(false);
      setProgress(null);
    }
  };

  const prepareAndUpload = async (source: { kind: "recording"; recordingId: string } | { kind: "staged"; stagingId: string }) => {
    setBusy(true);
    setError(null);
    setProgress("このMacで固定形式へ変換しています");
    try {
      const recovery = await prepareWithCancellation((jobId) => shell.audioPrepare(jobId, source, scope));
      setRecoveries((items) => [...items.filter((item) => item.stagingId !== recovery.stagingId), recovery]);
      setBusy(false);
      await upload(recovery);
    } catch {
      setError("音声を変換できませんでした。元の音声はこのMacに残しています。");
      await refresh(shell, scope).catch(() => undefined);
      setBusy(false);
      setProgress(null);
    }
  };

  const pick = async () => {
    if (busy || recording || acquiring.current) return;
    acquiring.current = true;
    setBusy(true);
    setError(null);
    try {
      await assertCurrentOwner();
      const selected = await shell.audioPick();
      if (selected) {
        await assertCurrentOwner();
        await prepareAndUpload({ kind: "staged", stagingId: selected.stagingId });
      }
    } catch {
      setError("ログインが変わりました。画面を読み直してください。このMacの一時音声は送信・破棄していません。");
    } finally {
      acquiring.current = false;
      setBusy(false);
    }
  };

  const startMic = async () => {
    if (busy || recording || acquiring.current) return;
    acquiring.current = true;
    setBusy(true);
    setError(null);
    const recordingId = crypto.randomUUID();
    let recoveryId: string | null = null;
    let terminal: "Error" | "Done" | null = null;
    let recoveryRequested = false;
    const recover = (type: "Error" | "Done") => {
      // 手動停止では stopMic だけが変換を始める。Error/Done の連続通知も1回へ収束させる。
      if (stopping.current) return;
      terminal = type;
      if (!recoveryId || recoveryRequested) return;
      recoveryRequested = true;
      recordingRef.current = null;
      setRecording(null);
      setError(type === "Error" ? "録音が途中で止まりました。回収できる音声はこのMacに残します。" : "録音が途中で終了しました。一時音声から再開できます。");
      void shell.audioPrepareResume(crypto.randomUUID(), recoveryId, scope)
        .then((item) => setRecoveries((items) => [...items.filter((known) => known.stagingId !== item.stagingId), item]))
        .catch(() => refresh(shell, scope).catch(() => undefined));
    };
    try {
      await assertCurrentOwner();
      const permission = await shell.micStatus(true).catch(() => "denied" as const);
      if (permission !== "authorized") {
        setError("マイクの使用が許可されていません。システム設定を確認してください。");
        return;
      }
      await assertCurrentOwner();
      const started = await shell.recordingStartV2(recordingId, scope, (event) => {
        if (event.type === "Error" || event.type === "Done") recover(event.type);
      });
      recoveryId = started.stagingId;
      if (terminal !== null) {
        recover(terminal);
        return;
      }
      const active = { recordingId, stagingId: started.stagingId };
      recordingRef.current = active;
      setRecording(active);
    } catch {
      setError("このMacで録音を始められませんでした。");
    } finally {
      acquiring.current = false;
      setBusy(false);
    }
  };

  const stopMic = async () => {
    const active = recordingRef.current;
    if (!active || busy || stopping.current) return;
    stopping.current = true;
    setBusy(true);
    try {
      await shell.recordingStop(active.recordingId);
      recordingRef.current = null;
      setRecording(null);
      await assertCurrentOwner();
      const recovery = await prepareWithCancellation((jobId) => shell.audioPrepareResume(jobId, active.stagingId, scope));
      await upload(recovery);
    } catch {
      recordingRef.current = null;
      setRecording(null);
      setError("録音を正常終了できませんでした。音声はこのMacに残しています。");
      try {
        await assertCurrentOwner();
        const recovery = await prepareWithCancellation((jobId) => shell.audioPrepareResume(jobId, active.stagingId, scope));
        setRecoveries((items) => [...items.filter((item) => item.stagingId !== recovery.stagingId), recovery]);
      } catch {
        await refresh(shell, scope).catch(() => undefined);
      }
      setBusy(false);
    } finally {
      stopping.current = false;
    }
  };

  const resume = async (item: ShellAudioRecovery) => {
    if (busy) return;
    setBusy(true);
    try {
      await assertCurrentOwner();
      const prepared = await prepareWithCancellation((jobId) => shell.audioPrepareResume(jobId, item.stagingId, scope));
      setBusy(false);
      await upload(prepared);
    } catch {
      setBusy(false);
      setError("一時音声を変換できませんでした。元の音声は残しています。");
    }
  };

  const discard = async (item: ShellAudioRecovery) => {
    if (busy) return;
    try {
      await assertCurrentOwner();
      await shell.audioRecoveryDiscard(item.stagingId, scope);
      setRecoveries((items) => items.filter((known) => known.stagingId !== item.stagingId));
    } catch {
      setError("一時音声を消せませんでした。ログインが変わっている場合は画面を読み直してください。");
    }
  };

  return <section className="es-start" aria-label="このMacの音声" aria-busy={busy}>
    <div style={ROW}>
      <button type="button" className="es-btn es-btn--outline es-btn--sm" disabled={busy || recording !== null} onClick={() => void pick()}>Macから音声を選ぶ</button>
      <button type="button" className={recording ? "es-btn es-btn--primary es-btn--sm" : "es-btn es-btn--outline es-btn--sm"} disabled={busy} onClick={() => void (recording ? stopMic() : startMic())}>{recording ? "Mac録音を止めて取り込む" : "Macのマイクで録音"}</button>
      {busy && <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={() => controller.current?.abort()}>中止</button>}
      <span className="es-note">AIFC・AIFF・CAF等はこのMacで実際にWAVへ変換してから送ります</span>
    </div>
    {recoveries.map((item) => <div key={item.stagingId} style={ROW} role="group" aria-label="このMacの一時音声">
      <span className="es-note">未完了の一時音声がこのMacに残っています（{item.files.length || "変換前"} 本）</span>
      <button type="button" className="es-btn es-btn--outline es-btn--sm" disabled={busy} onClick={() => void resume(item)}>再開・救出</button>
      <button type="button" className="es-btn es-btn--quiet es-btn--sm" disabled={busy} onClick={() => void discard(item)}>破棄</button>
    </div>)}
    {recording && <p role="status">このMacで録音中です</p>}
    {progress && <p role="status" aria-live="polite">{progress}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
