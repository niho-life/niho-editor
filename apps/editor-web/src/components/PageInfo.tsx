"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { PageSummary } from "@niho/editor-store";
import { ShellPageInfo } from "niho-docs-ui/shell";
import type { PageText } from "@/lib/attached-page";
import { countLabel, countText, pageInfoRows, type TextCounts } from "@/lib/page-info";

/** 本文を数え直すまでの待ち（打っているあいだは数えない）。 */
export const COUNT_DELAY_MS = 300;

type CountStore = { subscribe: (onChange: () => void) => () => void; get: () => TextCounts | null };

/** 本文の数（変わったら少し待ってから数え直す）。 */
function countStore(text: PageText | null): CountStore {
  let counts: TextCounts | null = null;
  return {
    get: () => {
      if (!text) return null;
      counts ??= countText(text.read());
      return counts;
    },
    subscribe: (onChange) => {
      if (!text) return () => undefined;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = text.subscribe(() => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          counts = countText(text.read());
          onChange();
        }, COUNT_DELAY_MS);
      });
      return () => {
        if (timer !== null) clearTimeout(timer);
        unsubscribe();
      };
    },
  };
}

const noCounts = () => null;

/** 右下のボタンに出す数。ja は「1,240 字」、en は「1,180 words」。数える前は「… 字」。 */
export function countButtonLabel(counts: TextCounts | null, lang: PageSummary["lang"]): string {
  if (!counts) return lang === "en" ? "… words" : "… 字";
  return lang === "en" ? countLabel(counts, "en") : `${countLabel(counts, "ja")} 字`;
}

export type PageInfoProps = {
  /** 一覧の行（作成・更新・種類。言語は、ページを読み込み終える前だけこれを使う）。 */
  summary: PageSummary;
  /** 本文（下書きを読み終えるまでは null）。 */
  text: PageText | null;
  /** いまの言語（開いているページの値。読み込み中は summary の値）。 */
  lang: PageSummary["lang"];
  /** 録音の長さ（秒。録音ページでない・分からなければ null）。 */
  recordingSec: number | null;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** ⓘ（容量について）を押した。 */
  onInfo: () => void;
};

/**
 * 本文の列の右下の小さな文字数と、押すと出るページの情報（作成・更新・録音・文字数）。説明（容量）は ⓘ のシートだけ。
 */
export function PageInfo({ summary, text, lang, recordingSec, open, onToggle, onClose, onInfo }: PageInfoProps) {
  const store = useMemo(() => countStore(text), [text]);
  const counts = useSyncExternalStore(store.subscribe, store.get, noCounts);
  return (
    <ShellPageInfo
      count={countButtonLabel(counts, lang)}
      rows={pageInfoRows({ kind: summary.kind, lang, createdAt: summary.createdAt, updatedAt: summary.updatedAt, recordingSec, counts })}
      open={open}
      onToggle={onToggle}
      onClose={onClose}
      info={{ label: "容量について", onOpen: onInfo }}
    />
  );
}
