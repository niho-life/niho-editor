"use client";

import { useEffect, useRef, useState } from "react";
import type { AttachedPage } from "./attached-page";
import { deletePageRequest } from "./page-actions-client";
import { PAGE_MENU_TEXT, failureText } from "./use-page-menu";

type RowDeleteState = { id: string; title: string; busy: boolean; error: string | null };

/** 確認のシート（EditorFrame の DeleteConfirm）に渡す形。 */
export type RowDeleteConfirm = { id: string; title: string; busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void };

/**
 * 左の一覧の行の「…」→「削除」（オーナー決定 2026-11-06）。確認はヘッダーの「…」の削除と同じシート（ゴミ箱に 30 日）。
 * 開いているページがその行のページ、またはその子孫（フォルダを消すと中のページごとゴミ箱に入る）なら、
 * 先にまだ届いていない変更を送る（`flush`。届かなければ止めて理由を出す）。
 * 失敗はシートの中に出して閉じない。送っている間は閉じず、2 回目を送らない。消せたら閉じて `onDeleted(id)`。
 */
export function useRowDelete({
  current,
  inTree,
  onDeleted,
}: {
  current: () => AttachedPage | null;
  /** `id` のページが、`root` のページ自身か、その子孫か。 */
  inTree: (id: string, root: string) => boolean;
  onDeleted: (id: string) => void;
}) {
  const [state, setState] = useState<RowDeleteState | null>(null);
  const running = useRef(false);
  const latest = useRef({ inTree, onDeleted });
  useEffect(() => {
    latest.current = { inTree, onDeleted };
  });

  const open = (id: string, title: string) => {
    if (running.current) return;
    setState({ id, title, busy: false, error: null });
  };

  const fail = (id: string, error: string) => setState((now) => (now && now.id === id ? { ...now, busy: false, error } : now));

  const confirmDelete = async (id: string) => {
    if (running.current) return;
    running.current = true;
    try {
      setState((now) => (now && now.id === id ? { ...now, busy: true, error: null } : now));
      const page = current();
      if (page && page.id !== null && latest.current.inTree(page.id, id)) {
        if (!(await page.flush())) {
          fail(id, PAGE_MENU_TEXT.unsaved("削除"));
          return;
        }
      }
      try {
        await deletePageRequest(id);
      } catch (error) {
        // 一覧もページもそのまま。確認のシートに理由を出す（閉じない）
        fail(id, failureText(error, PAGE_MENU_TEXT.deleteFailed));
        return;
      }
      setState((now) => (now && now.id === id ? null : now));
      latest.current.onDeleted(id);
    } finally {
      running.current = false;
    }
  };

  const confirm: RowDeleteConfirm | null = state
    ? {
        id: state.id,
        title: state.title,
        busy: state.busy,
        error: state.error,
        onConfirm: () => void confirmDelete(state.id),
        onCancel: () => {
          if (!running.current) setState(null);
        },
      }
    : null;

  return { open, confirm };
}
