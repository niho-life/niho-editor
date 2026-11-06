import "niho-ui/styles/tokens.css";
import "niho-docs-ui/styles/tokens.css";
import "niho-ui/styles/editor-tokens.css";
import "niho-docs-ui/styles/shell.css";
import "niho-docs-ui/styles/editor.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { PageTitle } from "niho-docs-ui/components/BlockEditor";
import type { DocsHost } from "niho-docs-ui/host/DocsHost";
import {
  EditorShell,
  ShellHeader,
  ShellSidebar,
  type NewPageKind,
  type ShellListItem,
} from "niho-docs-ui/shell";
import {
  PageChrome,
  SAVE_STATUS_TEXT,
  buildPageExtensions,
  docFromBlocks,
  formatWhen,
  headerStatus,
  isSaveShortcut,
  normalizePastedHtml,
  replaceBlocks,
  type Block,
  type SaveStatus,
} from "niho-docs-ui/page";
import { vaultPages, type VaultPage } from "./vault-pages";

/**
 * Mac の新しい画面（#45 第 1 段）。Web（apps/editor-web）と同じ shell の枠・同じ本文のエディタで、
 * 保管庫のページを一覧して書く。
 *
 * この段で持つのは、枠（1 段のヘッダー・左の一覧・本人の行）と、ページの一覧・新しいページ・題名・本文の編集・自動保存だけ。
 * 公開のシート・発信先・手順の帯・AI・録音・画像は別の Issue（この画面には出さない）。
 * 旧い画面は残っていて、切り替えは `apps/docs/src/App.tsx`（環境変数 `VITE_NIHO_DOCS_EDITOR_SHELL`）。
 */

/** 自動保存の間（打ち終わってから送るまで）。旧い画面の本文と同じ 250ms。 */
const SAVE_DELAY_MS = 250;
/** 打ち続けていても、これだけ経ったら送る。 */
const SAVE_MAX_MS = 1000;
/** 窓を閉じる要求で、書き終わるのを待つ上限（旧い画面の workspace-model.ts の CLOSE_FLUSH_MS と同じ）。 */
const CLOSE_FLUSH_MS = 5000;

type Opened = {
  page: VaultPage;
  handle: string;
  blocks: Block[];
};

/** まだ書いていない変更（本文は、送る直前にだけ JSON にする）。 */
type PageChange = { blocks?: () => Block[]; title?: string };

/** 保存できていない変更があるときに、ページを替えなかったことを知らせる文。 */
const NOT_SAVED_NOTE = "保存できていない変更があるので、ページを替えませんでした（⌘S でもう一度試せます）";

function listItems(pages: readonly VaultPage[], now: number): ShellListItem[] {
  return pages.map((page) => ({
    id: page.id,
    title: page.title,
    when: formatWhen(page.updatedMs > 0 ? new Date(page.updatedMs).toISOString() : page.createdAt, now),
  }));
}

export function EditorScreen({ bridge }: { bridge: DocsHost; me: { name: string; caption: string; initial: string } }) {
  const pages = useMemo(() => vaultPages(bridge), [bridge]);
  const [rows, setRows] = useState<VaultPage[]>([]);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [problem, setProblem] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [search, setSearch] = useState<{ open: boolean; value: string }>({ open: false, value: "" });
  const [now, setNow] = useState(() => Date.now());

  // 「いまの値」を effect・保存の中から読むための控え（描画には state を使う）
  const openedRef = useRef<Opened | null>(null);
  openedRef.current = opened;
  /** 保管庫に入っている題名（これと違うときだけ付け替える）。 */
  const savedTitle = useRef("");

  const refresh = useCallback(async () => {
    try {
      setRows(await pages.list());
    } catch {
      setProblem("ページの一覧を読めませんでした");
    }
  }, [pages]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 一覧の「N分前」を進める（1 分ごと）
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // ===== 自動保存 =====
  /** まだ書いていない変更。**保存が失敗したらここへ積み直す**（捨てると未保存の本文が消える）。 */
  const pending = useRef<PageChange | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const since = useRef<number | null>(null);
  /** 走っている保存。新しい flush はこれの後ろに並べる（同時に 2 つ書かない・順番を入れ替えない）。 */
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));

  /** 1 回分を書く。書けたら null、書けなければ画面に出す理由。 */
  const write = useCallback(
    async (current: Opened, change: PageChange): Promise<string | null> => {
      try {
        if (change.title !== undefined && change.title !== savedTitle.current) {
          const next = change.title;
          await pages.rename(current.page.id, next);
          savedTitle.current = next;
          setRows((list) => list.map((row) => (row.id === current.page.id ? { ...row, title: next } : row)));
        }
        if (change.blocks) {
          const saved = await pages.save(current.handle, change.blocks());
          if (!saved.ok) return saved.problem;
        }
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : "保存できませんでした";
      }
    },
    [pages],
  );

  /**
   * 積んだ変更が無くなるまで書く。**保存の最中に来た編集も、成功を報告する前に書き切る**。
   * 1 つでも書けなければ、その変更を積み直して false（呼ぶ側は、ページを替えたり窓を閉じたりしない）。
   */
  const writeAll = useCallback(async (): Promise<boolean> => {
    let wrote = false;
    while (pending.current !== null) {
      const change = pending.current;
      const current = openedRef.current;
      if (!current) {
        // ページを閉じたので、書く先が無い（積んだ変更は捨てる）
        pending.current = null;
        since.current = null;
        return true;
      }
      pending.current = null;
      setStatus("saving");
      const problem = await write(current, change);
      if (problem !== null) {
        // 失敗した変更は捨てない。書いている間に来た新しい編集は、その上に重ねる
        pending.current = { ...change, ...(pending.current ?? {}) };
        setStatus("error");
        setProblem(problem);
        return false;
      }
      wrote = true;
      setRows((list) => list.map((row) => (row.id === current.page.id ? { ...row, updatedMs: Date.now() } : row)));
    }
    since.current = null;
    if (wrote) {
      setStatus("saved");
      setProblem(null);
    }
    return true;
  }, [write]);

  /** 積んだ変更を今すぐ書く。走っている保存の後ろに並べるので、戻ったときには自分の分も書けている。 */
  const flush = useCallback((): Promise<boolean> => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const next = chain.current.catch(() => false).then(() => writeAll());
    chain.current = next.catch(() => false);
    return next;
  }, [writeAll]);

  /** 画面を離れるとき・窓を閉じるときに読む（effect を貼り直さない）。 */
  const flushRef = useRef(flush);
  flushRef.current = flush;

  const change = useCallback(
    (next: PageChange) => {
      pending.current = { ...pending.current, ...next };
      setStatus("saving");
      const start = since.current ?? Date.now();
      since.current = start;
      if (timer.current !== null) clearTimeout(timer.current);
      const wait = Math.min(SAVE_DELAY_MS, Math.max(0, start + SAVE_MAX_MS - Date.now()));
      timer.current = setTimeout(() => void flush(), wait);
    },
    [flush],
  );

  // ⌘S は保存を今すぐにするだけ（保存のボタンは持たない）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event)) return;
      event.preventDefault();
      void flush();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flush]);

  const editor = useEditor({
    // 画像は Mac の資産の id の決め方が未定なので、この段では入れる口を渡さない（schema は Web と同じ）
    extensions: buildPageExtensions(),
    content: docFromBlocks([]),
    editable: false,
    immediatelyRender: false,
    enableContentCheck: true,
    editorProps: { attributes: { class: "doc", "aria-label": "本文" }, transformPastedHTML: normalizePastedHtml },
    onUpdate: ({ editor: current }) => change({ blocks: () => (current.getJSON().content ?? []) as Block[] }),
  });

  // 開いたページの本文をエディタに載せる
  useEffect(() => {
    if (!editor) return;
    if (!opened) {
      editor.setEditable(false);
      return;
    }
    replaceBlocks(editor, opened.blocks);
    editor.setEditable(true);
  }, [editor, opened]);

  const select = useCallback(
    async (id: string) => {
      if (openedRef.current?.page.id === id) return;
      // 書き残しを書き切れないうちは、handle を返さない・本文を置き換えない（未保存の本文が消える）
      if (!(await flush())) {
        setProblem(NOT_SAVED_NOTE);
        return;
      }
      const previous = openedRef.current;
      if (previous) await pages.release(previous.handle);
      const row = rows.find((page) => page.id === id);
      if (!row) return;
      const body = await pages.open(id);
      if (!body.ok) {
        setOpened(null);
        setTitle("");
        setProblem(body.problem);
        return;
      }
      setProblem(null);
      setStatus("saved");
      setTitle(row.title);
      savedTitle.current = row.title;
      setOpened({ page: { ...row }, handle: body.handle, blocks: body.blocks });
    },
    [flush, pages, rows],
  );

  /**
   * 窓を閉じる要求（旧い画面の useWorkspaceCloseGuard と同じ決まり）。書きかけを書き終えるまで閉じるのを待ち、
   * 書き切れなかったときは一度だけ閉じるのを止めて知らせる（もう一度閉じれば閉じる。窓が閉じられなくならないように）。
   * unmount の cleanup では webview の close を止められないので、ここで登録する。
   */
  useEffect(() => {
    let cancelled = false;
    let warned = false;
    let unlisten: (() => void) | null = null;
    void bridge
      .onCloseRequested?.(async () => {
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<boolean>((resolve) => {
          closeTimer = setTimeout(() => resolve(false), CLOSE_FLUSH_MS);
        });
        const saved = await Promise.race([flushRef.current(), timeout]);
        clearTimeout(closeTimer);
        if (saved) {
          warned = false;
          return true;
        }
        if (warned) return true;
        warned = true;
        setProblem("本文を保存できませんでした。もう一度閉じると、書きかけは失われます");
        return false;
      })
      .then(
        (stop) => {
          if (cancelled) stop?.();
          else unlisten = stop ?? null;
        },
        () => undefined,
      );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [bridge]);

  // 画面を離れるときは、書きかけを送ってから handle を返す（cleanup は待てないので、送るだけ）
  useEffect(
    () => () => {
      const current = openedRef.current;
      if (!current) return;
      void flushRef.current().finally(() => void pages.release(current.handle));
    },
    [pages],
  );

  const pickNew = useCallback(
    async (kind: NewPageKind) => {
      setNewMenuOpen(false);
      // この段で作れるのは空のページだけ（録音からは #36・#45 第 2 段）
      if (kind !== "blank") {
        setProblem("この画面では、まだ空のページだけを作れます");
        return;
      }
      if (!(await flush())) {
        setProblem(NOT_SAVED_NOTE);
        return;
      }
      const previous = openedRef.current;
      if (previous) await pages.release(previous.handle);
      try {
        const created = await pages.create(new Date().toISOString());
        const body = await pages.open(created.id);
        setRows((list) => [created, ...list]);
        if (!body.ok) {
          setProblem(body.problem);
          return;
        }
        setProblem(null);
        setStatus("saved");
        setTitle(created.title);
        savedTitle.current = created.title;
        setOpened({ page: created, handle: body.handle, blocks: body.blocks });
      } catch (error) {
        setProblem(error instanceof Error ? error.message : "新しいページを作れませんでした");
      }
    },
    [flush, pages],
  );

  const found = search.open && search.value.trim() !== ""
    ? rows.filter((row) => row.title.toLowerCase().includes(search.value.trim().toLowerCase()))
    : rows;

  return (
    <div data-docs-app-root="" data-docs-shared-ui="" style={{ position: "fixed", inset: 0 }}>
      <EditorShell
        sidebarOpen={sidebarOpen}
        railOpen={false}
        sidebar={
          <ShellSidebar
            items={listItems(found, now)}
            currentId={opened?.page.id}
            onSelect={(id) => void select(id)}
            onCollapse={() => setSidebarOpen(false)}
            newMenu={{
              open: newMenuOpen,
              onToggle: () => setNewMenuOpen((open) => !open),
              onClose: () => setNewMenuOpen(false),
              onPick: (kind) => void pickNew(kind),
              // Mac の画面は今の 2 つのまま（フォルダは Web の画面で作る。Mac 用の画面は作らない）
              kinds: ["blank", "recording"],
            }}
            search={{
              open: search.open,
              value: search.value,
              onOpen: () => setSearch({ open: true, value: "" }),
              onClose: () => setSearch({ open: false, value: "" }),
              onChange: (value) => setSearch({ open: true, value }),
            }}
            // 左下は「設定」の直リンク（shell の決まり）。Mac の殻にはまだ設定の画面が無いので、今までのメニューと同じく何もしない
            me={{ onOpen: () => undefined }}
          />
        }
        header={
          <ShellHeader
            title={opened ? title : ""}
            showListButton={!sidebarOpen}
            onToggleList={() => setSidebarOpen(true)}
            status={opened ? headerStatus(status) : undefined}
          />
        }
      >
        {opened ? (
          <div className="es-canvas-in">
            <p data-save-state={status}>{SAVE_STATUS_TEXT[status]}</p>
            {problem && <p role="alert">{problem}</p>}
            <PageTitle
              value={title}
              editor={editor}
              onChange={(value) => {
                setTitle(value);
                change({ title: value });
              }}
            />
            <div className="be">
              <EditorContent editor={editor} />
              <PageChrome editor={editor} />
            </div>
          </div>
        ) : (
          <div className="es-canvas-in">
            {problem && <p role="alert">{problem}</p>}
            <p>左の ＋ で新しいページを作るか、一覧からページを選んでください。</p>
          </div>
        )}
      </EditorShell>
    </div>
  );
}
