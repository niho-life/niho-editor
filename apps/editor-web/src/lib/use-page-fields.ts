"use client";

import { useCallback, useEffect, useState } from "react";
import { formatVariants, parseVariants } from "@niho/docs-core";
import type { EditorSettingsEntityDraft, EditorSettingsTermDraft } from "niho-docs-ui/shell";
import { loadPageFields, savePageFieldsRequest } from "./folder-client";
import { RECORDING_FIELD_LIMITS } from "./page-limits";

/**
 * 録音ページの「この録音について」（docs/architecture/editor-recipes-and-folders.md §3.3）。登場人物・固有名詞・背景を読み、
 * 編集を開いているあいだは打った文字を持つ（旧「フォルダの背景」の欄を録音ページへ移したもの）。
 *
 * - 読むのは録音ページを開いているときだけ（`pageId` が null なら読まない）。
 * - **読み終えるまで編集も保存もさせない**。読む前に編集を開くと、編集画面が空の値で始まり、保存が登場人物・固有名詞を
 *   丸ごと置き換えて既存の値を消す。読めなかったときも空の欄として保存させない（押すと読み直す）。
 * - 誤りやすい表記は打ったままの文字列で持ち、保存のときに配列にする（設定の画面と同じ決まり）。
 * - 背景は登場人物・固有名詞とは別に保存する（欄を離れたとき。変わっていなければ送らない）。
 * - 保存できなければサーバーが持っている値に戻して一言（画面とサーバーを食い違わせない）。
 */

/** 画面が持つ録音の欄（サーバーの `PageFields` を、打ったままの文字列で持つ形にしたもの）。 */
type Drafts = { entities: EditorSettingsEntityDraft[]; terms: EditorSettingsTermDraft[]; background: string };

/** サーバーの値を読んだか（読み終えるまで編集も保存もさせない）。 */
export type PageFieldsLoaded = "loading" | "ready" | "failed";

export type PageFieldsState = Drafts & {
  loaded: PageFieldsLoaded;
  open: boolean;
  busy: boolean;
  note: string | null;
  max: { entities: number; terms: number; backgroundChars: number };
  onOpen: () => void;
  onEntities: (next: EditorSettingsEntityDraft[]) => void;
  onTerms: (next: EditorSettingsTermDraft[]) => void;
  onCancel: () => void;
  onSave: () => void;
  /** 背景を打つ（保存はしない）。 */
  onBackground: (next: string) => void;
  /** 背景を保存する（欄を離れたとき。変わっていなければ何もしない）。 */
  onSaveBackground: () => void;
};

const LOADING_NOTE = "読み込んでいます。少し待ってから、もう一度押してください";
const FAILED_NOTE = "読み込めませんでした。もう一度押すと読み直します";
const SAVE_FAILED_NOTE = "保存できませんでした。もう一度試してください";

type State = {
  /** いま読んでいるページ（変わったら作り直す）。 */
  pageId: string | null;
  loaded: PageFieldsLoaded;
  /** サーバーが持っている値。 */
  saved: Drafts;
  /** 編集しているあいだの値（背景はいつもここで打つ）。 */
  drafts: Drafts;
  open: boolean;
  busy: boolean;
  note: string | null;
};

const EMPTY: Drafts = { entities: [], terms: [], background: "" };

function freshState(pageId: string | null): State {
  return { pageId, loaded: "loading", saved: EMPTY, drafts: EMPTY, open: false, busy: false, note: null };
}

function draftsOf(fields: { entities: EditorSettingsEntityDraft[]; terms: { term: string; reading: string; variants: string[]; note: string }[]; background?: string }): Drafts {
  return {
    entities: fields.entities.map((entity) => ({ ...entity })),
    terms: fields.terms.map((term) => ({ term: term.term, reading: term.reading, variants: formatVariants(term.variants), note: term.note })),
    background: fields.background ?? "",
  };
}

export function usePageFields(pageId: string | null): PageFieldsState {
  const [state, setState] = useState<State>(() => freshState(pageId));
  // ページが変わったら作り直す（描くときに合わせる。effect の中で setState しない）
  if (state.pageId !== pageId) setState(freshState(pageId));
  // 読めなかったあとに押されたら読み直す（数が変わると effect が走り直す）
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (pageId === null) return;
    let alive = true;
    void loadPageFields(pageId)
      .then((read) => {
        if (!alive) return;
        const drafts = draftsOf(read);
        setState((current) => (current.pageId === pageId ? { ...current, loaded: "ready", saved: drafts, drafts, note: null } : current));
      })
      .catch(() => {
        if (!alive) return;
        setState((current) => (current.pageId === pageId ? { ...current, loaded: "failed", note: FAILED_NOTE } : current));
      });
    return () => {
      alive = false;
    };
  }, [pageId, attempt]);

  const onSave = useCallback(() => {
    if (pageId === null) return;
    setState((current) => {
      // 読み終えていない値の上に保存しない（編集を開けないので届かないが、取りこぼしても既存の値を消さない）
      if (current.busy || current.loaded !== "ready") return current;
      const patch = {
        entities: current.drafts.entities.filter((entity) => entity.name.trim() !== ""),
        terms: current.drafts.terms
          .filter((term) => term.term.trim() !== "")
          .map((term) => ({ term: term.term, reading: term.reading, variants: parseVariants(term.variants), note: term.note })),
      };
      void savePageFieldsRequest(pageId, patch)
        .then((fields) => {
          const saved = draftsOf(fields);
          // 打っている途中の背景は残す
          setState((now) => (now.pageId === pageId ? { ...now, saved, drafts: { ...saved, background: now.drafts.background }, open: false, busy: false, note: null } : now));
        })
        .catch(() => {
          setState((now) => (now.pageId === pageId ? { ...now, drafts: { ...now.saved, background: now.drafts.background }, busy: false, note: SAVE_FAILED_NOTE } : now));
        });
      return { ...current, busy: true, note: null };
    });
  }, [pageId]);

  const onSaveBackground = useCallback(() => {
    if (pageId === null) return;
    setState((current) => {
      if (current.loaded !== "ready") return current;
      const background = current.drafts.background.trim();
      if (background === current.saved.background.trim()) return current;
      void savePageFieldsRequest(pageId, { background })
        .then((fields) => {
          const value = fields.background ?? "";
          setState((now) =>
            now.pageId === pageId
              ? {
                  ...now,
                  saved: { ...now.saved, background: value },
                  // 送ったあとに打ち足していなければ、サーバーの値（前後の空白を落とした値）に揃える
                  drafts: now.drafts.background.trim() === background ? { ...now.drafts, background: value } : now.drafts,
                  note: null,
                }
              : now,
          );
        })
        .catch(() => {
          setState((now) => (now.pageId === pageId ? { ...now, drafts: { ...now.drafts, background: now.saved.background }, note: SAVE_FAILED_NOTE } : now));
        });
      return current;
    });
  }, [pageId]);

  const shown = state.open ? state.drafts : state.saved;
  return {
    entities: shown.entities,
    terms: shown.terms,
    background: state.drafts.background,
    loaded: state.loaded,
    open: state.open,
    busy: state.busy,
    note: state.note,
    max: RECORDING_FIELD_LIMITS,
    onOpen: () => {
      if (state.loaded === "ready") {
        setState((current) => ({ ...current, drafts: { ...current.saved, background: current.drafts.background }, open: true, note: null }));
        return;
      }
      if (state.loaded === "failed") {
        setState((current) => ({ ...current, loaded: "loading", note: LOADING_NOTE }));
        setAttempt((count) => count + 1);
        return;
      }
      setState((current) => ({ ...current, note: LOADING_NOTE }));
    },
    onEntities: (next) => setState((current) => ({ ...current, drafts: { ...current.drafts, entities: next } })),
    onTerms: (next) => setState((current) => ({ ...current, drafts: { ...current.drafts, terms: next } })),
    onCancel: () => setState((current) => ({ ...current, drafts: { ...current.saved, background: current.drafts.background }, open: false, note: null })),
    onSave,
    onBackground: (next) => setState((current) => (current.loaded === "ready" ? { ...current, drafts: { ...current.drafts, background: next } } : current)),
    onSaveBackground,
  };
}
