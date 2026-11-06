"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { PageSummary } from "@niho/editor-store";
import { PageTitle } from "niho-docs-ui/components/BlockEditor";
import { Icon } from "niho-docs-ui/shell";
import type { AttachedPage } from "@/lib/attached-page";
import { MAX_TITLE_CHARS } from "@/lib/page-limits";
import { PageConflictError, savePageRequest } from "@/lib/pages-client";
import { folderContents } from "@/lib/sidebar-items";
import { useEditorFrame } from "./EditorFrame";
import styles from "./FolderPage.module.css";

const NO_TEXT = { read: () => "", subscribe: () => () => undefined };
const SAVE_FAILED = "名前を保存できませんでした。もう一度試してください";

/**
 * フォルダ（`kind = 'folder'`）を開いた画面（docs/architecture/editor-recipes-and-folders.md §3.2・§5。モック editor-folders-v1）。
 *
 * - 本文のエディタは出さない。題名（その場で直せる。保存は題名だけの `PATCH /api/pages/{id}`）・「新しいページ」「録音から」・中身の一覧。
 * - 中身は枠が読み込んである一覧の行（サイドバーと同じ並び・同じ 2 行目の言葉）。録音の下に工程のサブページを 1 段下げて並べる。
 * - 枠に「開いているページ」として登録する（「…」の 書き出し（.zip）・削除 のため）。公開・挿入の道具・AI は枠が出さない。
 */
export function FolderPage({ summary, revision, aboveTitle }: { summary: PageSummary; revision: number; aboveTitle?: ReactNode }) {
  const router = useRouter();
  const frame = useEditorFrame();
  const { attachPage, pageTitleChanged, pageSaved } = frame;
  const { id } = summary;
  const [title, setTitle] = useState(summary.title);
  const [note, setNote] = useState<string | null>(null);
  const revisionRef = useRef(revision);
  const savedTitle = useRef(summary.title);
  const pending = useRef<Promise<boolean>>(Promise.resolve(true));
  const titleRef = useRef(summary.title);

  /** 今の題名を送る（同じ題名なら送らない）。届いたら true。競合したら、今の revision の上にもう一度だけ送る。 */
  const saveTitle = useCallback((): Promise<boolean> => {
    const send = async (): Promise<boolean> => {
      const value = titleRef.current;
      if (value === savedTitle.current) return true;
      try {
        revisionRef.current = await savePageRequest(id, { title: value }, { baseRevision: revisionRef.current });
      } catch (error) {
        if (!(error instanceof PageConflictError)) {
          setNote(SAVE_FAILED);
          return false;
        }
        try {
          revisionRef.current = await savePageRequest(id, { title: value }, { baseRevision: error.page.revision });
        } catch {
          setNote(SAVE_FAILED);
          return false;
        }
      }
      savedTitle.current = value;
      setNote(null);
      pageSaved(id);
      return true;
    };
    pending.current = pending.current.then(send, send);
    return pending.current;
  }, [id, pageSaved]);

  // 枠の「…」（書き出し（.zip）・削除）のための登録。操作の前に題名を保存する
  const flush = useCallback(() => saveTitle(), [saveTitle]);
  useEffect(() => {
    const page: AttachedPage = {
      id,
      status: "saved",
      flush,
      revision: () => revisionRef.current,
      reopen: () => undefined,
      shared: false,
      setShared: () => undefined,
      lang: summary.lang,
      setLang: () => undefined,
      langNote: null,
      text: NO_TEXT,
    };
    return attachPage(page);
  }, [id, flush, attachPage, summary.lang]);

  // 離れるときに、まだ送っていない題名を送る
  useEffect(() => () => void saveTitle(), [saveTitle]);

  const rows = useMemo(() => folderContents(frame.pages ?? [], id, frame.now ?? 0), [frame.pages, frame.now, id]);
  const inside = `in=${encodeURIComponent(id)}`;

  return (
    // 本文の列（.es-canvas-in。最大 680px・中央）。ページの本文と同じ幅にそろえる
    <div data-docs-app-root="" data-docs-shared-ui="" data-folder-page="" className="es-canvas-in">
      {aboveTitle}
      {/* 題名は欄を離れたときに保存する（題名だけの PATCH。本文は持たない） */}
      <div className={styles.head} onBlur={() => void saveTitle()}>
        <Icon name="folder" className={styles.icon} />
        <PageTitle
          value={title}
          editor={null}
          onChange={(input) => {
            const value = Array.from(input).slice(0, MAX_TITLE_CHARS).join("");
            setTitle(value);
            titleRef.current = value;
            pageTitleChanged(id, value);
          }}
        />
      </div>
      <div className={styles.acts}>
        <button type="button" className="es-btn es-btn--primary es-btn--sm" onClick={() => router.push(`/p/new?${inside}`)}>
          <Icon name="plus" />
          新しいページ
        </button>
        <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={() => router.push(`/p/new?from=recording&${inside}`)}>
          <Icon name="mic" />
          録音から
        </button>
      </div>
      {/* 一覧（と知らせ）はボタンの列から離す。ul・p の margin は枠（shell.css）が 0 に初期化するので、間隔はこの包みが持つ */}
      <div className={styles.list}>
        {note && (
          <p role="alert" className={styles.note}>
            {note}
          </p>
        )}
        {rows.length === 0 ? (
          <p className={styles.empty}>まだページがありません</p>
        ) : (
          <ul className={styles.rows} aria-label={`「${title || "無題"}」の中`}>
            {rows.map((row) => (
              <li key={row.id} className={`${styles.row}${row.depth ? ` ${styles.step}` : ""}`}>
                <button type="button" className={styles.rowButton} onClick={() => router.push(`/p/${row.id}`)}>
                  <Icon name={row.icon ?? "doc"} className={styles.ki} />
                  <span className={styles.text}>
                    <b className={row.title ? undefined : styles.untitled}>{row.title || "無題"}</b>
                    {(row.sub || row.busy) && <small>{row.busy && !row.sub ? "作成中…" : row.sub?.text}</small>}
                  </span>
                  <span className={styles.when}>{row.when}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
