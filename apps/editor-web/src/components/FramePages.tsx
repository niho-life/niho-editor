"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { PageSummary } from "@niho/editor-store";
import { ShellLocation, ShellSettingsPage } from "niho-docs-ui/shell";
import { rememberLastPage } from "@/lib/last-page";
import { addLeftEmptyCandidate, isRetryableDiscardError, isTabCreatedPage, markTabCreatedPage } from "@/lib/left-empty-pages";
import { discardPageRequest, readPageRequest, type ConflictPage } from "@/lib/pages-client";
import { locationOf } from "@/lib/sidebar-items";
import { isNarrowNow, useEditorFrame } from "./EditorFrame";
import { FolderPage } from "./FolderPage";
import { FlowWatcher } from "./FlowWatcher";
import { PageEditor } from "./PageEditor";
import { PageTabs, type OpenPageTab } from "./PageTabs";
import { RecordingInfo } from "./RecordingInfo";
import { RecordingTranscript } from "./RecordingTranscript";

export { RecordingStartScreen } from "./RecordingStartScreen";
export type { OpenPageTab };

/** `/`。デスクトップでは最後に開いたページ（無ければ新しいページ）へ移る。狭い画面では一覧がこの画面なので何もしない。 */
export function HomeRedirect({ lastPageId }: { lastPageId: string | null }) {
  const router = useRouter();
  const { narrow } = useEditorFrame();
  useEffect(() => {
    if (narrow || isNarrowNow()) return;
    router.replace(lastPageId ? `/p/${lastPageId}` : "/p/new");
  }, [narrow, lastPageId, router]);
  return null;
}

/**
 * 何も足していないページを離れたとき（このタブの「新しいページ」で作ったページだけ。オーナー決定 2026-11-05）。
 * - 画面の中の移動（別のページ・画面へ）: すぐサーバーへ「空なら捨てる」を頼み、消えたら一覧から外す。届かなければ捨てる候補に残す。
 * - `pagehide`（タブを閉じる・再読み込み・別のサイトへ）: その場では捨てず、捨てる候補に足すだけ。再読み込みの `GET /p/{id}` と
 *   すれ違うと、開いているページがサーバーでは消えている状態になるため。次にアプリを開いたとき、EditorFrame が今のページ以外を捨てる。
 * 空かどうかはサーバーが確かめる（src/lib/left-empty-pages.ts）。
 */
function useLeftEmpty(): (id: string, options: { keepalive: boolean }) => void {
  const { pageRemoved } = useEditorFrame();
  return useCallback(
    (id: string, { keepalive }: { keepalive: boolean }) => {
      if (keepalive) {
        addLeftEmptyCandidate(id);
        return;
      }
      void discardPageRequest(id).then(
        (discarded) => {
          if (discarded) pageRemoved(id);
        },
        (error: unknown) => {
          if (isRetryableDiscardError(error)) addLeftEmptyCandidate(id);
        },
      );
    },
    [pageRemoved],
  );
}

/**
 * `/p/{id}`。最後に開いたページとして覚え、題名と保存を一覧へ知らせる。revision は読み込んだときの値（保存の `baseRevision`）、
 * 更新時刻は開いたときに端末の下書きと競合したら帯に出す値。shared はリンクで共有しているか（サーバーが読んだ値。読めなければ null。
 * 「…」の「共有中」の印だけに使い、リンクそのものは渡さない）。recordingSec は録音ページの録音の長さ（秒。情報パネルに出す。
 * 録音ページでない・読めなければ null）。情報パネルで言語を変えて保存したら、一覧の言語も替える。
 *
 * 手順（#37）の段階のページを開いている間にその段階が終わると、worker が本文を入れ替えて revision を進める。
 * そのときはページを読み直し、エディタを**開き直す**（key を替えて作り直す。保存・下書き・Undo の部品も新しくなるので、
 * 入れ替わった本文が Undo に混ざらず、自動保存も起きない。端末の下書きがあれば、開いたときと同じく比べて帯を出す）。
 *
 * tabs は同じ入れ物のタブ（本文なし。#308）。本文の上にタブの帯（./PageTabs.tsx）を出す（フォルダには出さない）。
 */
export function OpenPage({
  summary,
  tabs = [],
  blocks,
  revision,
  cover = null,
  lead = null,
  shared = null,
  recordingSec = null,
}: {
  summary: PageSummary;
  tabs?: readonly OpenPageTab[];
  blocks: unknown[];
  revision: number;
  cover?: string | null;
  lead?: string | null;
  shared?: boolean | null;
  recordingSec?: number | null;
}) {
  const frame = useEditorFrame();
  const { pageOpened, pageSaved } = frame;
  const { id } = summary;
  // エディタの「今すぐ保存して待つ」（タブの複製・削除の前に使う。枠にも同じものを渡す）
  const saverRef = useRef<(() => Promise<boolean>) | null>(null);
  const saveNow = useCallback(() => saverRef.current?.() ?? Promise.resolve(true), []);
  const registerSaveNow = useCallback(
    (saveNow: () => Promise<boolean>) => {
      saverRef.current = saveNow;
      const off = frame.registerPageSaver(saveNow);
      return () => {
        if (saverRef.current === saveNow) saverRef.current = null;
        off();
      };
    },
    [frame],
  );
  // このタブの「新しいページ」で作ったページ（再読み込みで開き直したとき）は、何も足さずに離れたら捨てる。既存のページは対象にしない
  const tabCreated = useMemo(() => isTabCreatedPage(id), [id]);
  const leftEmpty = useLeftEmpty();
  // 手順の段階が終わって読み直した本文（count が増えるとエディタを作り直す）。どのページの分かも持ち、
  // 別のページへ移ったら使わない（この部品は画面の移動で作り直されないことがある）
  const [replaced, setReplaced] = useState<{ count: number; id: string; page: ConflictPage } | null>(null);
  useEffect(() => {
    rememberLastPage(summary.id);
    pageOpened(summary, { recordingSec });
  }, [summary, recordingSec, pageOpened]);

  const onBodyReplaced = useCallback(() => {
    readPageRequest(id).then(
      (page) => setReplaced((current) => ({ count: (current?.count ?? 0) + 1, id, page })),
      // 読めなければエディタはそのまま（帯の「済み」だけが先に出る。次に開いたときに入れ替わった本文が出る）
      () => undefined,
    );
    // サーバーの更新時刻が進んだので、一覧の行も動かす
    pageSaved(id);
  }, [id, pageSaved]);

  // 狭い画面（720px 以下）の場所（親のフォルダ › 親の録音）。題名の上の 1 行（広い画面ではヘッダーに出し、ここは CSS で隠す）
  const location = useMemo(() => {
    const pages = frame.pages ?? [];
    return locationOf(pages.some((page) => page.id === id) ? pages : [...pages, summary], id);
  }, [frame.pages, id, summary]);
  const aboveTitle = location.length > 0 ? <ShellLocation items={location} onOpen={frame.openPage} place="body" /> : null;

  const fresh = replaced?.id === id ? replaced : null;
  const current = fresh?.page;
  const pageCover = current ? current.cover ?? null : cover;
  const pageLead = current ? current.lead ?? null : lead;
  // フォルダは本文のエディタを出さず、中身の一覧と「新しいページ」「録音から」だけ（§3.2）
  if (summary.kind === "folder") return <FolderPage summary={summary} revision={current?.revision ?? revision} aboveTitle={aboveTitle} />;
  const editor = (
    <PageEditor
      key={fresh?.count ?? 0}
      aboveTitle={aboveTitle}
      page={{
        id,
        title: current?.title ?? summary.title,
        blocks: current?.blocks ?? blocks,
        cover: pageCover,
        lead: pageLead,
        revision: current?.revision ?? revision,
        updatedAt: current?.updatedAt ?? summary.updatedAt,
        kind: summary.kind,
        lang: current?.lang ?? summary.lang,
      }}
      shared={shared}
      onTitleChange={(value) => frame.pageTitleChanged(id, value)}
      onSaved={() => frame.pageSaved(id)}
      registerSaveNow={registerSaveNow}
      onLangChange={(lang) => frame.pageLangChanged(id, lang)}
      onLeftEmpty={
        tabCreated
          ? (left, options) => {
              if (left === id) leftEmpty(left, options);
            }
          : undefined
      }
    />
  );
  // タブの帯（#308）はページのいちばん上。流れ（#309）の状態は FlowWatcher が読み続け、「ページ」パネルに出す（本文には帯もボタンも置かない）。
  // 録音ページの文字起こし（設計 §7.1。本文の上）はその下
  return (
    <>
      <PageTabs key={`tabs-${id}`} page={summary} tabs={tabs} saveNow={saveNow} />
      <FlowWatcher pageId={id} kind={summary.kind} onBodyReplaced={onBodyReplaced} />
      {/* 録音ページ: 「この録音について」（§3.3）と、録音ブロック・見出し「文字起こし」の下の文字起こし */}
      {summary.kind === "rec" && (
        <>
          <RecordingInfo key={`info-${id}`} pageId={id} />
          <RecordingTranscript key={id} pageId={id} />
        </>
      )}
      {editor}
    </>
  );
}

/**
 * `/p/new`。作ったあと（URL は `/p/{id}`）にもう一度 `/p/new` へ来たら、新しいエディタにする
 * （同じ画面の部品が使い回されても、前に作ったページへ書かない）。
 */
export function NewPage() {
  const router = useRouter();
  const pathname = usePathname();
  const [visit, setVisit] = useState({ pathname, count: 0 });
  if (visit.pathname !== pathname) setVisit({ pathname, count: pathname === "/p/new" ? visit.count + 1 : visit.count });
  // 今のエディタが作ったページ（作ると URL がその `/p/{id}` になる）
  const created = useRef<{ count: number; id: string } | null>(null);
  // それ以外の `/p/{id}` でこの画面が出ているのは、戻る・進むで前に作ったページの履歴へ来たとき。そのページを読み直す
  useEffect(() => {
    const own = created.current?.count === visit.count ? created.current.id : null;
    if (pathname !== "/p/new" && pathname !== `/p/${own}`) router.refresh();
  }, [pathname, visit.count, router]);
  const count = visit.count;
  return <NewPageEditor key={count} onCreated={(id) => (created.current = { count, id })} />;
}

/**
 * 開いたら空でも保存してページを作り、URL を `/p/{id}` に替える（エディタは作り直さないので、変換中の文字とカーソルは残る）。
 * 作ったページはこのタブで作ったページとして覚え、何も足さないまま離れたら捨てる（useLeftEmpty）。
 */
function NewPageEditor(props: { onCreated: (id: string) => void }) {
  const frame = useEditorFrame();
  const leftEmpty = useLeftEmpty();
  const createdRef = useRef<string | null>(null);
  const titleRef = useRef("");
  const query = useSearchParams();
  const experience = query.get("experience");
  // `?in=<フォルダ>`: そのフォルダの中に作る（「新しいページ ▾」の「『◯◯』の中に」・フォルダの画面の「新しいページ」）
  const inside = query.get("in");
  const createIn = inside !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(inside) ? inside.toLowerCase() : null;
  const handoff = query.get("destination") === "exp" && query.get("lang") === "en" && (experience === null || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(experience));
  // この下書きのエディタがまだ画面にあるか。保存（POST）が終わる前に「録音から」へ移った・別の下書きへ戻ったときは、
  // URL が `/p/new` のままでも、その URL を作ったページの ID へ替えない（pathname だけでは別の画面と区別できない）
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  return (
    <PageEditor
      page={{ id: null, title: "", blocks: [], revision: null, ...(handoff ? { lang: "en" as const } : {}) }}
      createOnOpen
      createIn={createIn}
      // 作ったばかりのページは共有していない
      shared={false}
      onTitleChange={(value) => {
        titleRef.current = value;
        if (createdRef.current) frame.pageTitleChanged(createdRef.current, value);
      }}
      onCreated={(id) => {
        createdRef.current = id;
        // 再読み込みのあと `/p/{id}` で開き直しても、このタブで作ったページと分かるように
        markTabCreatedPage(id);
        props.onCreated(id);
        frame.pageCreated(id, titleRef.current, "note", createIn);
        // 保存が終わる前に別の画面へ移っていたら、その画面の URL は替えない
        if (!aliveRef.current || window.location.pathname !== "/p/new") return;
        window.history.replaceState(null, "", `/p/${id}${handoff ? `?destination=exp&lang=en${experience ? `&experience=${encodeURIComponent(experience)}` : ""}` : ""}`);
        rememberLastPage(id);
      }}
      onSaved={() => {
        if (createdRef.current) frame.pageSaved(createdRef.current);
      }}
      registerSaveNow={frame.registerPageSaver}
      onLangChange={(lang) => {
        if (createdRef.current) frame.pageLangChanged(createdRef.current, lang);
      }}
      onLeftEmpty={(id, options) => {
        if (id === createdRef.current) leftEmpty(id, options);
      }}
    />
  );
}

/** 発信先・役割とつながり・設定。今は題名だけ（中身は #41・#42 とその後）。 */
export function SettingsScreen({ title }: { title: string }) {
  return <ShellSettingsPage title={title}>{null}</ShellSettingsPage>;
}
