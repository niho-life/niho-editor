"use client";

import { useEffect, useRef, useState } from "react";
import { ShellSidePane } from "niho-docs-ui/shell";
import { useAiGray } from "@/lib/ai-gray";
import { PageRequestError, readPageRequest, type ConflictPage } from "@/lib/pages-client";
import { ReadOnlyBody } from "./ReadOnlyBody";

/** タブへ戻ったときの読み直しを、続けて来た合図（visibilitychange と focus）でまとめる間隔。 */
const REFRESH_GAP_MS = 1000;

type SideState = { status: "loading" } | { status: "ready"; page: ConflictPage } | { status: "missing" } | { status: "error" };

export const SIDE_PAGE_TEXT = {
  loading: "読み込んでいます…",
  missing: "このページは開けません。ゴミ箱に入れたか、見られないページです。",
  error: "読み込めませんでした。",
  retry: "もう一度",
} as const;

/**
 * 右に並べたページ（設計 §5.5。読むだけ）。既存の `GET /api/pages/{id}` で読み、同じ schema の読み取り専用の本文で描く。
 * 題名は本文の先頭に 1 か所（ShellSidePane）。書式の帯・保存・公開は持たない。
 * - タブへ戻ったとき（visibilitychange・focus）と、refresh が増えたとき（AI がこのページを書き換えた）に読み直す。
 *   読み直しの間も今の本文は出したままで、版（revision）が同じなら描き直さない（スクロールの位置を保つ）。
 * - 読めない（404・403）は「開けません」、通信の失敗は「もう一度」。読み直しの失敗では、出している本文を消さない。
 * 呼ぶ側は id ごとに key を替えて作り直す（別のページの本文を一瞬でも出さない）。
 */
export function SidePage({ id, refresh = 0, onSwap, onClose }: { id: string; refresh?: number; onSwap: () => void; onClose: () => void }) {
  const [state, setState] = useState<SideState>({ status: "loading" });
  const [tick, setTick] = useState(0);
  const lastRead = useRef(0);
  const aiGray = useAiGray();

  useEffect(() => {
    const again = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRead.current < REFRESH_GAP_MS) return;
      lastRead.current = now;
      setTick((count) => count + 1);
    };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("focus", again);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    lastRead.current = Date.now();
    readPageRequest(id).then(
      (page) => {
        if (!alive) return;
        setState((current) => (current.status === "ready" && current.page.revision === page.revision && current.page.title === page.title ? current : { status: "ready", page }));
      },
      (error: unknown) => {
        if (!alive) return;
        const missing = error instanceof PageRequestError && (error.status === 404 || error.status === 403);
        setState((current) => (missing ? { status: "missing" } : current.status === "ready" ? current : { status: "error" }));
      },
    );
    return () => {
      alive = false;
    };
  }, [id, refresh, tick]);

  return (
    <ShellSidePane pageId={id} title={state.status === "ready" ? state.page.title : undefined} onSwap={onSwap} onClose={onClose}>
      {state.status === "loading" && (
        <div className="es-side-note">
          <p role="status">{SIDE_PAGE_TEXT.loading}</p>
        </div>
      )}
      {state.status === "missing" && (
        <div className="es-side-note">
          <p role="alert">{SIDE_PAGE_TEXT.missing}</p>
        </div>
      )}
      {state.status === "error" && (
        <div className="es-side-note">
          <p role="alert">{SIDE_PAGE_TEXT.error}</p>
          <button
            type="button"
            className="es-btn es-btn--outline es-btn--sm"
            onClick={() => {
              setState({ status: "loading" });
              setTick((count) => count + 1);
            }}
          >
            {SIDE_PAGE_TEXT.retry}
          </button>
        </div>
      )}
      {state.status === "ready" && (
        // be--flush: 題名と本文の左端を揃える。be--ai-plain: AI の文を灰色にしない（「…」の切り替え。メインと同じ）。es-body: 本文の文字の大きさ（メインと同じ）
        <ReadOnlyBody blocks={state.page.blocks} label="右のページの本文" className={aiGray ? "be be--flush es-body" : "be be--flush be--ai-plain es-body"} />
      )}
    </ShellSidePane>
  );
}
