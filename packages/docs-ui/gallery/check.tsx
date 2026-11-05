import { useEffect, useState } from "react";
import { SCREENS } from "./screens";

export const CHECK_WIDTHS = [1440, 390, 375, 320] as const;
const HEIGHT = 900;

export type OverflowRow = {
  id: string;
  width: number;
  scrollWidth: number;
  clientWidth: number;
  /** 横にはみ出した px（0 が正常）。documentElement の scrollWidth − clientWidth。 */
  overflow: number;
  /** 画面の中で、横に出ている要素（意図した横スクロール `data-hscroll` を除く）の数。 */
  inner: number;
};

declare global {
  interface Window {
    __overflowReport?: OverflowRow[];
    __overflowDone?: boolean;
  }
}

/** 一覧・レール・公開のシートなど、状態違いの確認（スマホの全画面と、シートの中身の違い）。 */
const VARIANTS: { id: string; widths: readonly number[] }[] = [
  { id: "page:memo?sidebar=1&rail=0", widths: [390, 375, 320] },
  { id: "page:rec?sidebar=1&rail=0", widths: [390, 375, 320] },
  { id: "page:enoden?rail=1", widths: [390, 375, 320] },
  { id: "page:kita?rail=1", widths: [390, 375, 320] },
  { id: "page:rec2?rail=1", widths: [390, 375, 320] },
  { id: "page:j1030?rail=1", widths: [390, 375, 320] },
  { id: "page:rec?rail=0", widths: [1440, 390, 375, 320] },
  // 録音の文字起こし（話者 3 人・直している最中／6 人で色が出そろう・長い名前／時刻なしで再生なし）
  { id: "page:rec?speakers=3&edit=1&rail=0", widths: [1440, 390, 375, 320] },
  { id: "page:rec?speakers=6&rail=0", widths: [1440, 390, 375, 320] },
  { id: "page:rec?time=0&play=0&rail=0", widths: [1440, 390, 375, 320] },
  // 再生している最中（#36 段 3b-2。一時停止のボタン・再生位置のスライダー・時刻のボタン）
  { id: "page:rec?playing=1&rail=0", widths: [1440, 390, 375, 320] },
  // editor-web の「録音から」（#36 段 3b-1。取り込める形式の長い一言）
  { id: "newrec?web=1", widths: [1440, 390, 375, 320] },
  // editor-web の情報パネル（#34 第 3 段。自分だけ・肩書なし・Markdown だけ・ページを削除・言語の一言）
  { id: "page:memo?rail=1&web=1", widths: [1440, 390, 375, 320] },
  { id: "page:rec?rail=1&web=1&note=1", widths: [1440, 390, 375, 320] },
  // フェーズ2: 公開のシート（発信先を選んだ後の足りないもの・条件がそろった・未接続・公開中の更新）
  { id: "sheet:publish?pick=exp", widths: [1440, 390, 375, 320] },
  { id: "sheet:publish?pick=niho", widths: [1440, 390, 375, 320] },
  { id: "sheet:publish?pick=site", widths: [1440, 390, 375, 320] },
  { id: "sheet:publish?pick=site&conn=0", widths: [1440, 390, 375, 320] },
  { id: "sheet:publish?page=enoden&pick=exp", widths: [1440, 390, 375, 320] },
  { id: "sheet:publish?page=gomi", widths: [1440, 390, 375, 320] },
  // 設定（editor-web。2026-11-05 の 3 層: 固有名詞・あなたについて・既定の手順・足した手順。一覧は screens.ts の settings-web）
  { id: "settings-web?terms=1", widths: [1440, 390, 375, 320] },
  { id: "settings-web?about=1", widths: [1440, 390, 375, 320] },
  { id: "settings-web?recipe=tpl-1", widths: [1440, 390, 375, 320] },
  { id: "settings-web?recipe=r-talk", widths: [1440, 390, 375, 320] },
  // 発信先（editor-web。#41。発信先を追加・新しい鍵・URL の編集・鍵の再発行の確認・接続の解除の確認）
  { id: "dest-web?add=1", widths: [1440, 390, 375, 320] },
  { id: "dest-web?key=1", widths: [1440, 390, 375, 320] },
  { id: "site-web?url=1", widths: [1440, 390, 375, 320] },
  { id: "site-web?confirm=key", widths: [1440, 390, 375, 320] },
  { id: "site-web?confirm=disconnect", widths: [1440, 390, 375, 320] },
  { id: "site-web?key=1", widths: [1440, 390, 375, 320] },
  // 公開プレビュー（発信先ごとの見え方）
  { id: "preview:enoden", widths: [1440, 390, 375, 320] },
  { id: "preview:gomi", widths: [1440, 390, 375, 320] },
  { id: "preview:asaichi", widths: [1440, 390, 375, 320] },
  // 設定系ページ（スマホで一覧を全画面で開いた状態・未接続）
  { id: "dest?sidebar=1", widths: [390, 375, 320] },
  { id: "dest?conn=0", widths: [1440, 390, 375, 320] },
  { id: "site?sidebar=1", widths: [390, 375, 320] },
  { id: "account?sidebar=1", widths: [390, 375, 320] },
  { id: "settings?sidebar=1", widths: [390, 375, 320] },
];

function countInner(doc: Document): number {
  const view = doc.defaultView;
  if (!view) return 0;
  const width = doc.documentElement.clientWidth;
  let count = 0;
  for (const el of doc.querySelectorAll<HTMLElement>(".es-root *")) {
    if (el.closest("[data-hscroll]") || el.getClientRects().length === 0) continue;
    const style = view.getComputedStyle(el);
    if (style.visibility === "hidden" || el.closest("[hidden]")) continue;
    const rect = el.getBoundingClientRect();
    // 題名の「…」（text-overflow: ellipsis）は意図した切り詰めなので数えない
    const scrolls = style.textOverflow !== "ellipsis" && /(auto|scroll|hidden|clip)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
    if (rect.right > width + 1 || rect.left < -1 || scrolls) count += 1;
  }
  return count;
}

function measure(frame: HTMLIFrameElement, id: string, width: number): OverflowRow {
  const doc = frame.contentDocument;
  if (!doc) return { id, width, scrollWidth: -1, clientWidth: -1, overflow: -1, inner: -1 };
  const { scrollWidth, clientWidth } = doc.documentElement;
  return { id, width, scrollWidth, clientWidth, overflow: Math.max(0, scrollWidth - clientWidth), inner: countInner(doc) };
}

const settle = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

async function runCheck(stage: HTMLElement, onRow: (row: OverflowRow) => void): Promise<OverflowRow[]> {
  const jobs = [
    ...SCREENS.flatMap((screen) => CHECK_WIDTHS.map((width) => ({ id: screen.id, width }))),
    ...VARIANTS.flatMap((variant) => variant.widths.map((width) => ({ id: variant.id, width }))),
  ];
  const rows: OverflowRow[] = [];
  for (const job of jobs) {
    const frame = document.createElement("iframe");
    frame.title = `${job.id} @${job.width}`;
    frame.style.cssText = `width:${job.width}px;height:${HEIGHT}px;border:0`;
    frame.src = `${window.location.pathname}#/${job.id}`;
    stage.replaceChildren(frame);
    await new Promise<void>((resolve) => {
      frame.addEventListener("load", () => resolve(), { once: true });
    });
    // 画面（.es-root）が描かれるまで待つ（描かれていないまま測ると、はみ出しが 0 に見えてしまう）
    for (let tries = 0; tries < 50 && !frame.contentDocument?.querySelector(".es-root"); tries += 1) await settle(100);
    await settle(250);
    const rendered = Boolean(frame.contentDocument?.querySelector(".es-root"));
    const row = rendered ? measure(frame, job.id, job.width) : { id: job.id, width: job.width, scrollWidth: -1, clientWidth: -1, overflow: -1, inner: -1 };
    rows.push(row);
    onRow(row);
  }
  stage.replaceChildren();
  return rows;
}

/** `#/_check`: 全画面 × 幅 [1440, 390, 375, 320] を iframe で順に開き、横スクロールが出ていないかを表にする。 */
export function Check() {
  const [rows, setRows] = useState<OverflowRow[]>([]);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const stage = document.getElementById("g-stage");
    if (!stage) return;
    window.__overflowReport = [];
    window.__overflowDone = false;
    let cancelled = false;
    void runCheck(stage, (row) => {
      if (cancelled) return;
      window.__overflowReport = [...(window.__overflowReport ?? []), row];
      setRows((current) => [...current, row]);
    }).then(() => {
      if (cancelled) return;
      window.__overflowDone = true;
      setDone(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const bad = rows.filter((row) => row.overflow !== 0 || row.inner !== 0);
  return (
    <div className="g-check">
      <h1>横スクロールの確認</h1>
      <p data-testid="summary" aria-live="polite">
        {done ? (bad.length === 0 ? `すべて OK（${rows.length} 件）` : `はみ出し ${bad.length} 件 / ${rows.length} 件`) : `確認中… ${rows.length} 件`}
      </p>
      <table>
        <thead>
          <tr>
            <th>画面</th>
            <th>幅</th>
            <th>scrollWidth</th>
            <th>clientWidth</th>
            <th>overflow</th>
            <th>inner</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className={row.overflow !== 0 || row.inner !== 0 ? "bad" : undefined}>
              <td>{row.id}</td>
              <td>{row.width}</td>
              <td>{row.scrollWidth}</td>
              <td>{row.clientWidth}</td>
              <td>{row.overflow}</td>
              <td>{row.inner}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div id="g-stage" className="g-stage" aria-hidden="true" />
    </div>
  );
}
