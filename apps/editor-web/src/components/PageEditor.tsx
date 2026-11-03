"use client";

import "niho-ui/styles/tokens.css";
import "niho-docs-ui/styles/tokens.css";
import "niho-docs-ui/styles/editor.css";
import "niho-ui/styles/editor-tokens.css";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { PageKind, PageLang } from "@niho/editor-store";
import { PageTitle } from "niho-docs-ui/components/BlockEditor";
import { AiEntry, AiLayer, type AiOpenRequest } from "@/components/AiBox";
import { ConflictBand } from "@/components/ConflictBand";
import { useEditorFrame } from "@/components/EditorFrame";
import { PageChrome } from "niho-docs-ui/page/PageChrome";
import { selectionRange } from "@/editor/ai-scope";
import { docFromBlocks, replaceBlocks } from "@/editor/doc";
import { buildPageExtensions } from "@/editor/page-extensions";
import { normalizePastedHtml } from "@/editor/paste";
import { prepareAi, replaceForAi, type AiBridge, type AiBridgeDeps } from "@/lib/ai-bridge";
import { createAutosave, type Autosave, type SaveState } from "@/lib/autosave";
import { pageImages } from "@/lib/image-upload-client";
import {
  NEW_PAGE_DRAFT_KEY,
  createDraftKeeper,
  createIndexedDbDraftStorage,
  decideRestore,
  readDraft,
  type DraftKeeper,
  type DraftStorage,
  type PageDraft,
} from "@/lib/drafts";
import type { PageText } from "@/lib/attached-page";
import { MAX_TITLE_CHARS } from "@/lib/page-limits";
import { UNCREATED_REVISION, classifySaveFailure, createPageSaver, type PageSaver } from "@/lib/page-save";
import type { RestoredPage } from "@/lib/page-actions-client";
import { PageConflictError, type ConflictPage, type PageBody } from "@/lib/pages-client";
import { SAVE_STATUS_TEXT, type SaveStatus } from "@/lib/save-status";
import { isSaveShortcut } from "@/lib/shortcuts";

export { docFromBlocks };
/** 右上の保存状態（`conflict` は競合の帯が出ていて、自動保存を止めている）。 */
export type { SaveStatus };

/** 言語を指定しないページの言語（新しいページの既定。サーバーの既定と同じ）。 */
export const DEFAULT_PAGE_LANG: PageLang = "ja";

/** 言語を保存できず、前の言語に戻したときの一言（情報パネルの言語の下）。 */
export const LANG_NOT_SAVED = "言語を保存できませんでした";

export type EditablePage = {
  title: string;
  blocks: unknown[];
  /** ページの種類（AI の候補を選ぶ。無ければメモ）。 */
  kind?: PageKind;
  /** ページの言語（読み込んだときの値）。省略は `DEFAULT_PAGE_LANG`。 */
  lang?: PageLang;
} & (
  | {
      id: string;
      /** 読み込んだときの revision。保存のたびに `baseRevision` として送り、応答の値に進める。 */
      revision: number;
      /** 読み込んだときの更新時刻（開いたときに端末の下書きと競合したら、帯に出す）。 */
      updatedAt: string;
    }
  | {
      /** まだ作っていない新しいページ（最初の保存で作り、その応答の revision から始める）。 */
      id: null;
      revision: null;
      updatedAt?: undefined;
    }
);

export type PageEditorEvents = {
  /** 新しいページを最初の保存で作った（1 回だけ）。 */
  onCreated?: (id: string) => void;
  onTitleChange?: (title: string) => void;
  /** 保存が終わった（作った・PATCH のどちらも。版に戻したときも）。 */
  onSaved?: () => void;
  /**
   * 「今すぐ保存して、届き終わるまで待つ」を枠へ渡す（公開の前に使う。#39）。返す関数で外す。
   * 渡す関数は、全てサーバーにあれば true、保存できなければ（オフライン・失敗・競合・変換中）false。
   */
  registerSaveNow?: (saveNow: () => Promise<boolean>) => () => void;
  /** 情報パネルで変えた言語がサーバーに届いた（届いた言語。一覧の言語を替える）。 */
  onLangChange?: (lang: PageLang) => void;
};

export type PageEditorProps = {
  page: EditablePage;
  drafts?: DraftStorage | null;
  /** 新規画面を開いたら、端末の下書きを復元してから空でも保存先を作る。 */
  createOnOpen?: boolean;
  /** リンクで共有しているか（開いたときにサーバーが読んだ値。分からなければ null・省略）。「…」の「共有中」の印に使う。 */
  shared?: boolean | null;
} & PageEditorEvents;

type ScreenProps = PageEditorProps & {
  shared: boolean | null;
  setShared: (shared: boolean) => void;
  /** 版に戻したページで開き直す（言語は版に戻しても変わらないので、今の画面の言語を持っていく）。 */
  reopen: (page: RestoredPage, lang: PageLang) => void;
};

const noSubscription = () => () => undefined;

function statusOf(state: SaveState): SaveStatus {
  return state === "stopped" ? "conflict" : state;
}

/** 下書きの本文をエディタに載せる。今の schema で読めなければ載せずに false（下書きはそのまま残す）。 */
function loadDraft(editor: Editor, draft: PageDraft): boolean {
  return replaceBlocks(editor, draft.blocks);
}

/**
 * ページのエディタ（中身は下の EditorScreen）。「…」の「履歴」で版に戻したら、サーバーが返した戻したあとのページ
 * （題名・本文・revision）でエディタを開き直す（key を替えて作り直す。保存・下書き・Undo の部品も新しくなり、
 * 次の保存の `baseRevision` は戻したあとの revision から始まる。開いたときと同じく端末の下書きとも比べる）。
 * 共有の状態（「共有中」の印）と言語（版に戻しても変わらない）は開き直しても持ち越す。
 */
export function PageEditor(props: PageEditorProps) {
  const [reopened, setReopened] = useState<{ count: number; page: EditablePage } | null>(null);
  const [shared, setShared] = useState<boolean | null>(props.shared ?? null);
  // 端末の下書きの置き場は、開き直しても同じものを使う
  const [drafts] = useState<DraftStorage | null>(() => (props.drafts === undefined ? createIndexedDbDraftStorage() : props.drafts));
  const savedRef = useRef(props.onSaved);
  useEffect(() => {
    savedRef.current = props.onSaved;
  });
  const reopen = useCallback((restored: RestoredPage, lang: PageLang) => {
    const { id, title, blocks, revision, updatedAt } = restored;
    setReopened((current) => ({ count: (current?.count ?? 0) + 1, page: { id, title, blocks, revision, updatedAt, lang } }));
    // 戻した（サーバーの更新時刻が進んだ）。一覧の上へ動かす
    savedRef.current?.();
  }, []);
  return (
    <EditorScreen
      key={reopened?.count ?? 0}
      {...props}
      page={reopened?.page ?? props.page}
      drafts={drafts}
      shared={shared}
      setShared={setShared}
      reopen={reopen}
    />
  );
}

/**
 * ページの題名と本文。本文は TipTap で、作れるのは限定 AST（src/ast/blocks.ts）の範囲だけ（src/editor/page-extensions.ts）。
 * blocks は TipTap の doc の content（ブロックの配列）をそのまま保存する。貼り付けた HTML は先に洗う（src/editor/paste.ts）。
 *
 * 保存（設計 §5.1・§12）:
 * - 入力の 1 秒後に PATCH で自動保存する（revision 付き・直列）。⌘S は待たずに送る。手動の保存ボタンは持たない。
 * - 入力のたびに（300ms のまとめ）端末の下書き（IndexedDB）にも書き、その内容がサーバーに保存されたら消す。
 *   開いたときに下書きがあれば、サーバーの revision と比べて載せ直すか、競合の帯を出す（src/lib/drafts.ts）。
 * - オフライン・サーバーの失敗は送り直す。ログインが切れたら送り直さない。別の画面が先に保存していたら（409）
 *   自動保存を止めて帯を出す（本文の編集は止めない。勝手に上書きしない）。
 * - タブを閉じる・隠れる瞬間（pagehide・visibilitychange）は、下書きの書き込みを起こし、保存を keepalive で試す。
 *   どちらも完了の保証は無い（ブラウザは閉じたあとの非同期の処理を待たない。keepalive は本文が約 60KB まで）。
 *   届かなかった分は、次に開いたときに下書きから戻す。
 * 日本語入力の変換中は、下書き・保存のどちらも走らせない。
 *
 * 新しいページ（id が null）:
 * - 最初の保存で POST して作り、以後はその id へ、作ったときの revision を `baseRevision` にして PATCH する
 *   （id と revision は保存の部品が持ち、エディタは作り直さない。変換中は保存を待つので、作るのも変換の確定の後）。
 * - 作る前の本文も端末に残す（key は `NEW_PAGE_DRAFT_KEY` の 1 つの枠）。次に新しいページを開いたとき、
 *   その枠に下書きがあれば載せて、それでページを作る。作ったら、以後の下書きはそのページの id に書く。
 *
 * 「/」「＋」のブロック一覧と、選んだ文字の上の書式の帯は、docs-ui の BlockEditor（Markdown 文書の schema が前提）ではなく、
 * モック v6 の shell の部品をこの schema に合わせて繋いだもの（packages/docs-ui の page/PageChrome.tsx・page/slash-menu.ts）。
 * どちらも本文を変える操作は TipTap の transaction なので、新しいページ（id が null）でも、手で打った変更と同じく
 * 下書きと保存（最初の保存で作る）に乗る。
 *
 * AI の箱（src/components/AiBox.tsx）は、選んだ文字の上の「AI」（選んだ範囲）とページの上の「AI」（ページ全体）から開く。
 * 頼む前に未保存の入力を保存し終え、採用の結果は本文を差し替えて revision を進める（自動保存は起こさない。src/lib/ai-bridge.ts）。
 *
 * 言語（情報パネル。枠の `attachPage` の `setLang`）も同じ自動保存・下書きに載せる（別の PATCH を撃たない。revision・
 * 競合の判定・端末の下書きは題名・本文と同じ）。変えたら 1 秒を待たずに送り、届かなければサーバーが持っている言語に戻して
 * 一言出す（戻した言語も同じ保存に載せる。届いたか分からない失敗のあとでも、サーバーを画面の言語に揃えるため）。
 * 「この内容で上書き」は、競合の相手と言語が違えば画面の言語も送る。
 */
function EditorScreen(props: ScreenProps) {
  const { page, shared, setShared, reopen } = props;
  const { attachPage, registerTools } = useEditorFrame();
  const initialLang = page.lang ?? DEFAULT_PAGE_LANG;
  const [title, setTitle] = useState(page.title);
  const [lang, setLang] = useState<PageLang>(initialLang);
  const [langNote, setLangNote] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>("saved");
  // 保存先のページの id（新しいページは最初の保存で作ったときに決まる）
  const [pageId, setPageId] = useState<string | null>(page.id);
  const [unreadable, setUnreadable] = useState(false);
  const [titleClamped, setTitleClamped] = useState(false);
  const [conflict, setConflict] = useState<ConflictPage | null>(null);
  /** 端末に下書きを持てているか（false は「端末への保持なし」。表示の文言は変えない）。 */
  const [draftsKept, setDraftsKept] = useState(true);
  const [storage] = useState<DraftStorage | null>(() => (props.drafts === undefined ? createIndexedDbDraftStorage() : props.drafts));
  // 下書きを読み終えるまで入力を受けない（読む前の入力を、あとから載せる下書きで消さない）
  const [ready, setReady] = useState(storage === null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  // サーバーの描画には置き場が無い。hydration はサーバーと同じ値で行い、そのあとブラウザの値で描き直す
  const hasStorage = useSyncExternalStore(noSubscription, () => storage !== null, () => false);

  const initialRef = useRef(page);
  const titleRef = useRef(page.title);
  const langRef = useRef(initialLang);
  // 言語の変更の番号（後から別の言語を選んだら、前の変更の結果では戻さない）
  const langChangeRef = useRef(0);
  // 保存の部品が生きているか（画面を離れたあとに、言語の結果で状態を変えない）
  const aliveRef = useRef(false);
  // 本文が変わったことを知らせる先（情報パネルの文字数）
  const [textListeners] = useState(() => new Set<() => void>());
  const readyRef = useRef(ready);
  const unreadableRef = useRef(false);
  const composingRef = useRef(false);
  const editorRef = useRef<Editor | null>(null);
  const saverRef = useRef<PageSaver | null>(null);
  const autosaveRef = useRef<Autosave<PageBody> | null>(null);
  const keeperRef = useRef<DraftKeeper | null>(null);
  const eventsRef = useRef<PageEditorEvents>(props);
  // AI の箱（src/components/AiBox.tsx）。頼む前の保存と、結果を載せるのは保存の部品を通す（src/lib/ai-bridge.ts）
  const [ai, setAi] = useState<AiOpenRequest | null>(null);
  const aiDeps: AiBridgeDeps = {
    editor: () => editorRef.current,
    saver: () => saverRef.current,
    autosave: () => autosaveRef.current,
    usable: () => readyRef.current && !unreadableRef.current,
    isComposing: () => composingRef.current || Boolean(editorRef.current?.view.composing),
    currentTitle: () => titleRef.current,
    showTitle: (value) => {
      titleRef.current = value;
      setTitle(value);
      eventsRef.current.onTitleChange?.(value);
    },
    onSaved: () => eventsRef.current.onSaved?.(),
  };
  // 箱が開き直さないよう同じものを渡し続ける（どの部品も呼んだ時点の ref を読む）
  const [aiBridge] = useState<AiBridge>(() => ({
    prepare: () => prepareAi(aiDeps),
    replace: (page, options) => replaceForAi(aiDeps, page, options),
  }));
  const openAi = (range: AiOpenRequest["range"]) => setAi((current) => ({ key: (current?.key ?? 0) + 1, range }));

  useEffect(() => {
    eventsRef.current = props;
  });

  useEffect(() => {
    const initial = initialRef.current;
    const isComposing = () => composingRef.current || Boolean(editorRef.current?.view.composing);
    const saver = createPageSaver({
      pageId: initial.id,
      revision: initial.revision ?? UNCREATED_REVISION,
      content: { title: initial.title, blocks: initial.blocks, lang: initial.lang ?? DEFAULT_PAGE_LANG },
      onCreated: (created) => {
        setPageId(created.id);
        eventsRef.current.onCreated?.(created.id);
      },
    });
    let keeper: DraftKeeper | null = null;
    const autosave = createAutosave<PageBody>({
      save: (patch, context) => saver.save(patch, context),
      isComposing,
      classify: classifySaveFailure,
      onState: (next, error) => {
        setState(next);
        if (next === "stopped" && error instanceof PageConflictError) setConflict(error.page);
      },
      onSaved: (idle) => {
        setConflict(null);
        // 新しいページを作った → 以後の下書きはそのページの id に書く（作る前の枠の下書きは消す。まだ届いていない変更は持っていく）
        if (saver.pageId !== null) keeper?.rekey(saver.pageId, !idle);
        // 今の内容が全てサーバーにある → 下書きは要らない。保存の最中に入力があった → 新しい revision の上で書き直す
        if (idle) keeper?.discard();
        else keeper?.touch();
        eventsRef.current.onSaved?.();
      },
    });
    if (storage) {
      keeper = createDraftKeeper({
        storage,
        pageId: initial.id ?? NEW_PAGE_DRAFT_KEY,
        isComposing,
        read: () => ({
          baseRevision: saver.revision,
          title: titleRef.current,
          blocks: editorRef.current?.getJSON().content ?? initial.blocks,
          lang: langRef.current,
        }),
        onResult: (ok) => setDraftsKept(ok),
      });
    }
    saverRef.current = saver;
    autosaveRef.current = autosave;
    keeperRef.current = keeper;
    const unregisterSaveNow = eventsRef.current.registerSaveNow?.(() => autosave.saveNow());
    aliveRef.current = true;

    // タブを閉じる・隠れる瞬間。下書きの書き込みを先に起こし（終わりを待たない）、保存を keepalive で試す。
    // どちらも完了の保証は無い。閉じたあとに届かなかった分は、次に開いたときに下書きから戻す。
    const hide = () => {
      // まだ保存されていない変更があれば、前に書いた分があっても書き直す（同じページの別のタブに消されていても戻す）
      keeper?.writeNow(autosave.hasPending());
      void autosave.flush({ keepalive: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event)) return;
      // ブラウザの「ページを保存」を出さず、自動保存を今送る（変換中は確定を待つ）
      event.preventDefault();
      void autosave.flush();
    };
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      unregisterSaveNow?.();
      aliveRef.current = false;
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", onKeyDown);
      // 画面を離れるとき（一覧へ戻るなど）は 1 秒を待たずに保存を送る（前の保存の最中なら、その直後に）
      keeper?.writeNow(autosave.hasPending());
      keeper?.dispose();
      autosave.close();
    };
  }, [storage]);

  const editor = useEditor({
    // 画像（#33）はアップロードの口と、入れる先のページを渡す。この関数は画像を入れるとき（操作のとき）だけ呼ばれ、
    // 描画には使わない（新しいページの id は最初の保存で決まるので、保存の部品から読む）
    // eslint-disable-next-line react-hooks/refs -- 描画中には読まない（画像を入れる操作の中だけ）
    extensions: buildPageExtensions({ images: pageImages, pageId: () => saverRef.current?.pageId ?? initialRef.current.id }),
    content: docFromBlocks(page.blocks),
    // 下書きを読み終えるまでは書けない
    editable: storage === null,
    // サーバーで描かずにブラウザで作る（hydration のずれを避ける）
    immediatelyRender: false,
    // 読めない本文を空として上書きしない
    enableContentCheck: true,
    onContentError: () => {
      unreadableRef.current = true;
      setUnreadable(true);
    },
    editorProps: { attributes: { class: "doc", role: "textbox", "aria-label": "本文", "aria-multiline": "true" }, transformPastedHTML: normalizePastedHtml },
    onUpdate: ({ editor: current }) => {
      if (unreadableRef.current) return;
      // 入力のたびに本文を JSON にしない（送る・端末に書く直前にだけ getJSON する）
      autosaveRef.current?.change({ blocks: () => current.getJSON().content ?? [] });
      keeperRef.current?.touch();
      textListeners.forEach((listener) => listener());
    },
  });

  useEffect(() => {
    editorRef.current = editor;
    textListeners.forEach((listener) => listener());
  }, [editor, textListeners]);

  // 開いたとき: 端末の下書きを読み、サーバーのページと比べる
  useEffect(() => {
    // 置き場が無ければ、はじめから書ける（ready）
    if (!editor || !storage || readyRef.current) return;
    const initial = initialRef.current;
    const keeper = keeperRef.current;
    const autosave = autosaveRef.current;
    const saver = saverRef.current;
    const finish = () => {
      readyRef.current = true;
      setReady(true);
    };
    if (!autosave || !saver) return;
    if (unreadableRef.current) {
      // 読めない本文の上に下書きを載せない（下書きにも書かない）
      keeper?.disable();
      finish();
      return;
    }
    let cancelled = false;
    void readDraft(storage, initial.id ?? NEW_PAGE_DRAFT_KEY).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        // 読めなかった下書きを上書きしないよう、この画面では端末に書かない
        keeper?.disable();
        setDraftsKept(false);
        finish();
        return;
      }
      // 新しいページは、空のページ（作る前の revision）と比べる
      const openedLang = initial.lang ?? DEFAULT_PAGE_LANG;
      const decision = decideRestore(result.draft, { title: initial.title, blocks: initial.blocks, revision: initial.revision ?? UNCREATED_REVISION, lang: openedLang });
      if (result.draft) keeper?.adopt(result.draft);
      if (decision.action === "discard") {
        keeper?.discard();
      } else if (decision.action === "load" || decision.action === "conflict") {
        const { draft } = decision;
        if (!loadDraft(editor, draft)) {
          keeper?.disable();
          setDraftsKept(false);
          finish();
          return;
        }
        textListeners.forEach((listener) => listener());
        titleRef.current = draft.title;
        setTitle(draft.title);
        eventsRef.current.onTitleChange?.(draft.title);
        // 下書きの言語（言語を持つ前の下書きなら、読み込んだときの言語のまま）。違うときだけ保存に載せる
        const draftLang = draft.lang ?? openedLang;
        langRef.current = draftLang;
        setLang(draftLang);
        const langPatch = draftLang !== openedLang ? { lang: draftLang } : {};
        const blocks = () => editor.getJSON().content ?? [];
        if (decision.action === "load" || initial.id === null) {
          // 届いていなかった下書きを保存し直す（新しいページは、比べるサーバーのページが無いので、下書きでページを作る）
          autosave.change({ title: draft.title, blocks, ...langPatch });
        } else {
          // サーバーが先へ進んでいる: 自分の本文（下書き）を出したまま、自動保存を止めて帯を出す
          saver.rebase(draft.baseRevision);
          autosave.stop();
          autosave.change({ title: draft.title, blocks, ...langPatch });
          setConflict({ title: initial.title, blocks: initial.blocks, revision: initial.revision, updatedAt: initial.updatedAt, lang: openedLang });
        }
      }
      finish();
    });
    return () => {
      cancelled = true;
    };
  }, [editor, storage, textListeners]);

  useEffect(() => {
    if (editor) editor.setEditable(ready && !unreadable, false);
  }, [editor, ready, unreadable]);

  useEffect(() => {
    if (!props.createOnOpen || page.id !== null || pageId !== null || !ready || !editor || unreadable) return;
    const autosave = autosaveRef.current;
    if (!autosave) return;
    // 復元済みの下書きや、作成中の入力も既存の保存キューを通す。空のページも入力を待たずに作る。
    if (!autosave.hasPending()) autosave.change({ title: titleRef.current, blocks: () => editor.getJSON().content ?? [] });
    void autosave.flush();
  }, [props.createOnOpen, page.id, pageId, ready, editor, unreadable]);

  // 枠のヘッダー（状態の丸と「…」）と情報パネルへ、このページを登録する。「…」の操作（共有・書き出し・履歴・複製・削除）は、この flush で
  // まだ届いていない変更を先に保存し、届かなければ止める。下書きを読み終えるまでと、まだ作っていないページは id を渡さない
  // （「…」を出さない。読み終える前に操作すると、あとから載せる下書きが操作に入らないため）。画面を離れたら外す。
  // 版に戻すときは revision（今の本文がもとにしている revision）を送り、戻したら reopen でこの画面ごと開き直す
  const flush = useCallback(async () => (await autosaveRef.current?.settle()) === "saved", []);
  const revision = useCallback(() => {
    const saver = saverRef.current;
    return saver && saver.pageId !== null ? saver.revision : null;
  }, []);
  // 版に戻して開き直すとき、言語は今の画面のものを持っていく（版に戻しても言語は変わらない）
  const reopenHere = useCallback((restored: RestoredPage) => reopen(restored, langRef.current), [reopen]);

  // 情報パネルの言語。題名・本文と同じ自動保存に載せて今送り、届かなければサーバーが持っている言語に戻す
  const changeLang = useCallback(
    (next: PageLang) => {
      const autosave = autosaveRef.current;
      const saver = saverRef.current;
      if (!autosave || !saver || !aliveRef.current || !readyRef.current || next === langRef.current) return;
      const previous = langRef.current;
      langRef.current = next;
      setLang(next);
      setLangNote(null);
      autosave.change({ lang: next });
      keeperRef.current?.touch();
      const change = ++langChangeRef.current;
      void autosave.settle().then((state) => {
        // 後から別の言語を選んだ（その結果に任せる）・画面を離れた
        if (change !== langChangeRef.current || !aliveRef.current || autosaveRef.current !== autosave) return;
        // settle は終わったときの保存の状態を返す（全て届いたら saved）
        if (state === "saved") {
          eventsRef.current.onLangChange?.(saver.content.lang ?? langRef.current);
          return;
        }
        // 届かなかった（オフライン・ログイン切れ・競合・サーバーの失敗）。サーバーが持っている言語に戻し、それも同じ保存に載せる
        // （届いたか分からない失敗でも、次に届いたときにサーバーを画面の言語に揃える）
        const back = saver.content.lang ?? previous;
        if (back === langRef.current) return;
        langRef.current = back;
        setLang(back);
        setLangNote(LANG_NOT_SAVED);
        autosave.change({ lang: back });
        keeperRef.current?.touch();
      });
    },
    [],
  );

  // 本文の文字（情報パネルの文字数。開いているあいだだけ読む）
  const text = useMemo<PageText>(
    () => ({
      read: () => editorRef.current?.getText({ blockSeparator: "\n" }) ?? "",
      subscribe: (onChange) => {
        textListeners.add(onChange);
        return () => {
          textListeners.delete(onChange);
        };
      },
    }),
    [textListeners],
  );

  const status = statusOf(state);
  useEffect(
    () => attachPage({ id: ready ? pageId : null, status, flush, revision, reopen: reopenHere, shared, setShared, lang, setLang: changeLang, langNote, text }),
    [attachPage, ready, pageId, status, flush, revision, reopenHere, shared, setShared, lang, changeLang, langNote, text],
  );

  const overwrite = () => {
    const saver = saverRef.current;
    const autosave = autosaveRef.current;
    const current = editorRef.current;
    if (!conflict || !saver || !autosave) return;
    saver.overwriteOnto(conflict);
    // 題名と本文の全てを送る（題名だけの競合でも、見えている本文がそのまま保存される）。
    // 言語は、相手の言語が分かっていて画面の言語と違うときだけ送る（画面に出している言語で上書きする）
    autosave.change({
      title: titleRef.current,
      ...(conflict.lang !== undefined && conflict.lang !== langRef.current ? { lang: langRef.current } : {}),
      ...(current && !unreadableRef.current ? { blocks: () => current.getJSON().content ?? [] } : {}),
    });
    autosave.resume();
  };

  const copyBody = async (): Promise<boolean> => {
    const body = editorRef.current?.getText({ blockSeparator: "\n\n" }) ?? "";
    const text = [titleRef.current, body].filter((part) => part.trim().length > 0).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };

  return (
    <div
      ref={setRoot}
      data-docs-app-root=""
      data-docs-shared-ui=""
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
        keeperRef.current?.compositionEnded();
      }}
    >
      {/* 見える文字だけ。読み上げはヘッダーの状態の丸（aria-live）が持つので、ここは live region にしない（二重に読み上げない） */}
      <p data-save-state={status} data-drafts={hasStorage && draftsKept ? "kept" : "none"}>
        {SAVE_STATUS_TEXT[status]}
      </p>
      <AiEntry expanded={ai !== null} onOpen={() => (ai?.range === null ? setAi(null) : openAi(null))} />
      {conflict && <ConflictBand page={conflict} overwriting={state === "saving"} container={root} onCopy={copyBody} onOverwrite={overwrite} />}
      <PageTitle
        value={title}
        editor={editor}
        onChange={(input) => {
          if (!readyRef.current) return;
          // サーバーが受けない長さの題名を自動保存に載せない（失敗した変更は残って本文の保存も止めるため）。上限で止めて知らせる
          const chars = Array.from(input);
          const value = chars.length > MAX_TITLE_CHARS ? chars.slice(0, MAX_TITLE_CHARS).join("") : input;
          setTitleClamped(value !== input);
          setTitle(value);
          titleRef.current = value;
          eventsRef.current.onTitleChange?.(value);
          autosaveRef.current?.change({ title: value });
          keeperRef.current?.touch();
        }}
      />
      {titleClamped && <p role="status">題名は {MAX_TITLE_CHARS} 字までです。</p>}
      {unreadable && <p role="alert">本文を読み込めませんでした。この画面では本文を変更しません。</p>}
      <div className="be">
        <EditorContent editor={editor} />
        {/* ヘッダーに常設の書式の帯（ShellTools）を出すため、本文の操作を枠へ渡す（#37 T9） */}
        <PageChrome editor={editor} onAi={() => editor && openAi(selectionRange(editor.state))} onTools={registerTools} />
      </div>
      <AiLayer editor={editor} bridge={aiBridge} kind={page.kind ?? "note"} lang={page.lang ?? "ja"} request={ai} onClose={() => setAi(null)} />
    </div>
  );
}
