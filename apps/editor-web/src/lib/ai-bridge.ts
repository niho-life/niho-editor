import type { Editor } from "@tiptap/core";
import { replaceBlocks } from "@/editor/doc";
import type { AiPage } from "./ai-client";
import type { Autosave } from "./autosave";
import type { PageSaver } from "./page-save";
import type { PageBody } from "./pages-client";

/**
 * AI の箱（src/components/AiBox.tsx）とページの保存（PageEditor の自動保存・保存の部品）の橋渡し。
 *
 * - 頼む前に、未保存の入力を保存し終えてから、その時点の page id と revision を渡す（保存の状態が悪い・まだ作っていない新しいページは頼めない）。
 * - 採用の結果・競合の応答のページを画面に載せる: 本文を差し替え（履歴に積まない・自動保存を起こさない）、保存の部品の revision を進める。
 *   変換中は確定を待つ。頼んでいる間に入力があった（まだ届いていない変更がある）ときは載せない（その保存が 409 になり、
 *   競合の帯で選べる。自分の文章は失わない）。応答が遅れて届く間に、自分の入力が保存し終わって revision が進んでいたとき
 *   （応答のページが今の保存済みより古い）も載せない（保存し終えた文章を古いページで消さない）。
 */

/** 頼めない理由。`new` まだ作っていない新しいページ・`unavailable` 本文を読めない・下書きを読み終えていない。 */
export type AiBlockedReason = "new" | "conflict" | "offline" | "error" | "signedOut" | "unavailable";

export type AiTarget = { ok: true; pageId: string; revision: number } | { ok: false; reason: AiBlockedReason };

export type AiBridge = {
  /** 未保存の入力を保存し終えてから、頼む先のページと revision。 */
  prepare: () => Promise<AiTarget>;
  /** prepare 後の保存済み本文。revision が一致しないときは null。 */
  saved: (revision: number) => { title: string; blocks: unknown[] } | null;
  /** 返ってきたページを画面に載せる。`saved` は採用でサーバーに保存された（一覧の時刻を進める）。載せたら true。 */
  replace: (page: AiPage, options: { saved: boolean }) => Promise<boolean>;
};

/** 変換の確定を待つ間隔。 */
const COMPOSING_POLL_MS = 100;

/** ページの側の部品（どれも呼んだ時点の値を返す）。 */
export type AiBridgeDeps = {
  editor: () => Editor | null;
  saver: () => PageSaver | null;
  autosave: () => Autosave<PageBody> | null;
  /** 本文を読めていて、端末の下書きを読み終えている。 */
  usable: () => boolean;
  isComposing: () => boolean;
  currentTitle: () => string;
  /** 題名を画面に載せる（返ってきたページの題名が違うとき）。 */
  showTitle: (title: string) => void;
  /** 採用でサーバーに保存された。 */
  onSaved: () => void;
};

/** AiBridge の prepare。 */
export async function prepareAi(deps: AiBridgeDeps): Promise<AiTarget> {
  const autosave = deps.autosave();
  const saver = deps.saver();
  if (!autosave || !saver || !deps.usable()) return { ok: false, reason: "unavailable" };
  const state = await autosave.settle();
  if (state === "stopped") return { ok: false, reason: "conflict" };
  if (state === "offline" || state === "error" || state === "signedOut") return { ok: false, reason: state };
  if (state !== "saved") return { ok: false, reason: "error" };
  if (saver.pageId === null) return { ok: false, reason: "new" };
  return { ok: true, pageId: saver.pageId, revision: saver.revision };
}

/** AiBridge の replace。 */
export async function replaceForAi(deps: AiBridgeDeps, page: AiPage, options: { saved: boolean }): Promise<boolean> {
  if (options.saved) deps.onSaved();
  while (deps.isComposing()) await new Promise((resolve) => setTimeout(resolve, COMPOSING_POLL_MS));
  const editor = deps.editor();
  const saver = deps.saver();
  const autosave = deps.autosave();
  if (!editor || editor.isDestroyed || !saver || !autosave || autosave.hasPending()) return false;
  // 応答のページが、今の保存済みの revision より古い（遅れて届いた 409 のページなど）。載せると保存し終えた入力が消え、revision も戻る
  if (page.revision < saver.revision) return false;
  if (!replaceBlocks(editor, page.blocks)) return false;
  saver.rebase(page.revision, { ...saver.content, title: page.title, blocks: page.blocks });
  if (page.title !== deps.currentTitle()) deps.showTitle(page.title);
  return true;
}
