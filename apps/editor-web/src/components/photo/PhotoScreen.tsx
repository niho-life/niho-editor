"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createCloudPhotoLibrary, type CloudPhotoScope } from "@niho/photo-cloud-library";
import { developSettingsEngineIdentifiers, isEditableDevelopSettings, readDevelopSettings, supportedDevelopSettingsVersions } from "niho-photo-contract";
import {
  BrowserPhotoEditingWorkbench, PhotoEditingDialogHost, PhotoLibraryProvider,
  QueryClient, QueryClientProvider, type PhotoEditingHost,
} from "@/photo-sdk/host-sdk";
import { photoSdkRuntimeAssets } from "@/photo-sdk/runtime-assets";
import { loadPhotoSession, type PhotoSessionResult } from "@/lib/photo-session";
import { PhotoUploadError, photoFileFormat, uploadPhotoFile } from "@/lib/photo-upload";
import { formatPhotoBytes, photoUploadLabel, photoUploadMessage, uploadAllowed, uploadFormatAllowed, type PhotoUploadRow } from "@/lib/photo-view";
import type { PersonalPhotoLibrary, QuotaUsage } from "@niho/photo-library-contract";
import styles from "./photo-screen.module.css";

const runtimeAssets = photoSdkRuntimeAssets();
type PhotoLeaveGuard = (options?: { release?: boolean }) => Promise<boolean>;

export function photoRuntimeReady(library: PersonalPhotoLibrary): boolean {
  const renderer = library.capabilities.renderer;
  return library.capabilities.edits && renderer.sdkVersion === runtimeAssets.sdkVersion &&
    renderer.crateVersion === runtimeAssets.engineCrateVersion && renderer.manifestSha256 === runtimeAssets.manifestSha256 &&
    renderer.settingsVersions.some((v) => supportedDevelopSettingsVersions.includes(v as (typeof supportedDevelopSettingsVersions)[number])) &&
    renderer.engines.some((engine) => developSettingsEngineIdentifiers.includes(engine as (typeof developSettingsEngineIdentifiers)[number]));
}

export function PhotoScreen() {
  const router = useRouter();
  const [result, setResult] = useState<PhotoSessionResult | null>(null);
  const [check, setCheck] = useState(0);
  const [rows, setRows] = useState<PhotoUploadRow[]>([]);
  const [usage, setUsage] = useState<QuotaUsage | null>(null);
  const [logoutError, setLogoutError] = useState(false);
  const routeLeaveGuardRef = useRef<PhotoLeaveGuard | null>(null);
  const scopeRef = useRef<CloudPhotoScope | null>(null);
  const controllersRef = useRef(new Map<string, AbortController>());
  const cancelledGenerationsRef = useRef(new Map<string, number>());
  const ready = result?.kind === "ready" ? result : null;

  const registerRouteLeaveGuard = useCallback((guard: PhotoLeaveGuard | null) => {
    routeLeaveGuardRef.current = guard;
  }, []);

  const leavePhoto = useCallback(async (action: () => void) => {
    try {
      const canLeave = await routeLeaveGuardRef.current?.() ?? true;
      if (canLeave) action();
    } catch {
      // 保存・確認に失敗したときは写真画面にとどめる。
    }
  }, []);

  const logout = useCallback(() => {
    void leavePhoto(() => {
      setLogoutError(false);
      void fetch("/photo/auth/logout", { method: "POST", credentials: "same-origin", cache: "no-store" })
        .then((response) => {
          const destination = new URL(response.url || "/photo/auth/logout", window.location.origin);
          if (!response.ok || destination.origin !== window.location.origin || destination.pathname !== "/photo/auth/login") {
            throw new Error("photo_logout_failed");
          }
          router.replace("/photo/auth/login");
        })
        .catch(() => setLogoutError(true));
    });
  }, [leavePhoto, router]);

  useEffect(() => {
    const controller = new AbortController();
    void loadPhotoSession(controller.signal, (verified) => {
      const before = scopeRef.current;
      if (before && (before.actorId !== verified.userId || before.sessionEpoch !== verified.sessionId)) {
        scopeRef.current = null;
        controllersRef.current.forEach((active) => active.abort());
        controllersRef.current.clear();
        cancelledGenerationsRef.current.clear();
        setRows([]);
        setResult(null);
      }
    }).then((next) => {
      if (controller.signal.aborted) return;
      if (next.kind === "ready") {
        const scope = { actorId: next.session.userId, libraryId: next.library.id, sessionEpoch: next.session.sessionId };
        const before = scopeRef.current;
        if (before && (before.actorId !== scope.actorId || before.libraryId !== scope.libraryId || before.sessionEpoch !== scope.sessionEpoch)) {
          controllersRef.current.forEach((controller) => controller.abort());
          controllersRef.current.clear();
          cancelledGenerationsRef.current.clear();
          setRows([]);
        }
        scopeRef.current = scope;
        setUsage(next.library.usage);
        setResult((current) => current?.kind === "ready" && current.scopeKey === next.scopeKey &&
          current.session.expiresAt === next.session.expiresAt &&
          JSON.stringify(current.library.capabilities) === JSON.stringify(next.library.capabilities) ? current : next);
      } else {
        scopeRef.current = null;
        controllersRef.current.forEach((controller) => controller.abort());
        controllersRef.current.clear();
        cancelledGenerationsRef.current.clear();
        setRows([]);
        setUsage(null);
        setResult(next);
      }
    }).catch(() => { /* a newer check owns the state */ });
    return () => controller.abort();
  }, [check]);

  useEffect(() => {
    const recheck = () => { if (document.visibilityState === "visible") setCheck((value) => value + 1); };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => { window.removeEventListener("focus", recheck); document.removeEventListener("visibilitychange", recheck); };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const delay = Date.parse(ready.session.expiresAt) - Date.now();
    if (delay <= 0) { scopeRef.current = null; return; }
    const timer = setTimeout(() => {
      scopeRef.current = null;
      controllersRef.current.forEach((controller) => controller.abort());
      controllersRef.current.clear();
      cancelledGenerationsRef.current.clear();
      setRows([]);
      setResult({ kind: "login" });
    }, delay);
    return () => clearTimeout(timer);
  }, [ready]);

  useEffect(() => () => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    cancelledGenerationsRef.current.clear();
  }, []);

  const authenticatedFetch = useCallback(async (input: string, init: RequestInit) => {
    const response = await fetch(input, { ...init, credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) {
      scopeRef.current = null;
      setResult({ kind: "login" });
      controllersRef.current.forEach((controller) => controller.abort());
      controllersRef.current.clear();
      cancelledGenerationsRef.current.clear();
      setRows([]);
    }
    return response;
  }, []);

  const session = useMemo(() => {
    if (!ready) return null;
    const scope: CloudPhotoScope = { actorId: ready.session.userId, libraryId: ready.library.id, sessionEpoch: ready.session.sessionId };
    const runtimeReady = photoRuntimeReady(ready.library);
    const cloud = createCloudPhotoLibrary({
      scope, currentScope: () => scopeRef.current, authenticatedFetch,
      runtime: {
        settingsVersions: runtimeReady ? supportedDevelopSettingsVersions : [],
        engines: runtimeReady ? developSettingsEngineIdentifiers : [],
        features: runtimeReady ? ready.library.capabilities.renderer.features : [],
        acceptsRecipe: (settings) => runtimeReady && readDevelopSettings(settings) !== null && isEditableDevelopSettings(settings, { geometry: false }),
        crop: false, mobile: runtimeReady,
        engineManifestUrl: runtimeReady ? runtimeAssets.manifestUrl : null,
      },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    const host: PhotoEditingHost = {
      notifyPhotosChanged() { void queryClient.invalidateQueries(); },
      async saveFile({ blob, fileName }) {
        const url = URL.createObjectURL(blob);
        try {
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = fileName;
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
          return "downloaded";
        } catch { throw new Error("ファイルをダウンロードできませんでした。"); }
        finally { setTimeout(() => URL.revokeObjectURL(url), 60_000); }
      },
      nativeFileSaveAvailable: () => false,
      isNativeViewport: () => false,
      isDesktopApp: () => false,
    };
    return { cloud, queryClient, host, scope, canEdit: runtimeReady };
  }, [ready, authenticatedFetch]);

  useEffect(() => () => { session?.cloud.dispose(); session?.queryClient.clear(); }, [session]);

  const updateRow = useCallback((id: string, patch: Partial<PhotoUploadRow>) => {
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  }, []);

  const start = useCallback((id: string, file: File) => {
    if (!session || !ready || !uploadAllowed(ready.library, usage)) return;
    const format = photoFileFormat(file);
    if (!format || !uploadFormatAllowed(ready.library, file)) {
      updateRow(id, { stage: "failed", message: "この形式は追加できません。" });
      return;
    }
    const controller = new AbortController();
    const cancelledGeneration = cancelledGenerationsRef.current.get(id) ?? 0;
    controllersRef.current.set(id, controller);
    updateRow(id, { controller, stage: "preparing", fraction: null, message: null });
    void uploadPhotoFile({ file, scope: session.scope, currentScope: () => scopeRef.current,
      authenticatedFetch, signal: controller.signal, cancelledGeneration,
      onProgress: (stage, fraction) => updateRow(id, { stage, fraction }),
    }).then(async (outcome) => {
      controllersRef.current.delete(id);
      if (scopeRef.current?.sessionEpoch !== session.scope.sessionEpoch) return;
      updateRow(id, { stage: outcome.kind, fraction: 1, controller: null, mediaState: outcome.photo.media.state });
      void session.queryClient.invalidateQueries();
      try { setUsage(await session.cloud.usage()); } catch { /* use the last confirmed usage */ }
    }).catch((error: unknown) => {
      controllersRef.current.delete(id);
      if (scopeRef.current?.sessionEpoch !== session.scope.sessionEpoch) return;
      if (error instanceof PhotoUploadError && error.confirmedServerCancel) {
        cancelledGenerationsRef.current.set(id, cancelledGeneration + 1);
      }
      updateRow(id, { stage: error instanceof PhotoUploadError && error.reason === "cancelled" ? "cancelled" : "failed", controller: null, message: photoUploadMessage(error) });
      if (error && typeof error === "object" && "status" in error && error.status === 401) {
        scopeRef.current = null; setResult({ kind: "login" });
      }
      void session.queryClient.invalidateQueries();
      void session.cloud.usage().then(setUsage).catch(() => undefined);
    });
  }, [session, ready, usage, authenticatedFetch, updateRow]);

  const addFiles = useCallback((files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const id = crypto.randomUUID();
      setRows((current) => [...current, { id, file, stage: "preparing", fraction: null, message: null, controller: null }]);
      start(id, file);
    }
  }, [start]);

  if (!ready || !session) return <section className={styles.screen} aria-labelledby="photo-heading" aria-live="polite">
    <h1 id="photo-heading">写真</h1>
    <p>{result === null ? "写真ライブラリを確認しています。" : result.kind === "login" ? "写真を開くにはログインを確認してください。" : result.kind === "unavailable" ? "写真サービスを一時的に利用できません。" : "写真ライブラリを確認できませんでした。"}</p>
    {result?.kind === "login" && <a className={styles.loginLink} href="/photo/auth/login">写真にログイン</a>}
    {result !== null && result.kind !== "login" && <button type="button" onClick={() => setCheck((value) => value + 1)}>再試行</button>}
  </section>;

  const allowed = uploadAllowed(ready.library, usage);
  return <section className={styles.screen} aria-labelledby="photo-heading">
    <header className={styles.header}>
      <div><h1 id="photo-heading">写真</h1><p>本人の写真ライブラリ</p></div>
      <div className={styles.headerActions}>
        <button className={styles.backLink} type="button" onClick={() => { void leavePhoto(() => router.push("/")); }}>NIHO editorへ戻る</button>
        <button className={styles.logoutButton} type="button" onClick={logout}>写真からログアウト</button>
      </div>
      {usage && <div className={styles.usage} role="status">使用量 {formatPhotoBytes(usage.usedBytes)} / {formatPhotoBytes(usage.quotaBytes)}<br />予約中 {formatPhotoBytes(usage.reservedBytes)}</div>}
      {usage && <details className={styles.capacityHelp}><summary>容量について</summary><p>上限は5 GB（5,368,709,120 byte、5×1024³）です。上限を超える保存や課金はありません。</p></details>}
    </header>
    {logoutError && <p className={styles.logoutError} role="alert">ログアウトできませんでした。接続を確認してもう一度お試しください。</p>}
    <section className={styles.upload} aria-label="写真の追加">
      <label className={styles.addButton}>
        写真を追加
        <input type="file" multiple accept="image/jpeg,image/png,image/heic,image/heif,image/tiff,.dng,.cr2,.cr3,.nef,.arw,.raf,.orf,.rw2,.pef" disabled={!allowed} onChange={(event) => { addFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
      </label>
      {!allowed && <p role="status">写真の追加は現在利用できません。</p>}
      {usage && usage.availableBytes === 0 && <p role="status">保存容量がいっぱいです。</p>}
      {rows.length > 0 && <ul className={styles.uploadList} aria-label="追加の進捗">{rows.map((row) => <li key={row.id}>
        <span className={styles.fileName}>{row.file.name}</span>
        <span role="status">{photoUploadLabel(row)}</span>
        {row.stage === "uploading" && <progress value={row.fraction ?? 0} max={1} aria-label={`${row.file.name} の送信進捗`} />}
        {row.controller && <button type="button" onClick={() => row.controller?.abort()} aria-label={`${row.file.name} の追加を取り消す`}>取り消す</button>}
        {(row.stage === "failed" || row.stage === "cancelled") && <button type="button" onClick={() => start(row.id, row.file)} disabled={!allowed} aria-label={`${row.file.name} を再試行`}>再試行</button>}
      </li>)}</ul>}
    </section>
    <div className={styles.workbench}>
      <QueryClientProvider client={session.queryClient}>
        <PhotoLibraryProvider library={session.cloud.library} host={session.host}>
          <BrowserPhotoEditingWorkbench
            spotId={ready.library.id} scopeKey={ready.scopeKey} actorId={ready.session.userId}
            canEdit={session.canEdit} mobileEditingAllowed={session.canEdit}
            cloudOriginalsAllowed={false} active openCloudPhotoId={null} onOpenCloudPhotoHandled={() => {}}
            registerRouteLeaveGuard={registerRouteLeaveGuard}
            disableCloudDelete appearance="fill"
          />
          <PhotoEditingDialogHost />
        </PhotoLibraryProvider>
      </QueryClientProvider>
    </div>
  </section>;
}
