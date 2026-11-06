"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { EditorContent, useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { NodeSelection, type Transaction } from "@tiptap/pm/state";
import {
  BLOCK_TYPES,
  blockType,
  focusBodyStart,
  lineTypeId,
  setLineType,
  shouldShowFormatBar,
} from "../lib/block-editor/blocks";
import {
  addSlashLineBelow,
  canTurnRowIntoText,
  deleteRow,
  duplicateRow,
  listRows,
  rowAt,
  turnRowIntoText,
  type Row,
} from "../lib/block-editor/rows";
import { isPageAction, slashMenuStore, type PageAction, type SlashItem } from "../lib/block-editor/slash";
import { CaretIcon, GripIcon, PlusIcon } from "./icons";
import { Bold, Code, Heading1, Heading2, Heading3, Italic, Strikethrough, TextCursorInput } from "lucide-react";
import { usePopover } from "./usePopover";

/**
 * 文書のブロックのエディタ（本文＋「/」のメニュー＋書式のバー＋行の ＋ ⋮⋮）。
 * エディタは useDocEditor で作る（拡張・値の受け渡しはそちら）。`pageActions` は「/」のメニューの行の種類の後ろに足す
 * ページの操作（文書のページの「録音のページ」。成果物の子ページには渡さない）。
 */
export function BlockEditor(props: { editor: Editor | null; pageActions?: readonly PageAction[] }) {
  const wrapRef = useRef<HTMLDivElement>(null!);
  const { editor } = props;
  // 「/」のメニューが読む操作を、描くたびに今の値へ置き直す
  const pageActions = props.pageActions ?? NO_ACTIONS;
  useLayoutEffect(() => {
    if (editor) slashMenuStore(editor).pageActions = pageActions;
  });
  return (
    <div className="be" ref={wrapRef}>
      <EditorContent editor={editor} />
      {editor && (
        <>
          <SlashMenu editor={editor} />
          <FormatBar editor={editor} />
          <RowHandles editor={editor} wrapRef={wrapRef} />
        </>
      )}
    </div>
  );
}

const keepFocus = (event: ReactMouseEvent) => event.preventDefault();
const NO_ACTIONS: readonly PageAction[] = [];

function SlashMenu(props: { editor: Editor }) {
  const store = slashMenuStore(props.editor);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const headingId = useId();
  const pageHeadingId = useId();
  const open = Boolean(snapshot && snapshot.items.length > 0);

  // スクロール・窓の大きさが変わったら位置を取り直す
  useEffect(() => {
    if (!open) return;
    const reposition = () => store.reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, store]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!snapshot || !menu) {
      setPosition(null);
      return;
    }
    // 「/」の下に出し、入りきらないなら上に出す
    const anchor = snapshot.rect ?? new DOMRect();
    const size = menu.getBoundingClientRect();
    let top = anchor.bottom + 6;
    if (top + size.height > window.innerHeight - 8 && anchor.top - 6 - size.height >= 8) top = anchor.top - 6 - size.height;
    const left = Math.max(8, Math.min(anchor.left - 4, window.innerWidth - size.width - 8));
    setPosition({ left, top });
    menu.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [snapshot]);

  if (!snapshot || snapshot.items.length === 0) return null;
  // 行の種類（基本ブロック）とページの操作（ページ）を分けて出す。選択の番号は 2 つを通した並び
  const option = (item: SlashItem, index: number) => (
    <button
      key={item.id}
      type="button"
      role="option"
      aria-selected={index === snapshot.index}
      className={index === snapshot.index ? "sel" : undefined}
      // マウスを動かしたときだけ選択を移す（↑↓ でスクロールしたときの mouseenter では動かさない）
      onMouseMove={() => store.select(index)}
      onClick={() => store.choose(index)}
    >
      <span className="k" aria-hidden="true">
        {isPageAction(item) && item.icon ? item.icon : item.key}
      </span>
      <span className="n">{item.name}</span>
      {item.hint && (
        <span className="hint" aria-hidden="true">
          {item.hint}
        </span>
      )}
    </button>
  );
  const indexed = snapshot.items.map((item, index) => ({ item, index }));
  const blocks = indexed.filter(({ item }) => !isPageAction(item));
  const actions = indexed.filter(({ item }) => isPageAction(item));
  return (
    <div
      ref={menuRef}
      className="be-slash"
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? "visible" : "hidden" }}
      onMouseDown={keepFocus}
    >
      {blocks.length > 0 && (
        <>
          <div className="h" id={headingId}>
            基本ブロック
          </div>
          <div role="listbox" aria-labelledby={headingId}>
            {blocks.map(({ item, index }) => option(item, index))}
          </div>
        </>
      )}
      {actions.length > 0 && (
        <>
          <div className="h" id={pageHeadingId}>
            ページ
          </div>
          <div role="listbox" aria-labelledby={pageHeadingId}>
            {actions.map(({ item, index }) => option(item, index))}
          </div>
        </>
      )}
    </div>
  );
}

function MarkButton(props: { label: string; pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={props.label} title={props.label} aria-pressed={props.pressed} onMouseDown={keepFocus} onClick={props.onClick}>
      {props.children}
    </button>
  );
}

const TURN_TYPES = BLOCK_TYPES.filter((type) => type.id !== "hr");

function FormatBar(props: { editor: Editor }) {
  const { editor } = props;
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      type: lineTypeId(current.state),
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      strike: current.isActive("strike"),
      code: current.isActive("code"),
      from: current.state.selection.from,
      to: current.state.selection.to,
    }),
  });
  const [turnOpen, setTurnOpen] = useState(false);
  // 選択が変わったら行の種類の一覧は閉じる
  useEffect(() => setTurnOpen(false), [state.from, state.to]);
  const turnInto = (id: (typeof TURN_TYPES)[number]["id"]) => {
    editor.chain().focus().command(setLineType(id)).run();
    setTurnOpen(false);
  };
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="formatBar"
      className="be-bar"
      role="toolbar"
      aria-label="書式"
      onMouseDown={keepFocus}
      options={{ placement: "top-start", offset: 8 }}
      // グローバルの document ではなく、要素の ownerDocument を見る。TipTap の更新タイマーは画面（テストでは jsdom）が破棄されたあとにも
      // 発火することがあり、そのとき `document` が無いと ReferenceError で全テスト通過でも終了コード 1 になる
      shouldShow={({ editor: current, state: editorState, view, element }) =>
        (view.hasFocus() || element.contains(element.ownerDocument.activeElement)) && shouldShowFormatBar(editorState, current.isEditable)
      }
    >
      <div className="be-turn">
        <button type="button" className="be-turn-btn" aria-label={`行の種類: ${blockType(state.type ?? "paragraph").name}`} title="行の種類" aria-haspopup="menu" aria-expanded={turnOpen} onMouseDown={keepFocus} onClick={() => setTurnOpen((value) => !value)}>
          {state.type === "h1" ? <Heading1 /> : state.type === "h2" ? <Heading2 /> : state.type === "h3" ? <Heading3 /> : <TextCursorInput />}
          <CaretIcon />
        </button>
        {turnOpen && (
          <div className="pop" role="menu" aria-label="行の種類">
            {TURN_TYPES.map((type) => (
              <button
                key={type.id}
                type="button"
                role="menuitem"
                className={`mi${type.id === state.type ? " on" : ""}`}
                onMouseDown={keepFocus}
                onClick={() => turnInto(type.id)}
              >
                <span className="k" aria-hidden="true">
                  {type.key}
                </span>
                {type.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="sep" aria-hidden="true" />
      <MarkButton label="太字" pressed={state.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold />
      </MarkButton>
      <MarkButton label="斜体" pressed={state.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic />
      </MarkButton>
      <MarkButton label="取り消し線" pressed={state.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough />
      </MarkButton>
      <MarkButton label="コード" pressed={state.code} onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code />
      </MarkButton>
    </BubbleMenu>
  );
}

type Hover = { index: number; left: number; top: number };

/** 行の 1 行目の高さの中央（の画面上の y）。 */
function firstLineCenter(element: HTMLElement): number {
  const line = element.matches("p, h1, h2, h3, pre, hr, .md-raw")
    ? element
    : (element.querySelector<HTMLElement>("p, h1, h2, h3, pre, .md-raw") ?? element);
  const rect = line.getBoundingClientRect();
  if (line.tagName === "HR") return rect.top + rect.height / 2;
  const style = getComputedStyle(line);
  const lineHeight = Number.parseFloat(style.lineHeight) || 26;
  return rect.top + (Number.parseFloat(style.paddingTop) || 0) + lineHeight / 2;
}

/** 行 index の ＋ ⋮⋮ を置く位置（本文の左の余白で、1 行目の高さの中央）。 */
function handlePlace(editor: Editor, wrap: HTMLElement, index: number, element: HTMLElement): Hover {
  const dom = editor.view.dom as HTMLElement;
  const contentLeft = dom.getBoundingClientRect().left + (Number.parseFloat(getComputedStyle(dom).paddingLeft) || 0);
  const wrapRect = wrap.getBoundingClientRect();
  return { index, left: contentLeft - 50 - wrapRect.left, top: firstLineCenter(element) - 12 - wrapRect.top };
}

/** カーソルのある行（エディタにフォーカスがあるとき）。マウスを使わなくても ＋ ⋮⋮ に届くように、hover と同じ位置に出す。 */
function caretAt(editor: Editor, wrap: HTMLElement): Hover | null {
  if (!editor.isEditable || !editor.isFocused) return null;
  const rows = listRows(editor.state.doc);
  const { selection } = editor.state;
  // 区切り線・画像のように選んだブロックは、選んだものの始まりで行を決める（head は末尾＝次の行の先頭になる）
  const row = rowAt(editor.state.doc, selection instanceof NodeSelection ? selection.from : selection.head);
  const index = row ? rows.findIndex((item) => item.pos === row.pos) : -1;
  const element = index < 0 ? null : editor.view.nodeDOM(rows[index]!.pos);
  return element instanceof HTMLElement ? handlePlace(editor, wrap, index, element) : null;
}

function sameHover(a: Hover | null, b: Hover | null): boolean {
  return a === b || (a !== null && b !== null && a.index === b.index && a.left === b.left && a.top === b.top);
}

/** マウスの位置の行（本文の左の余白〜本文の上）。行と行の間の余白は上の行に含める。 */
function hoverAt(editor: Editor, wrap: HTMLElement, x: number, y: number): Hover | null {
  const dom = editor.view.dom as HTMLElement;
  const docRect = dom.getBoundingClientRect();
  const contentLeft = docRect.left + (Number.parseFloat(getComputedStyle(dom).paddingLeft) || 0);
  if (x < contentLeft - 70 || x > docRect.right + 20) return null;
  const rows = listRows(editor.state.doc);
  let hit: { index: number; element: HTMLElement; rect: DOMRect } | null = null;
  for (let index = 0; index < rows.length; index++) {
    const element = editor.view.nodeDOM(rows[index]!.pos);
    if (!(element instanceof HTMLElement)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.top > y) break;
    hit = { index, element, rect };
  }
  if (!hit || y > hit.rect.bottom + 16) return null;
  return handlePlace(editor, wrap, hit.index, hit.element);
}

/**
 * 行の ＋ ⋮⋮。マウスが本文の上にあるときと、エディタのカーソルがある行（フォーカス）のときに出す。hover だけに置かない
 * （design-guide §8）ので、キーボードの人は本文から Tab で ＋ ⋮⋮ に届く。リストの行では Tab が入れ子に使われるので、
 * ⌘/（Ctrl+/）でカーソルの行の「行の操作」を開く（Notion と同じキー）。
 */
function RowHandles(props: { editor: Editor; wrapRef: RefObject<HTMLDivElement> }) {
  const { editor, wrapRef } = props;
  const editable = useEditorState({ editor, selector: ({ editor: current }) => current.isEditable });
  const [hover, setHover] = useState<Hover | null>(null);
  const [caret, setCaret] = useState<Hover | null>(null);
  const menu = usePopover();
  const { setOpen: setMenuOpen } = menu;
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menu.open;
  // フォーカスが ＋ ⋮⋮ の中にある間。Tab で移るとエディタが先にフォーカスを失うので、その間も行に置いたままにする
  const handlesFocusRef = useRef(false);
  // ⌘/ で開いたメニューの最初の項目へ、描いたあとでフォーカスを移す
  const focusMenuRef = useRef(false);
  const gripRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !editable) {
      setHover(null);
      setCaret(null);
      return;
    }
    const onMove = (event: MouseEvent) => {
      if (menuOpenRef.current || handlesFocusRef.current) return;
      if (event.target instanceof Element && event.target.closest(".be-hdl, .be-slash, .be-bar")) return;
      setHover(hoverAt(editor, wrap, event.clientX, event.clientY));
    };
    const onLeave = () => {
      if (!menuOpenRef.current) setHover(null);
    };
    // 文字を打つとマウスの位置の ＋ ⋮⋮ は隠す（カーソルの行のものは残る）
    const onUpdate = () => {
      if (!menuOpenRef.current) setHover(null);
    };
    const syncCaret = () => {
      if (handlesFocusRef.current) return;
      const next = caretAt(editor, wrap);
      setCaret((current) => (sameHover(current, next) ? current : next));
    };
    // エディタと ＋ ⋮⋮ の外へフォーカスが出たら、メニューも閉じて隠す（中どうしの移動では隠さない）
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && wrap.contains(event.relatedTarget)) return;
      handlesFocusRef.current = false;
      setMenuOpen(false);
      setCaret(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.key !== "/" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (!(event.target instanceof Node) || !editor.view.dom.contains(event.target)) return;
      const next = caretAt(editor, wrap);
      if (!next) return;
      event.preventDefault();
      setHover(null);
      setCaret(next);
      focusMenuRef.current = true;
      setMenuOpen(true);
    };
    wrap.addEventListener("mousemove", onMove);
    wrap.addEventListener("mouseleave", onLeave);
    wrap.addEventListener("focusout", onFocusOut);
    wrap.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", syncCaret);
    editor.on("update", onUpdate);
    editor.on("update", syncCaret);
    editor.on("selectionUpdate", syncCaret);
    editor.on("focus", syncCaret);
    syncCaret();
    return () => {
      wrap.removeEventListener("mousemove", onMove);
      wrap.removeEventListener("mouseleave", onLeave);
      wrap.removeEventListener("focusout", onFocusOut);
      wrap.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", syncCaret);
      editor.off("update", onUpdate);
      editor.off("update", syncCaret);
      editor.off("selectionUpdate", syncCaret);
      editor.off("focus", syncCaret);
    };
  }, [editor, editable, wrapRef, setMenuOpen]);

  useLayoutEffect(() => {
    if (!menu.open || !focusMenuRef.current) return;
    focusMenuRef.current = false;
    menu.ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  });

  const shown = hover ?? caret;
  if (!editable || !shown) return null;
  const row = listRows(editor.state.doc)[shown.index];
  if (!row) return null;

  const run = (operation: (tr: Transaction, row: Row) => void) => {
    const current = listRows(editor.state.doc)[shown.index];
    menu.setOpen(false);
    setHover(null);
    // ボタンが消えてフォーカスが行き場を失う前に（キーボードで押したとき）、すぐ本文へ戻す。focus コマンドは次のフレームまで遅れる
    handlesFocusRef.current = false;
    editor.view.focus();
    if (!current) return;
    const tr = editor.state.tr;
    operation(tr, current);
    editor.view.dispatch(tr.scrollIntoView());
    editor.commands.focus();
  };
  return (
    <div
      ref={menu.ref}
      className="be-hdl"
      style={{ left: shown.left, top: shown.top }}
      onMouseDown={keepFocus}
      onFocus={() => {
        handlesFocusRef.current = true;
      }}
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) handlesFocusRef.current = false;
      }}
      onKeyDown={(event) => {
        // Esc でメニューを閉じるとき、項目と一緒にフォーカスが消えないよう ⋮⋮ へ戻す
        if (event.key === "Escape" && menu.open) gripRef.current?.focus();
      }}
    >
      <button type="button" aria-label="下に行を足す" title="下に行を足す" onClick={() => run(addSlashLineBelow)}>
        <PlusIcon />
      </button>
      <button
        ref={gripRef}
        type="button"
        aria-label="行の操作"
        title="行の操作"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-keyshortcuts="Meta+/ Control+/"
        onClick={menu.toggle}
      >
        <GripIcon />
      </button>
      {menu.open && (
        <div className="pop" role="menu" aria-label="行の操作">
          <button type="button" className="mi" role="menuitem" onClick={() => run(deleteRow)}>
            削除
          </button>
          <button type="button" className="mi" role="menuitem" onClick={() => run(duplicateRow)}>
            複製
          </button>
          <button type="button" className="mi" role="menuitem" disabled={!canTurnRowIntoText(row)} onClick={() => run(turnRowIntoText)}>
            テキストに戻す
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 文書のページのタイトル（P1 の「文書のページ」で使う）。Enter（日本語入力の確定中は除く）か ↓ で本文の 1 行目の先頭へ移る。
 */
/**
 * 題名の textarea を、書いた分だけの高さにする。欄の幅が変わったら測り直す（高さだけを変えても幅は変わらないので、ResizeObserver が
 * 自分の変更で回り続けることはない）。窓の resize でも測り直す: 本文の列が上限（680px）に達していると、900px の区切りで題名の
 * 文字の大きさ（26px ↔ 30px）だけが変わって幅は変わらない（Codex P2）。返す関数で見張りをやめる。
 * ResizeObserver が無い環境（テスト）では、窓の resize だけを見る。
 */
export function fitTitleHeight(element: HTMLTextAreaElement): () => void {
  const fit = () => {
    element.style.height = "auto";
    if (element.scrollHeight > 0) element.style.height = `${element.scrollHeight}px`;
  };
  fit();
  window.addEventListener("resize", fit);
  if (typeof ResizeObserver === "undefined") return () => window.removeEventListener("resize", fit);
  let width = element.clientWidth;
  const observer = new ResizeObserver(() => {
    if (element.clientWidth === width) return;
    width = element.clientWidth;
    fit();
  });
  observer.observe(element);
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", fit);
  };
}

export function PageTitle(props: { value: string; onChange: (value: string) => void; editor: Editor | null; placeholder?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // 折り返した分だけ高くする（1 行の入力欄のように見せる）。列の幅が変わったとき（パネルの開閉・境目のドラッグ・画面の回転・
  // サーバーが広い画面と推定して描いたあと狭い画面に切り替わったとき）も折り返しが変わるので、幅を見張って測り直す
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    return fitTitleHeight(element);
  }, [props.value]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key !== "Enter" && event.key !== "ArrowDown") return;
    if (!props.editor) return;
    event.preventDefault();
    focusBodyStart(props.editor);
  };
  return (
    <textarea
      ref={ref}
      className="page-title"
      rows={1}
      value={props.value}
      placeholder={props.placeholder ?? "無題"}
      aria-label="タイトル"
      onChange={(event) => props.onChange(event.target.value.replace(/\r?\n/g, " "))}
      onKeyDown={onKeyDown}
    />
  );
}
