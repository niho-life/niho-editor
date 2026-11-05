import type { PageLang } from "@niho/editor-store";
import type { Editor } from "@tiptap/react";
import type { ReactNode } from "react";
import type { AiBridge } from "./ai-bridge";
import type { RestoredPage } from "./page-actions-client";
import type { SaveStatus } from "./save-status";

/** 本文の文字（情報パネルの文字数のため。開いているあいだだけ読み、変わったら知らせを受ける）。 */
export type PageText = {
  /** 今の本文の文字（題名は含めない。段落の間は改行）。 */
  read: () => string;
  /** 本文が変わったら onChange（入力のたびに呼ぶので、受ける側でまとめる）。返す関数で外す。 */
  subscribe: (onChange: () => void) => () => void;
};

/** 右レールの AI が使う、開いている PageEditor の安定した境界。 */
export type AttachedAi = {
  editor: Editor | null;
  bridge: AiBridge;
  title: string;
  kind: "note" | "rec" | "step" | "article";
  lang: PageLang;
};

/** PageSteps が持つ既存の工程状態を、AI の工程選択へ読み取り専用で共有する。 */
export type AttachedAiStep = {
  id: string;
  label: string;
  hint: string;
  disabledReason: string | null;
};

export type AttachedAiSteps = {
  ownerId: string;
  options: readonly AttachedAiStep[];
  start: (id: string) => Promise<{ ok: boolean; message: string }>;
};

/**
 * 開いているページ（ページの中の PageEditor が枠に登録する。ヘッダーの状態の丸と「…」が使う）。
 * 枠はページの外にあり、保存の状態とエディタはページの中にあるので、この形で橋渡しする。
 */
export type AttachedPage = {
  /** ページの id。まだ作っていない新しいページと、端末の下書きを読み終える前は null（「…」を出さない）。 */
  id: string | null;
  status: SaveStatus;
  /**
   * まだ届いていない変更を今送り、全てサーバーに届いたら true（届かなければ false。その操作は止める）。
   * 開いているあいだは同じ関数（同じ画面かどうかを、id とこの関数で見分ける）。
   */
  flush: () => Promise<boolean>;
  /** 今の本文がもとにしている revision（次の保存の `baseRevision`。版に戻すときにも送る）。作る前は null。 */
  revision: () => number | null;
  /**
   * サーバーで版に戻したページで、エディタを開き直す（題名・本文・revision をその値にし、保存と下書きの部品も作り直す）。
   * 開き直した画面は別の画面として登録し直す（flush が替わる）。
   */
  reopen: (page: RestoredPage) => void;
  /** リンクで共有しているか（ページを開いたときにサーバーが読んだ値か、このあと共有のシートで分かった値）。分からなければ null。 */
  shared: boolean | null;
  /** 共有の状態が分かった・変わった（共有のシートで読んだ・始めた・作り直した・止めた）。 */
  setShared: (shared: boolean) => void;
  /** ページの言語（いま画面に出している値。変えた直後は保存の前でもその値）。 */
  lang: PageLang;
  /**
   * 言語を変える（情報パネル）。題名・本文と同じ自動保存に載せ、待たずに送る（同じ revision・競合の判定・端末の下書き）。
   * 届かなければ（オフライン・ログイン切れ・競合・サーバーの失敗）サーバーが持っている言語に戻し、`langNote` で知らせる。
   */
  setLang: (lang: PageLang) => void;
  /** 言語を保存できなかったときの短い文言（次に言語を変えるまで）。無ければ null。 */
  langNote: string | null;
  /** 任意のリード・カバー。本文には置かず、右のページ設定で編集する。 */
  publicationFields?: ReactNode;
  text: PageText;
  /** パネルから外した写真がカバーなら、カバーも外す（サーバーは外し済み。同じ自動保存に載せる）。 */
  clearCover?: (assetId: string) => void;
  /** 下書き復元前は id が null なので、AI は描画だけして操作を受け付けない。 */
  ai?: AttachedAi;
};

/** 操作の持ち主（ページの id と、その画面の flush）。別のページ・開き直した画面とは別の持ち主になる。 */
export type PageOwner = { id: string; flush: AttachedPage["flush"] };

export function ownerOf(page: AttachedPage | null): PageOwner | null {
  return page && page.id !== null ? { id: page.id, flush: page.flush } : null;
}

export function samePage(a: PageOwner | null, b: PageOwner | null): boolean {
  return a !== null && b !== null && a.id === b.id && a.flush === b.flush;
}
