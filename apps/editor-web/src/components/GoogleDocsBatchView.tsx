"use client";

import "niho-ui/styles/tokens.css";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { googleDocsConnectPath } from "@/lib/google-docs-paths";
import styles from "./GoogleDocsBatchView.module.css";

type Options = { includeBackground: boolean; includeTranscript: boolean };
type Omission = { reason: string; count: number };
type PreviewPage = {
  pageId: string; title: string; revision: number; depth: number; exportable: boolean;
  payloadBytes: number; omissions: Omission[]; problem: string | null;
};
type Preview = { rootPageId: string; options: Options; pages: PreviewPage[]; totalBytes: number; canStart: boolean };
type BatchItem = {
  ordinal: number; pageId: string; pageRevision: number; title: string; status: string; omissions: Omission[];
  sent: boolean; documentId: string | null; url: string | null; retryable: boolean; errorCode: string | null;
};
type Batch = {
  job: {
    id: string; rootPageId: string; operationId: string; status: string; options: Options; nextOrdinal: number;
    errorCode: string | null; expiresAt: string; createdAt: string; cancelledAt: string | null; completedAt: string | null;
  };
  items: BatchItem[];
  inflightMayComplete?: boolean;
  revokePending?: boolean;
};

const ACTIVE = new Set(["prepared", "queued", "running", "cancelling"]);
const STATUS: Readonly<Record<string, string>> = {
  prepared: "開始準備中", queued: "待機中", running: "書き出し中", pending: "作成結果を確認中",
  completed: "完了", failed: "停止", cancelling: "取消処理中", cancelled: "取消済み", expired: "期限切れ",
};
const OMIT: Readonly<Record<string, string>> = {
  image_omitted: "画像", recording_block_omitted: "録音ブロック", original_audio_omitted: "原音", background_not_selected: "背景情報（未選択）",
  transcript_not_selected: "文字起こし（未選択）", horizontal_rule_omitted: "区切り線", unsupported_block: "変換できないブロック",
  private_link_removed: "非公開またはtoken付きリンク",
};
const ERRORS: Readonly<Record<string, string>> = {
  unauthorized: "ログインし直してください。",
  forbidden: "この画面からは操作できません。画面を読み直してください。",
  not_found: "対象のページまたは書き出しが見つかりません。",
  bad_request: "送信内容を確認できませんでした。画面を読み直してください。",
  unavailable: "いまは開始できません。少し待ってから、もう一度お試しください。",
  google_docs_unavailable: "Google ドキュメントへの書き出しは、まだ使えません。",
  grant_not_registered: "開始準備を確認できませんでした。同じ内容のまま、もう一度開始してください。",
  drive_not_connected: "Google ドライブへ接続してください。",
  drive_connection_changed: "Google ドライブの接続が変わったため停止しました。",
  google_account_changed: "Google アカウントが変わったため停止しました。",
  editor_connection_changed: "editorの接続が変わったため停止しました。",
  grant_revoked: "書き出しの許可が取り消されました。",
  grant_expired: "書き出しの有効期限が切れました。",
  revision_conflict: "別の画面でページが更新されました。ページへ戻って保存内容を確認してください。",
  operation_conflict: "開始内容が変わりました。画面を読み直してください。",
  payload_too_large: "選んだページの合計が32 MiBを超えています。",
  source_too_large: "ページの元データが大きすぎるため書き出せません。",
  state_conflict: "現在の状態ではこの操作を行えません。",
  page_deleted: "書き出し元のページが削除されたため停止しました。",
  expired: "書き出しの保持期限が切れました。",
  payload_unavailable: "保存した書き出し内容を読めないため停止しました。",
  payload_mismatch: "保存した書き出し内容を検証できないため停止しました。",
  export_unknown: "作成要求の結果を確認しています。同じ文書を重複作成しません。",
  status_unknown: "作成結果を確認できませんでした。自動で再確認します。",
  receipt_pending: "作成結果の確定を待っています。",
  receipt_retryable: "同じ文書IDで安全に再試行します。",
  receipt_not_found: "作成結果の登録を引き続き確認しています。",
  lease_expired: "中断した処理を同じ文書IDで再開しています。",
  too_many_pages: "一度に書き出せるのは200ページまでです。",
  invalid_selection: "ページの場所または選択内容が変わりました。画面を読み直してください。",
  empty: "書き出せる本文がありません。",
  unsupported_markdown: "Google ドキュメントへ変換できない構造があります。",
};
const PROBLEMS: Readonly<Record<string, string>> = {
  empty: "書き出せる本文がありません",
  unsupported_markdown: "変換できない構造があります",
  payload_too_large: "このページが4 MiBまたは100万文字を超えています",
  source_too_large: "このページの元データが32 MiBを超えています",
};

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json().catch(() => ({}));
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function errorText(code: unknown): string {
  return typeof code === "string" ? (ERRORS[code] ?? "処理できませんでした。少し待ってから、もう一度お試しください。") : ERRORS.unavailable!;
}
function selectedFingerprint(rootPageId: string, options: Options, pages: PreviewPage[]): string {
  return JSON.stringify({ rootPageId, options, pages: pages.map((page) => [page.pageId, page.revision]) });
}
async function fetchLatestBatch(rootPageId: string): Promise<Batch | null> {
  const response = await fetch(`/api/google-docs/batches/root/${encodeURIComponent(rootPageId)}`, { cache: "no-store" });
  if (response.status === 404) return null;
  const body = await responseJson(response);
  if (!response.ok) throw new Error(String(body.error ?? "unavailable"));
  return body as unknown as Batch;
}
async function fetchBatchPreview(rootPageId: string, options: Options): Promise<Preview> {
  const response = await fetch("/api/google-docs/batches/preview", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rootPageId, options }),
  });
  const body = await responseJson(response);
  if (!response.ok) throw new Error(String(body.error ?? "unavailable"));
  return body as unknown as Preview;
}

export function GoogleDocsBatchView({ rootPageId }: { rootPageId: string }) {
  const [options, setOptions] = useState<Options>({ includeBackground: false, includeTranscript: false });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [accepted, setAccepted] = useState(false);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionNeeded, setConnectionNeeded] = useState(false);
  const [inflight, setInflight] = useState(false);
  const operation = useRef<{ fingerprint: string; id: string } | null>(null);

  const loadLatest = useCallback(async () => {
    const next = await fetchLatestBatch(rootPageId);
    if (next) setBatch(next);
    return next;
  }, [rootPageId]);

  useEffect(() => {
    let live = true;
    Promise.allSettled([fetchBatchPreview(rootPageId, options), fetchLatestBatch(rootPageId)]).then((results) => {
      if (!live) return;
      const previewResult = results[0];
      const latestResult = results[1];
      if (previewResult.status === "fulfilled") {
        const next = previewResult.value;
        setPreview(next);
        setSelected((current) => {
          const kept = new Set(next.pages.filter((page) => page.exportable && (current.size === 0 || current.has(page.pageId))).map((page) => page.pageId));
          return kept.size > 0 ? kept : new Set(next.pages.filter((page) => page.exportable).map((page) => page.pageId));
        });
        setAccepted(false);
      }
      if (latestResult.status === "fulfilled" && latestResult.value) setBatch(latestResult.value);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      setError(failed ? errorText(failed.reason instanceof Error ? failed.reason.message : "unavailable") : null);
    });
    return () => { live = false; };
  }, [rootPageId, options]);

  const pollingJobId = batch?.job.id ?? null;
  const pollingJobStatus = batch?.job.status ?? null;
  useEffect(() => {
    if (!pollingJobId || !pollingJobStatus || !ACTIVE.has(pollingJobStatus)) return;
    const timer = window.setInterval(() => {
      void fetch(`/api/google-docs/batches/${encodeURIComponent(pollingJobId)}`, { cache: "no-store" })
        .then(async (response) => {
          const body = await responseJson(response);
          if (response.ok) setBatch(body as unknown as Batch);
        });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [pollingJobId, pollingJobStatus]);

  const chosen = useMemo(() => preview?.pages.filter((page) => page.exportable && selected.has(page.pageId)) ?? [], [preview, selected]);
  const chosenBytes = chosen.reduce((sum, page) => sum + page.payloadBytes, 0);

  async function sendStart(input: { operationId: string; options: Options; pages: Array<{ pageId: string; expectedRevision: number }> }) {
    setBusy(true); setError(null); setConnectionNeeded(false);
    try {
      const response = await fetch("/api/google-docs/batches", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootPageId, operationId: input.operationId, selections: input.pages, options: input.options }),
      });
      const body = await responseJson(response);
      if (!response.ok) throw new Error(String(body.error ?? "unavailable"));
      setBatch(body as unknown as Batch);
      operation.current = null;
    } catch (thrown) {
      const recovered = await loadLatest().catch(() => null);
      if (recovered?.job.operationId === input.operationId) operation.current = null;
      const code = thrown instanceof Error ? thrown.message : "unavailable";
      setConnectionNeeded(code === "drive_not_connected");
      setError(errorText(code));
    } finally { setBusy(false); }
  }

  async function start() {
    if (!preview || chosen.length === 0 || !accepted) return;
    const fingerprint = selectedFingerprint(rootPageId, options, chosen);
    if (!operation.current || operation.current.fingerprint !== fingerprint) operation.current = { fingerprint, id: crypto.randomUUID() };
    await sendStart({ operationId: operation.current.id, options, pages: chosen.map((page) => ({ pageId: page.pageId, expectedRevision: page.revision })) });
  }

  async function resumePrepared() {
    if (!batch || batch.job.status !== "prepared") return;
    await sendStart({
      operationId: batch.job.operationId, options: batch.job.options,
      pages: batch.items.map((item) => ({ pageId: item.pageId, expectedRevision: item.pageRevision })),
    });
  }

  async function mutate(path: string, init: RequestInit) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(path, init);
      const body = await responseJson(response);
      if (!response.ok) throw new Error(String(body.error ?? "unavailable"));
      const next = body as unknown as Batch;
      setBatch(next);
      setInflight(next.inflightMayComplete === true);
      if (next.revokePending && typeof body.error === "string") setError(errorText(body.error));
    } catch (thrown) { setError(errorText(thrown instanceof Error ? thrown.message : "unavailable")); }
    finally { setBusy(false); }
  }

  return (
    <main className={styles.page}>
      <Link className={styles.back} href={`/p/${encodeURIComponent(rootPageId)}`}>← ページへ戻る</Link>
      <h1 className={styles.heading}>Google ドキュメントへ書き出す</h1>
      <p className={styles.lead}>選んだ各ページを、表示順のまま1ページずつ別のGoogleドキュメントにします。元のページや原音は変更しません。</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {(connectionNeeded || batch?.job.errorCode === "drive_not_connected") && <p><Link className={styles.back} href={googleDocsConnectPath(`/google-docs/batch/${rootPageId}`)}>Google ドライブへ接続する</Link></p>}

      <section className={styles.card} aria-labelledby="batch-options">
        <h2 id="batch-options">含める内容</h2>
        <fieldset className={styles.options} aria-labelledby="batch-options" disabled={busy || (batch !== null && ACTIVE.has(batch.job.status))}>
          <label className={styles.check}><input type="checkbox" checked={options.includeBackground} onChange={(event) => setOptions((value) => ({ ...value, includeBackground: event.target.checked }))} /><span>背景情報を含める<br /><span className={styles.muted}>ページに保存済みの背景テキストだけを追加します。</span></span></label>
          <label className={styles.check}><input type="checkbox" checked={options.includeTranscript} onChange={(event) => setOptions((value) => ({ ...value, includeTranscript: event.target.checked }))} /><span>文字起こしを含める<br /><span className={styles.muted}>保存済みの文字起こしテキストだけを追加します。原音は送りません。</span></span></label>
        </fieldset>
      </section>

      <section className={styles.card} aria-labelledby="batch-pages">
        <h2 id="batch-pages">ページと書き出す順序</h2>
        {!preview && !error && <p aria-live="polite">確認しています…</p>}
        {preview && <>
          <div className={styles.summary}><span>{chosen.length} / {preview.pages.length}ページ</span><span>{chosenBytes.toLocaleString("ja-JP")} bytes</span></div>
          <ol className={styles.list}>
            {preview.pages.map((page) => <li className={styles.item} key={page.pageId}>
              <label className={styles.check}>
                <span className={styles.depth} aria-hidden="true">{"›".repeat(page.depth)}</span>
                <input type="checkbox" disabled={!page.exportable || busy || (batch !== null && ACTIVE.has(batch.job.status))} checked={selected.has(page.pageId)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(page.pageId); else next.delete(page.pageId); setAccepted(false); return next; })} />
                <span className={styles.itemTitle}>{page.title || "無題のページ"}{!page.exportable && <><br /><span className={styles.error}>{page.problem ? (PROBLEMS[page.problem] ?? "このページは書き出せません") : "このページは書き出せません"}</span></>}</span>
              </label>
              {page.omissions.length > 0 && <ul className={styles.omissions}>{page.omissions.map((omission) => <li key={omission.reason}>{OMIT[omission.reason] ?? "省略する内容"}: {omission.count}件</li>)}</ul>}
            </li>)}
          </ol>
          <label className={styles.check}><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /><span>上の順序と省略される内容を確認しました</span></label>
          <div className={styles.actions}><button className={styles.primary} type="button" disabled={busy || !accepted || chosen.length === 0 || chosenBytes > 32 * 1024 * 1024 || (batch !== null && ACTIVE.has(batch.job.status))} onClick={() => void start()}>書き出しを開始</button></div>
        </>}
      </section>

      {batch && <section className={styles.card} aria-labelledby="batch-progress" aria-live="polite">
        <h2 id="batch-progress">進み具合</h2>
        <p>{STATUS[batch.job.status] ?? "確認中"} — {batch.items.filter((item) => item.status === "completed").length} / {batch.items.length}件完了</p>
        {batch.job.errorCode && <p className={styles.error}>{errorText(batch.job.errorCode)}</p>}
        {batch.job.status === "prepared" && <p className={styles.notice}>選んだ版と内容は保存済みです。同じ書き出しの開始準備を再開できます。</p>}
        {(inflight || batch.job.status === "cancelling") && <p className={styles.notice}>取消時に処理中だった1件は完成することがあります。結果だけを引き続き確認します。</p>}
        <ol className={styles.list}>
          {batch.items.map((item) => <li className={styles.item} key={item.ordinal}>
            <div className={styles.itemHead}><span className={styles.itemTitle}>{item.title || `ページ ${item.ordinal + 1}`}</span><span className={styles.status}>{STATUS[item.status] ?? item.status}</span></div>
            {item.url && <p><a className={styles.document} href={item.url} target="_blank" rel="noopener noreferrer">できた文書を開く</a></p>}
            {item.errorCode && <p className={styles.error}>{errorText(item.errorCode)}</p>}
            {item.status === "failed" && item.retryable && <button className={styles.secondary} type="button" disabled={busy} onClick={() => void mutate(`/api/google-docs/batches/${encodeURIComponent(batch.job.id)}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ordinal: item.ordinal }) })}>この文書だけ再試行</button>}
          </li>)}
        </ol>
        <div className={styles.actions}>
          {batch.job.status === "prepared" && <button className={styles.primary} type="button" disabled={busy} onClick={() => void resumePrepared()}>開始準備を再開</button>}
          {["prepared", "queued", "running"].includes(batch.job.status) && <button className={styles.danger} type="button" disabled={busy} onClick={() => void mutate(`/api/google-docs/batches/${encodeURIComponent(batch.job.id)}`, { method: "DELETE" })}>{batch.job.status === "prepared" ? "準備を取り消す" : "残りを取り消す"}</button>}
          {batch.revokePending && <button className={styles.secondary} type="button" disabled={busy} onClick={() => void mutate(`/api/google-docs/batches/${encodeURIComponent(batch.job.id)}`, { method: "DELETE" })}>取消の接続処理を再試行</button>}
        </div>
      </section>}
    </main>
  );
}
