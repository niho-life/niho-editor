"use client";

import { useEffect, useRef, useState } from "react";
import { shellMoreItems, type ShellHeaderProps, type ShellMenuItem } from "niho-docs-ui/shell";
import { ownerOf, samePage, type AttachedPage, type PageOwner } from "./attached-page";
import { folderExportUrl } from "./folder-client";
import {
  PageActionError,
  deletePageRequest,
  duplicatePageRequest,
  pageExportUrl,
  type DuplicatedPage,
} from "./page-actions-client";

export type { AttachedPage, PageOwner };

/** 単ページと子孫を同じ durable batch 面から選ぶ。 */
const GOOGLE_DOCS_BATCH_ITEM = "export-google-docs-batch";
/** 「フォルダを書き出し（.zip）」（フォルダ＋その中のページの zip）。フォルダのときだけ出す。 */
export const FOLDER_EXPORT_ITEM = "export-folder";
/** 「移動…」（フォルダへ入れる・出す、並び。左の一覧のドラッグのキーボード・スマホの代替）。 */
export const MOVE_ITEM = "move";
/** 「フォルダの背景…」（登場人物・固有名詞）。フォルダのときだけ出す。 */
export const FOLDER_FIELDS_ITEM = "folder-fields";
/** 「ページの情報」（本文の列の右下のポップオーバーを開く）。 */
export const PAGE_INFO_ITEM = "page-info";

/** 「AI の文を灰色で見せる」（この端末の表示の切り替え。src/lib/ai-gray.ts）。 */
export const AI_GRAY_ITEM = "ai-gray";

/** 枠が受け持つ項目（ページの操作ではなく、シートやポップオーバーを開く・表示を切り替える）。 */
export type PageMenuLocalItem = typeof MOVE_ITEM | typeof FOLDER_FIELDS_ITEM | typeof PAGE_INFO_ITEM | typeof AI_GRAY_ITEM;

/** 「…」に足す項目（ページによって出し分ける）。 */
export type PageMenuExtras = {
  /** フォルダ（子を持つ上の段のページ）か。「フォルダを書き出し」「フォルダの背景…」を出す。 */
  folder?: boolean;
  /** 「移動…」を出すか（入れ先が無く上の段にいて、並びも動かせないページでは出さない）。 */
  move?: boolean;
  /** 「ページの情報」を出すか。 */
  pageInfo?: boolean;
  /** 「AI の文を灰色で見せる」の今の値（✓）。undefined なら項目を出さない。 */
  aiGray?: boolean;
};

/**
 * 「…」の項目: リンクで共有・書き出し（.md）・Google ドキュメントへ・[フォルダを書き出し（.zip）]・履歴・複製・[移動…]・
 * [フォルダの背景…]・[ページの情報]・[AI の文を灰色で見せる]・削除。shellMoreItems（Mac も使う）は変えず、ここで足す。
 * shellMoreItems の「書き出し」は .md と Google ドキュメントをまとめた 1 項目だが、項目は入れ子にできないので、
 * ここで 2 つに分ける（「書き出し」は .md、Google ドキュメントは次の項目）。
 * リンクで共有の補足「共有中」は、共有していると分かっているときだけ出す（分からないときは出さない）。
 */
export function pageMenuItems(shared: boolean | null, extras: PageMenuExtras = {}): ShellMenuItem[] {
  return shellMoreItems(shared === true).flatMap((item): ShellMenuItem[] => {
    if (item.id === "export") {
      return [
        { ...item, hint: ".md" },
        { id: GOOGLE_DOCS_BATCH_ITEM, label: "Google ドキュメントへ", icon: item.icon },
        ...(extras.folder ? [{ id: FOLDER_EXPORT_ITEM, label: "フォルダを書き出し", icon: item.icon, hint: ".zip" }] : []),
      ];
    }
    if (item.id === "delete") {
      return [
        ...(extras.move ? [{ id: MOVE_ITEM, label: "移動…", icon: "side" as const }] : []),
        ...(extras.folder ? [{ id: FOLDER_FIELDS_ITEM, label: "フォルダの背景…", icon: "people" as const }] : []),
        ...(extras.pageInfo ? [{ id: PAGE_INFO_ITEM, label: "ページの情報", icon: "info" as const }] : []),
        ...(extras.aiGray !== undefined ? [{ id: AI_GRAY_ITEM, label: "AI の文を灰色で見せる", checked: extras.aiGray }] : []),
        item,
      ];
    }
    return [item];
  });
}

const LOCAL_ITEMS: ReadonlySet<string> = new Set([MOVE_ITEM, FOLDER_FIELDS_ITEM, PAGE_INFO_ITEM, AI_GRAY_ITEM]);


/** 「…」から開くシート（どちらも、まだ届いていない変更を保存してから開く）。 */
export type PageSheet = "share" | "history";

export const PAGE_MENU_TEXT = {
  unsaved: (action: "書き出し" | "複製" | "削除" | "共有" | "履歴") =>
    action === "履歴" ? "履歴を開く前に変更を保存できませんでした" : `${action}の前に変更を保存できませんでした`,
  duplicateFailed: "複製できませんでした",
  deleteFailed: "削除できませんでした",
  published: "公開中のページは、先に公開をやめてください",
  signedOut: "ログインし直してください",
} as const;

type Owner = PageOwner;

type MenuState = {
  /** この状態を持つページ。別のページに替わったら、この状態は使わない（古い操作の結果を新しいページに出さない）。 */
  owner: Owner;
  open: boolean;
  /** 「…」の近くに出す、直前の操作の失敗。 */
  note: string | null;
  /** 削除の確認（busy は削除を送っている間）。 */
  confirm: { busy: boolean; error: string | null } | null;
};

export type PageMenuOptions = {
  page: AttachedPage | null;
  /** 今開いているページ（非同期の操作のあと、まだ同じページかを確かめる。描画を待たずに今の値を返す）。 */
  current: () => AttachedPage | null;
  /** 複製した（`stillOpen` は複製したページをまだ開いているか。違えば移動しない）。 */
  onDuplicated: (copy: DuplicatedPage, stillOpen: boolean) => void;
  /** ゴミ箱へ入れた（`stillOpen` は同上）。 */
  onDeleted: (id: string, stillOpen: boolean) => void;
  /** 保存できたので、そのページのシートを開く（まだ同じページを開いているときだけ呼ぶ）。 */
  openSheet: (sheet: PageSheet, owner: PageOwner) => void;
  /** 「…」のボタンへフォーカスを戻す（項目を選んだあと。削除の確認・シートを閉じたときの戻り先にもなる）。 */
  focusMore: () => void;
  /** 書き出しのリンクを押す（既定は同じ origin の `<a href download>`）。 */
  download?: (url: string) => void;
  /** 保存後、単ページと子孫に共通の durable batch 面へ移動する。 */
  goToGoogleDocsBatch?: (path: string) => void;
  /** このページで足す項目（フォルダ・移動・ページの情報）。 */
  extras?: PageMenuExtras;
  /** 枠が受け持つ項目（移動…・フォルダの背景…・ページの情報）を選んだ（「…」へフォーカスを戻したあとに呼ぶ）。 */
  onLocal?: (item: PageMenuLocalItem) => void;
};

export type PageMenu = {
  /** ShellHeader の `more`。「…」を出さないときは undefined。 */
  more: ShellHeaderProps["more"];
  note: string | null;
  confirm: { busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void } | null;
};

/** 同じ origin の `<a href download>` を押す（本文は fetch で読まない。ファイル名は応答の Content-Disposition）。 */
export function clickDownload(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

/** 今の窓で移動する（接続の案内へ）。 */
function visit(path: string): void {
  window.location.assign(path);
}

/** 操作の失敗の短い文言（ログイン切れ・公開中は理由を言い、それ以外は fallback）。 */
export function failureText(error: unknown, fallback: string): string {
  if (error instanceof PageActionError) {
    if (error.status === 409 && error.code === "published") return PAGE_MENU_TEXT.published;
    if (error.status === 401) return PAGE_MENU_TEXT.signedOut;
  }
  return fallback;
}

/**
 * ヘッダーの「…」（リンクで共有・書き出し・履歴・複製・移動・ページの情報・削除）。どの操作も、まだ届いていない変更を先に保存し（`flush`）、保存できなければ止めて理由を出す。
 * リンクで共有と履歴は、保存できたらシートを開く（シートの中身は use-page-share.ts・use-page-history.ts）。
 * 操作は「…」を開いたときのページの id に対して行い、終わったときに別のページへ移っていたら、その画面には何も出さない・移動しない。
 * 同じページの操作は 1 つずつ（二重に送らない）。削除は確認のあとだけ。
 */
export function usePageMenu(options: PageMenuOptions): PageMenu {
  const [state, setState] = useState<MenuState | null>(null);
  const running = useRef<Owner | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const owner = ownerOf(options.page);
  const view = state && samePage(state.owner, owner) ? state : null;

  const isCurrent = (target: Owner) => samePage(ownerOf(latest.current.current()), target);
  const isRunning = (target: Owner) => samePage(running.current, target);
  const update = (target: Owner, change: (current: MenuState) => MenuState) =>
    setState((current) => change(current && samePage(current.owner, target) ? current : { owner: target, open: false, note: null, confirm: null }));
  // 非同期の操作の結果は、まだ同じページを開いているときだけ出す
  const report = (target: Owner, change: (current: MenuState) => MenuState) => {
    if (isCurrent(target)) update(target, change);
  };

  /** 保存してから act を行う（同じページで 1 つずつ）。保存できなければ止めて理由を出す。 */
  const run = async (target: Owner, action: "書き出し" | "複製" | "共有" | "履歴", act: () => Promise<void>) => {
    if (isRunning(target)) return;
    running.current = target;
    try {
      const saved = await target.flush();
      if (!isCurrent(target)) return;
      if (!saved) {
        report(target, (current) => ({ ...current, note: PAGE_MENU_TEXT.unsaved(action) }));
        return;
      }
      await act();
    } finally {
      if (running.current === target) running.current = null;
    }
  };

  /** 項目を行う。「…」へフォーカスを戻してから（削除の確認・シートを閉じたときの戻り先になる）。 */
  const perform = (item: string) => {
    if (!owner) return;
    const target = owner;
    latest.current.focusMore();
    if (LOCAL_ITEMS.has(item)) {
      update(target, (current) => ({ ...current, open: false, note: null }));
      latest.current.onLocal?.(item as PageMenuLocalItem);
      return;
    }
    if (item === "delete") {
      update(target, (current) => ({ ...current, open: false, note: null, confirm: { busy: false, error: null } }));
      return;
    }
    update(target, (current) => ({ ...current, open: false, note: null }));
    if (item === "export") {
      void run(target, "書き出し", async () => {
        (latest.current.download ?? clickDownload)(pageExportUrl(target.id));
      });
    } else if (item === FOLDER_EXPORT_ITEM) {
      // フォルダの書き出しも、まだ届いていない本文の変更を先に保存してから始める（保存できなければ止めて理由を出す）。
      // 保存前に始めると、サーバーが読む古い本文が「背景情報.md」に入る
      void run(target, "書き出し", async () => {
        (latest.current.download ?? clickDownload)(folderExportUrl(target.id));
      });
    } else if (item === GOOGLE_DOCS_BATCH_ITEM) {
      void run(target, "書き出し", async () => {
        (latest.current.goToGoogleDocsBatch ?? visit)(`/google-docs/batch/${encodeURIComponent(target.id)}`);
      });
    } else if (item === "share" || item === "history") {
      const sheet: PageSheet = item;
      void run(target, sheet === "share" ? "共有" : "履歴", async () => latest.current.openSheet(sheet, target));
    } else if (item === "duplicate") {
      void run(target, "複製", async () => {
        let copy: DuplicatedPage;
        try {
          copy = await duplicatePageRequest(target.id);
        } catch (error) {
          report(target, (current) => ({ ...current, note: failureText(error, PAGE_MENU_TEXT.duplicateFailed) }));
          return;
        }
        // 複製はできている（一覧には載せる）。移動するのは、まだ元のページを開いているときだけ
        latest.current.onDuplicated(copy, isCurrent(target));
      });
    }
  };

  const confirmDelete = async (target: Owner) => {
    if (isRunning(target)) return;
    running.current = target;
    const fail = (error: string) => report(target, (current) => ({ ...current, confirm: current.confirm && { busy: false, error } }));
    try {
      update(target, (current) => ({ ...current, confirm: { busy: true, error: null } }));
      const saved = await target.flush();
      if (!isCurrent(target)) return;
      if (!saved) {
        fail(PAGE_MENU_TEXT.unsaved("削除"));
        return;
      }
      try {
        await deletePageRequest(target.id);
      } catch (error) {
        // 一覧もページもそのまま。確認のダイアログに理由を出す（閉じない）
        fail(failureText(error, PAGE_MENU_TEXT.deleteFailed));
        return;
      }
      const stillOpen = isCurrent(target);
      if (stillOpen) update(target, (current) => ({ ...current, confirm: null }));
      latest.current.onDeleted(target.id, stillOpen);
    } finally {
      if (running.current === target) running.current = null;
    }
  };

  return {
    more: owner
      ? {
          open: view?.open ?? false,
          items: pageMenuItems(options.page?.shared ?? null, options.extras),
          onToggle: () => update(owner, (current) => ({ ...current, open: !current.open, note: current.open ? current.note : null })),
          onClose: () => update(owner, (current) => ({ ...current, open: false })),
          onSelect: (item) => perform(item),
        }
      : undefined,
    note: view?.note ?? null,
    confirm:
      owner && view?.confirm
        ? {
            ...view.confirm,
            onConfirm: () => void confirmDelete(owner),
            // 送っている間は閉じない（閉じても削除は止まらないので、結果が出るまで待つ）
            onCancel: () => {
              if (!isRunning(owner)) update(owner, (current) => ({ ...current, confirm: null }));
            },
          }
        : null,
  };
}
