"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PageKind, PageSummary, StepStatus } from "@niho/editor-store";
import { TabBar, type PageTabMoveTarget } from "niho-docs-ui/page/TabBar";
import { ShellSheet } from "niho-docs-ui/shell";
import { createTabRequest, deletePageRequest, duplicatePageRequest, moveTabRequest, renameTabRequest } from "@/lib/page-actions-client";
import { tabLabel } from "@/lib/sidebar-items";
import { PAGE_MENU_TEXT, failureText } from "@/lib/use-page-menu";
import { useEditorFrame } from "./EditorFrame";

/** 本文を持つ種類（editor-store の TAB_KINDS の写し。画面は pg を持ち込まないので値を import しない）。 */
const TAB_KINDS: readonly PageKind[] = ["note", "rec", "article"];

/** 帯に出すタブ（`/p/[id]` のサーバーが `resolvePage` の tabs から渡す。本文は持たない）。 */
export type OpenPageTab = { id: string; kind: PageKind; title: string; tabName: string | null; tabPos: number; stepStatus: StepStatus | null };

export const PAGE_TABS_TEXT = {
  addFailed: "タブを足せませんでした",
  renameFailed: "名前を変えられませんでした",
  moveFailed: "別のページへ移せませんでした",
  confirmTab: (label: string) => `タブ「${label}」を削除しますか？`,
  confirmPage: (title: string) => `「${title || "無題"}」を削除しますか？`,
} as const;

const BUSY_STYLE = { opacity: 0.6, pointerEvents: "none" } as const;

/**
 * 本文の上のタブの帯（#308。モック editor-folder-pages-v1 の 2〜3）。docs-ui の TabBar に、通信と枠（一覧）への知らせを足したもの。
 * - ＋: まっさらなタブを足して開く。▾: 名前を変える・複製（まず保存）・並べて開く（デスクトップ）・別のページへ移す（同じフォルダのページ）・削除（確認）。
 * - 一覧の行は枠が持つので、足した・複製した・移したタブは `pageCreated`／`pageRemoved` で知らせる（入れ物の行に集まる。lib/sidebar-items.ts）。
 * - 題名はページの名前で、入れ物と全てのタブで同じ（サーバーが写す）。
 */
export function PageTabs({ page, tabs, saveNow }: { page: Pick<PageSummary, "id" | "kind" | "title" | "parent" | "page">; tabs: readonly OpenPageTab[]; saveNow: () => Promise<boolean> }) {
  const router = useRouter();
  const frame = useEditorFrame();
  const { id } = page;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ busy: boolean; error: string | null } | null>(null);
  const holder = page.page ?? null;
  const others = tabs.filter((tab) => tab.id !== id);
  const label = (tab: OpenPageTab | undefined) => (tab ? tabLabel(tab) : "");

  const run = async (job: () => Promise<void>, failed: string) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await job();
    } catch (error) {
      setNote(failureText(error, failed));
    } finally {
      setBusy(false);
    }
  };

  // 別のページへ移す入れ先: 同じフォルダのページ（入れ物と、入れ物の無いページ）。自分の入れ物は除く
  const loaded = frame.pages ?? [];
  const holderKind = new Map(loaded.map((row) => [row.id, row.kind]));
  const moveTargets: PageTabMoveTarget[] = loaded
    .filter((row) => row.parent === page.parent && row.id !== id && row.id !== holder)
    .filter((row) => row.kind === "page" || (TAB_KINDS.includes(row.kind) && !(row.page && holderKind.get(row.page) === "page")))
    .map((row) => ({ id: row.id, title: row.title }));

  const add = () =>
    run(async () => {
      const created = await createTabRequest(id);
      frame.pageCreated(created.id, page.title, "note", page.parent, created.page ?? holder);
      router.push(`/p/${created.id}`);
    }, PAGE_TABS_TEXT.addFailed);

  const confirmDelete = async () => {
    if (!confirm || confirm.busy) return;
    setConfirm({ busy: true, error: null });
    if (!(await saveNow())) {
      setConfirm({ busy: false, error: PAGE_MENU_TEXT.unsaved("削除") });
      return;
    }
    try {
      await deletePageRequest(id);
    } catch (error) {
      setConfirm({ busy: false, error: failureText(error, PAGE_MENU_TEXT.deleteFailed) });
      return;
    }
    setConfirm(null);
    frame.pageRemoved(id);
    // ほかのタブが残れば入れ物へ（最後に開いたタブに戻る）。最後のタブなら入れ物も消えるのでホームへ
    router.push(others.length > 0 && holder ? `/p/${holder}` : "/");
  };

  return (
    <>
      <TabBar
        tabs={tabs.map((tab) => ({ id: tab.id, label: label(tab), ...(tab.stepStatus === "run" ? { busy: true } : {}) }))}
        currentId={id}
        onOpen={(tabId) => (frame.openPage ? frame.openPage(tabId) : router.push(`/p/${tabId}`))}
        onAdd={add}
        busy={busy}
        actions={{
          onRename: (name) =>
            run(async () => {
              await renameTabRequest(id, name === "" ? null : name);
              router.refresh();
            }, PAGE_TABS_TEXT.renameFailed),
          onDuplicate: () =>
            run(async () => {
              // まず届いていない変更を保存する（複製は保存した本文を写す）。届かなければ複製しない
              if (!(await saveNow())) {
                setNote(PAGE_MENU_TEXT.unsaved("複製"));
                return;
              }
              const copy = await duplicatePageRequest(id);
              frame.pageCreated(copy.id, copy.title, copy.kind, copy.parent, copy.page);
              router.push(`/p/${copy.id}`);
            }, PAGE_MENU_TEXT.duplicateFailed),
          // 並べて開く（設計 §5.5。デスクトップだけ。右は読むだけ）
          ...(frame.narrow ? {} : { onSplit: (otherId: string) => router.replace(`/p/${id}?side=${otherId}`) }),
          moveTargets,
          onMove: (targetId) =>
            run(async () => {
              await moveTabRequest(id, targetId);
              // 一覧の行は入れ物に集まるので、いったん外して新しい入れ物の下に足す（入れ物の無いページへ移したときは入れ物がまだ分からない）
              frame.pageRemoved(id);
              frame.pageCreated(id, page.title, page.kind, page.parent, holderKind.get(targetId) === "page" ? targetId : null);
              router.refresh();
            }, PAGE_TABS_TEXT.moveFailed),
          onDelete: () => setConfirm({ busy: false, error: null }),
        }}
      />
      {note && (
        <p role="alert" className="es-tabbar-note">
          {note}
        </p>
      )}
      {confirm && (
        <ShellSheet label="タブの削除" onClose={() => (confirm.busy ? undefined : setConfirm(null))}>
          <div className="es-sh-hd">
            <h2>{others.length > 0 ? PAGE_TABS_TEXT.confirmTab(label(tabs.find((tab) => tab.id === id))) : PAGE_TABS_TEXT.confirmPage(page.title)}</h2>
          </div>
          <div className="es-sh-body">
            <div className="es-sh-sec">
              <p>ゴミ箱に 30 日残ります。</p>
            </div>
          </div>
          <div className="es-sh-foot">
            {confirm.error && (
              <span role="alert" className="es-sh-note es-sh-left">
                {confirm.error}
              </span>
            )}
            <span className="es-sh-acts">
              <button type="button" className="es-btn es-btn--quiet" data-autofocus="" aria-disabled={confirm.busy || undefined} style={confirm.busy ? BUSY_STYLE : undefined} onClick={() => setConfirm(null)}>
                やめる
              </button>
              <button type="button" className="es-btn es-btn--primary" aria-disabled={confirm.busy || undefined} style={confirm.busy ? BUSY_STYLE : undefined} onClick={() => void confirmDelete()}>
                削除する
              </button>
            </span>
          </div>
        </ShellSheet>
      )}
    </>
  );
}
