"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type FormEvent,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { Icon, ShellBubbleMenu, ShellMenu, useMenuDismiss, type ShellMenuItem, type ShellToolAction } from "../shell";
import {
  BLOCK_CHOICES,
  LINE_TYPE_CHOICES,
  blankLineAfterCursor,
  fillBlankLine,
  insertBlankLine,
  lineTypeOf,
  setLineType,
  type BlockChoice,
  type BlockChoiceId,
  type LineTypeId,
} from "./block-types";
import { checkLinkInput } from "./link-href";
import { slashMenuStore, type SlashMenuSnapshot } from "./slash-menu";
import { isMacPlatform, shortcutOf } from "./shortcuts";

/**
 * ⌘/（Mac 以外は Ctrl+/）でブロックの一覧を開く。window の keydown 1 つだけを登録し、unmount で外す。
 * 開けないとき（本文に焦点が無いなど）は false を返し、preventDefault しない（apps/editor-web の useShortcuts と同じ決まり）。
 */
function useBlockMenuShortcut(open: () => boolean | void): void {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (shortcutOf(event, isMacPlatform()) !== "blockMenu") return;
      if (latest.current() === false) return;
      event.preventDefault();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}

/**
 * 常設の書式の帯（ヘッダーの ShellTools）が使う操作。ページを開いているあいだ `onTools` で呼ぶ側へ渡し、閉じたら null。
 * 渡し直すのは `textType`・`blockMenuOpen` が変わったときだけ（選択が動くたびに枠を描き直さない）。
 */
export type PageChromeTools = {
  /** いまの行の種類の名前（「テキスト」「見出し 2」…）。 */
  textType: string;
  /** ブロックの一覧（＋）が開いているか。 */
  blockMenuOpen: boolean;
  run: (action: ShellToolAction) => void;
};

/** ShellBubbleMenu の plugin key（../shell/bubble.tsx）。 */
const FORMAT_BAR_KEY = "shellFormatBar";
/** 開いているメニューのボタンをもう一度押したら閉じたままにする（外のクリックで閉じた直後のクリック）。 */
const TOGGLE_WINDOW_MS = 400;
/** 浮かぶ部品と画面の端の間。 */
const VIEWPORT_MARGIN = 8;
/** 書式の帯の最大幅（shell.css の `.es-selwrap>.es-selbar` の 900px 未満の値と同じ）。 */
const BAR_MAX_WIDTH = "calc(100vw - 36px)";
/** 「/」の一覧などを上に出すときの、選んだ文字との間（.es-menu--flow の top: 6px に合わせる）。 */
const ABOVE_GAP = 6;

type Anchor = { left: number; top: number; bottom: number };

type Panel =
  | { kind: "lineType"; anchor: Anchor | null; current: LineTypeId | null }
  | { kind: "link"; anchor: Anchor | null; range: { from: number; to: number }; href: string; linked: boolean }
  /** insert: ⌘/ で、文字のある行の下に足す（選んだときに at へ空の段落を足してから変える）。 */
  | { kind: "add"; anchor: Anchor | null; at: number; insert?: boolean };

const BLOCK_IDS: ReadonlySet<string> = new Set(BLOCK_CHOICES.map((choice) => choice.id));

function isBlockChoiceId(id: string): id is BlockChoiceId {
  return BLOCK_IDS.has(id);
}

function isLineTypeId(id: string): id is LineTypeId {
  return id !== "hr" && BLOCK_IDS.has(id);
}

function blockMenuItems(choices: readonly BlockChoice[]): ShellMenuItem[] {
  return choices.map((choice) => ({ id: choice.id, label: choice.label, icon: choice.icon, hint: choice.hint || undefined }));
}

/** 行の種類の一覧。いまの種類は文字（「現在」）でも示す（色だけに頼らない）。 */
function lineTypeItems(current: LineTypeId | null): ShellMenuItem[] {
  return LINE_TYPE_CHOICES.map((choice) => ({ id: choice.id, label: choice.label, icon: choice.icon, hint: choice.id === current ? "現在" : undefined }));
}

const keepFocus = (event: ReactMouseEvent) => event.preventDefault();

/** 選んだ文字の位置（画面の座標）。描画の API が無い環境では null。 */
/**
 * 書式の帯の「行の種類」ボタンに出す、いまの行の種類の名前。ボタンの名前は見える文字から始める（WCAG 2.5.3。docs-ui の
 * shell が「<種類>、行の種類」にする）。種類が決まらない（区切り線など）ときは「テキスト」。
 */
function currentLineTypeName(editor: Editor): string {
  const current = lineTypeOf(editor.state);
  return LINE_TYPE_CHOICES.find((choice) => choice.id === current)?.label ?? "テキスト";
}

function selectionAnchor(editor: Editor): Anchor | null {
  const { from, to } = editor.state.selection;
  try {
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    return { left: start.left, top: Math.min(start.top, end.top), bottom: Math.max(start.bottom, end.bottom) };
  } catch {
    return null;
  }
}

/**
 * 浮かぶ部品を、目印の下（下に入らなければ上）に置く。位置は .es-root（offsetParent）の中の絶対位置で、
 * 画面の左右の端から出さない（320px の幅でも横に溢れない）。
 */
function placeNear(element: HTMLElement, anchor: Anchor): void {
  const parent = element.offsetParent;
  if (!(parent instanceof HTMLElement)) return;
  const base = parent.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, viewportWidth - VIEWPORT_MARGIN - width));
  const above = anchor.top - height - ABOVE_GAP;
  const top = anchor.bottom + height > viewportHeight - VIEWPORT_MARGIN && above >= VIEWPORT_MARGIN ? above : anchor.bottom;
  element.style.left = `${left - base.left}px`;
  element.style.top = `${top - base.top}px`;
}

/** 位置だけを持つ入れ物（見た目は中の .es-* が持つ）。幅は中身に合わせ、画面より広くしない。 */
const FLOATING_STYLE: CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  width: "max-content",
  maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
};

function Floating({ anchor, children, ...props }: { anchor: Anchor | null } & HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (ref.current && anchor) placeNear(ref.current, anchor);
  });
  return (
    <div ref={ref} style={FLOATING_STYLE} {...props}>
      {children}
    </div>
  );
}

const noSnapshot = (): SlashMenuSnapshot | null => null;

/**
 * 「/」のブロックの一覧（src/editor/slash-menu.ts の store を描く）。見た目は ShellMenu・ShellBlockMenu と同じ class。
 * フォーカスは本文に残す（「/」のあとの文字で絞り込む・変換を邪魔しない）ので、ShellMenu（開くと先頭にフォーカスを移す）は使わない。
 * いまの項目は太字と面で示し、本文に aria-activedescendant を付けて読み上げにも伝える。
 */
function SlashList({ editor }: { editor: Editor }) {
  const store = slashMenuStore(editor);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, noSnapshot);
  const menuId = useId();
  const items = snapshot?.items ?? [];
  const active = snapshot && items.length > 0 ? items[snapshot.index] : undefined;
  const activeId = active ? `${menuId}-${active.id}` : null;

  useEffect(() => {
    if (!activeId || editor.isDestroyed) return;
    const dom = editor.view.dom;
    dom.setAttribute("aria-controls", menuId);
    dom.setAttribute("aria-activedescendant", activeId);
    return () => {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
    };
  }, [editor, menuId, activeId]);

  // 本文からフォーカスが離れたら閉じる（「/」の文字は残す）
  useEffect(() => {
    const onBlur = () => {
      queueMicrotask(() => {
        if (store.getSnapshot()) store.close();
      });
    };
    editor.on("blur", onBlur);
    return () => {
      editor.off("blur", onBlur);
    };
  }, [editor, store]);

  if (!snapshot || items.length === 0) return null;
  const rect = snapshot.rect;
  return (
    <Floating anchor={rect ? { left: rect.left, top: rect.top, bottom: rect.bottom } : null}>
      <div id={menuId} className="es-menu es-menu--flow" role="menu" aria-label="ブロックを足す" data-slash-menu="">
        {items.map((item, index) => (
          <button
            key={item.id}
            id={`${menuId}-${item.id}`}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={index === snapshot.index ? "es-mi es-mi--on" : "es-mi"}
            onMouseDown={keepFocus}
            onMouseEnter={() => store.select(index)}
            onClick={() => store.choose(index)}
          >
            {item.icon && <Icon name={item.icon} />}
            {item.label}
            {item.hint ? <small>{item.hint}</small> : null}
          </button>
        ))}
      </div>
    </Floating>
  );
}

function LinkForm(props: { href: string; linked: boolean; onApply: (href: string) => void; onRemove: () => void; onCancel: () => void; onOutside: () => void }) {
  const { onApply, onCancel } = props;
  const formRef = useRef<HTMLFormElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(props.href);
  const [problem, setProblem] = useState<string | null>(null);
  const inputId = useId();
  const problemId = useId();
  useMenuDismiss(formRef, props.onOutside);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = checkLinkInput(value);
    if (!result.ok) {
      setProblem(result.reason);
      inputRef.current?.focus();
      return;
    }
    onApply(result.href);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Escape") return;
    // useMenuDismiss（document の Esc）より先に、選択へ戻して閉じる
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };

  return (
    <form ref={formRef} className="es-card" aria-label="リンク" noValidate onSubmit={submit} onKeyDown={onKeyDown}>
      <div className="es-field">
        <label htmlFor={inputId}>リンク先の URL</label>
        <input
          ref={inputRef}
          id={inputId}
          className="es-input"
          type="url"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="https://"
          value={value}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? problemId : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setProblem(null);
          }}
        />
      </div>
      {problem && (
        <p id={problemId} role="alert" className="es-danger">
          {problem}
        </p>
      )}
      <div className="es-acts">
        <button type="submit" className="es-btn es-btn--sm es-btn--primary">
          設定
        </button>
        {props.linked && (
          <button type="button" className="es-btn es-btn--sm es-btn--outline" onClick={props.onRemove}>
            リンクを外す
          </button>
        )}
        <button type="button" className="es-btn es-btn--sm es-btn--quiet" onClick={onCancel}>
          やめる
        </button>
      </div>
    </form>
  );
}

/**
 * 書式の帯（ShellBubbleMenu）を .es-root（root）の中に付けさせる。ShellBubbleMenu は付ける先（appendTo）を受けないので、
 * TipTap の menus が props の更新に使う meta（"updateOptions"）で渡す（docs-ui に appendTo が足されたら、これは要らない）。
 *
 * 帯の plugin は登録のたびに作り直され、渡した値を忘れる（開発の StrictMode は effect を付け直す。ほかの plugin の登録でも
 * 全ての plugin の view が作り直される）。そこで、帯と＋の後ろに置いて登録より後に渡し、さらに本文にフォーカスが来たとき・
 * 選択が始まったとき（帯は選択の 250ms 後に出る）にも渡し直す。中身の無い取引なので、本文・履歴・保存には影響しない。
 */
function FormatBarRoute({ editor, root }: { editor: Editor; root: HTMLElement }) {
  useEffect(() => {
    const route = () => {
      if (editor.isDestroyed) return;
      const options = {
        appendTo: root,
        options: {
          // 画面の端に貼り付かない
          shift: { padding: VIEWPORT_MARGIN },
          onShow: () => {
            const bar = root.querySelector<HTMLElement>(":scope > .es-selbar--live");
            if (!bar) return;
            // 帯の入れ物ではなく、中のボタンだけをタブで止まる場所にする
            bar.tabIndex = -1;
            // 帯は幅 344px ほどあり、320px の画面では横に溢れる。shell.css が静的な帯（.es-selwrap>.es-selbar）に
            // 900px 未満で当てている折り返しと同じ値を、動く帯（.es-selbar--live）にも当てる（docs-ui に足すまでの間）
            bar.style.flexWrap = "wrap";
            bar.style.maxWidth = BAR_MAX_WIDTH;
          },
        },
      };
      editor.view.dispatch(editor.state.tr.setMeta(FORMAT_BAR_KEY, { type: "updateOptions", options }).setMeta("addToHistory", false));
    };
    route();
    let selecting = !editor.state.selection.empty;
    const later = () => queueMicrotask(route);
    const onSelection = () => {
      const now = !editor.state.selection.empty;
      if (now && !selecting) later();
      selecting = now;
    };
    editor.on("focus", later);
    editor.on("selectionUpdate", onSelection);
    return () => {
      editor.off("focus", later);
      editor.off("selectionUpdate", onSelection);
    };
  }, [editor, root]);
  return null;
}

function Chrome({ editor, onAi, onTools }: { editor: Editor; onAi?: () => void; onTools?: (tools: PageChromeTools | null) => void }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const escaped = useRef(false);
  const lastDismiss = useRef<{ kind: Panel["kind"]; at: number } | null>(null);

  // 押されている状態（太字・斜体）は ShellBubbleMenu が描いたときの値を出す。選択の移動・コマンドのたびに描き直させる
  useEditorState({ editor, selector: ({ editor: current }) => ({ bold: current.isActive("bold"), italic: current.isActive("italic") }) });

  /** 外のクリックで閉じた直後に、同じメニューを開くボタンが押されたか（＝閉じたいだけ）。 */
  const recentlyDismissed = (kind: Panel["kind"]) => {
    const last = lastDismiss.current;
    lastDismiss.current = null;
    return last !== null && last.kind === kind && Date.now() - last.at < TOGGLE_WINDOW_MS;
  };

  /** メニューの onClose（Esc か外のクリック）。Esc なら本文の元の位置（選択）へフォーカスを戻す。 */
  const dismiss = (kind: Panel["kind"]) => {
    setPanel(null);
    if (escaped.current) {
      escaped.current = false;
      editor.commands.focus();
      return;
    }
    lastDismiss.current = { kind, at: Date.now() };
  };

  const noteEscape = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") escaped.current = true;
  };

  /** タブなどでフォーカスがメニューの外へ出たら閉じる（本文へは戻さない）。 */
  const closeOnFocusLeave = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) setPanel(null);
  };

  const openLineType = () => {
    if (recentlyDismissed("lineType")) return;
    escaped.current = false;
    setPanel({ kind: "lineType", anchor: selectionAnchor(editor), current: lineTypeOf(editor.state) });
  };

  const openLink = () => {
    if (recentlyDismissed("link")) return;
    const { from, to } = editor.state.selection;
    const linked = editor.isActive("link");
    const href = linked ? String(editor.getAttributes("link").href ?? "") : "";
    setPanel({ kind: "link", anchor: selectionAnchor(editor), range: { from, to }, href, linked });
  };

  /** いまの行が空ならその行を、文字があればその下に足す行を、選んだブロックにする（⌘/ と、常設の帯の「＋」）。 */
  const openBlockMenu = () => {
    const below = blankLineAfterCursor(editor.state);
    escaped.current = false;
    setPanel(
      below === null
        ? { kind: "add", at: editor.state.selection.$anchor.before(), anchor: selectionAnchor(editor) }
        : { kind: "add", at: below, anchor: selectionAnchor(editor), insert: true },
    );
  };

  // ⌘/（設計 §11）: 本文にフォーカスがあるとき、常設の帯と同じブロックの一覧を開く。
  // Esc で閉じると本文の元の位置へ戻る（何も足さない）
  useBlockMenuShortcut(() => {
    if (!editor.isEditable || !editor.view.hasFocus()) return false;
    openBlockMenu();
  });

  /** ブロックの一覧を通さずに、いまの行（か、その下の空の行）をそのブロックにする（常設の帯の「画像」）。 */
  const putBlock = (id: BlockChoiceId) => {
    const below = blankLineAfterCursor(editor.state);
    if (below === null) fillBlankLine(editor, id, { at: editor.state.selection.$anchor.before() });
    else if (insertBlankLine(editor, below)) fillBlankLine(editor, id, { at: below });
  };

  /**
   * 常設の書式の帯（ヘッダーの ShellTools）の操作。選んだ文字の上の帯と同じ道を通る（行の種類・リンクはここのメニュー、
   * 太字・斜体・見出し・箇条書きは editor のコマンド）。「録音」は本文の操作ではないので呼ぶ側（画面）が持つ。
   */
  const runTool = (action: ShellToolAction) => {
    if (!editor.isEditable) return;
    const line = lineTypeOf(editor.state);
    if (action === "add-block") openBlockMenu();
    else if (action === "text-type") openLineType();
    else if (action === "bold") editor.chain().focus().toggleBold().run();
    else if (action === "italic") editor.chain().focus().toggleItalic().run();
    else if (action === "link") openLink();
    else if (action === "heading") setLineType(editor, line === "h2" ? "paragraph" : "h2");
    else if (action === "list") setLineType(editor, line === "bullet" ? "paragraph" : "bullet");
    else if (action === "image") putBlock("image");
  };
  const textType = currentLineTypeName(editor);
  const blockMenuOpen = panel?.kind === "add";
  // 帯から呼ぶ操作はいつも今のもの（選択が動くたびに登録し直さないため、ref 越しに呼ぶ）
  const latestRun = useRef(runTool);
  latestRun.current = runTool;
  useEffect(() => {
    if (!onTools) return;
    // 登録し直すのは、帯に出す値（行の種類・ブロックの一覧の開閉）が変わったときだけ
    onTools({ textType, blockMenuOpen, run: (action) => latestRun.current(action) });
    return () => onTools(null);
  }, [onTools, textType, blockMenuOpen]);

  const linkRange = panel?.kind === "link" ? panel.range : null;

  return (
    <div ref={setRoot} className="es-root" data-page-chrome="">
      {root && (
        <>
          <ShellBubbleMenu editor={editor} onTextType={openLineType} onLink={openLink} onAi={onAi} textType={currentLineTypeName(editor)} />
          {/* 帯の plugin の登録より後に動かすため、その後ろに置く */}
          <FormatBarRoute editor={editor} root={root} />
        </>
      )}
      <SlashList editor={editor} />
      {panel?.kind === "lineType" && (
        <Floating anchor={panel.anchor} onKeyDownCapture={noteEscape} onBlur={closeOnFocusLeave}>
          <ShellMenu
            label="行の種類"
            className="es-menu--flow"
            items={lineTypeItems(panel.current)}
            onSelect={(id) => {
              setPanel(null);
              if (isLineTypeId(id)) setLineType(editor, id);
            }}
            onClose={() => dismiss("lineType")}
          />
        </Floating>
      )}
      {panel?.kind === "add" && (
        <Floating anchor={panel.anchor} onKeyDownCapture={noteEscape} onBlur={closeOnFocusLeave}>
          <ShellMenu
            label="ブロックを足す"
            className="es-menu--flow"
            items={blockMenuItems(BLOCK_CHOICES)}
            onSelect={(id) => {
              setPanel(null);
              if (!isBlockChoiceId(id) || (panel.insert && !insertBlankLine(editor, panel.at))) return;
              fillBlankLine(editor, id, { at: panel.at });
            }}
            onClose={() => dismiss("add")}
          />
        </Floating>
      )}
      {panel?.kind === "link" && linkRange && (
        <Floating anchor={panel.anchor}>
          <LinkForm
            href={panel.href}
            linked={panel.linked}
            onApply={(href) => {
              setPanel(null);
              editor.chain().focus().setTextSelection(linkRange).setLink({ href }).run();
            }}
            onRemove={() => {
              setPanel(null);
              editor.chain().focus().setTextSelection(linkRange).extendMarkRange("link").unsetLink().run();
            }}
            onCancel={() => {
              setPanel(null);
              editor.chain().focus().setTextSelection(linkRange).run();
            }}
            onOutside={() => dismiss("link")}
          />
        </Floating>
      )}
    </div>
  );
}

/**
 * 本文のエディタに付ける操作の部品（モック v6 の shell の部品で描く。見た目は niho-docs-ui/styles/shell.css・
 * niho-ui/styles/editor-tokens.css で、読むのは呼ぶ側（Mac・Web の画面））。
 * - 選んだ文字の上の書式の帯（ShellBubbleMenu）: 太字・斜体・見出し・箇条書きは帯が editor のコマンドへ、
 *   行の種類（ShellMenu）・リンク（帯の下の小さな入力）はここが持つ。AI は呼ぶ側の onAi（AI の箱を開く。src/components/AiBox.tsx）。
 * - 空の行の「/」（src/editor/slash-menu.ts）と、常設の帯・⌘/ から開くブロックの一覧。
 * 作れるのは限定 AST の範囲だけ（src/editor/block-types.ts）。常設の書式の帯（ShellTools）はヘッダーの側が持つ。
 *
 * shell.css のセレクタは `[data-docs-app-root][data-docs-shared-ui]` の中の `.es-root` の中だけに効く。本文を .es-root に入れると
 * 本文の見た目（リストの印・リンクの下線など）が shell の reset で変わるので、.es-root はこの部品の入れ物だけにし、
 * 浮かぶ部品（帯・一覧・入力）はすべてこの中に付ける。`.be`（position: relative）の中に置く。
 */
export function PageChrome({ editor, onAi, onTools }: { editor: Editor | null; onAi?: () => void; onTools?: (tools: PageChromeTools | null) => void }) {
  if (!editor) return null;
  return <Chrome editor={editor} onAi={onAi} onTools={onTools} />;
}
