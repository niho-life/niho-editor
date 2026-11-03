"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  PublishSheet,
  shellPublishButton,
  shellStatus,
  type PublishDestOption,
  type PublishExtras,
  type PublishFormProps,
  type PublishRange,
  type ShellDest,
  type ShellHeaderProps,
  type ShellPublication,
} from "niho-docs-ui/shell";
import { loadPublishSheet, publishPageRequest, stopPublishingRequest, type PublishSelection, type PublishSheetDto } from "@/lib/publish-client";
import type { SidebarPublication } from "@/lib/sidebar-items";
import { PUBLISH_MESSAGES, slugMessage } from "@/publish/messages";

/**
 * 公開のシート（#39）の画面の側。状態・発信先・条件・URL はサーバー（`/api/pages/{id}/publish`。editor-publish の sheetPlan）が決め、
 * ここは docs-ui の PublishSheet の props に写すだけ。公開の前の評価・役割・slug はサーバーがもう一度確かめる。
 *
 * - 選ぶ（発信先・範囲・あわせて・URL）たびにシートのデータを読み直す（URL は打ち終わるのを少し待つ）。
 * - シートを開く前と、公開・更新を送る前に、エディタの保存待ちを送り終える（最後の入力を公開版に入れる）。保存できなければ送らない。
 * - 「直す」: シートを閉じてその欄へフォーカスを移す。リード・カバー写真は右のページ設定を開く。
 *   言語は右のページ設定、カテゴリ・関連する体験はシート内の欄へ移す。
 * - 「発信先を追加」「接続する」は発信先の設定（`/destinations`。#41）へ移る。
 * - 本人のサイトの行は docs-ui では発信先の種類ごとに 1 つなので、公開しているサイト（無ければ最初に接続したサイト）だけを出す。
 */

/** 「直す」で移る欄（editor の画面にあるもの）。 */
export type PublishFixField = "title" | "body" | "cover" | "lead" | "lang";

const WHO: Readonly<Record<ShellDest, string>> = { exp: "旅行者向け · 英語", niho: "鎌倉の人向け", site: "本人のサイト" };
const ROLE: Readonly<Record<ShellDest, string>> = { exp: "ライター", niho: "NIHO アカウント", site: "接続済み" };
const NO_EXTRAS: PublishExtras = { app: false, news: false, xp: false };
/** URL の欄は打ち終わるのを待ってから読み直す。 */
export const SLUG_CHECK_DELAY_MS = 300;
/** 保存のあと「更新あり」を確かめ直すまで（続けて保存されたらまとめる）。 */
export const SAVED_REFRESH_DELAY_MS = 1500;

const bare = (url: string | null | undefined) => (url ?? "").replace(/^https:\/\//, "");

function handoffSelection(): PublishSelection | null {
  if (typeof window === "undefined") return null;
  const query = new URLSearchParams(window.location.search);
  const experience = query.get("experience");
  if (query.get("destination") !== "exp" || query.get("lang") !== "en" || (experience !== null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(experience))) return null;
  return { handle: "exp", range: "live", extras: NO_EXTRAS, slug: null, category: null, related: experience ? [experience] : [] };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return bare(url);
  }
}

/** 一覧の 2 行目に重ねる公開の状態。 */
export function sidebarPublicationOf(sheet: PublishSheetDto): SidebarPublication | null {
  const publication = sheet.publication;
  return publication ? { dest: publication.dest, handle: publication.handle, range: publication.range, stopped: publication.stopped } : null;
}

/** ヘッダーの状態の丸と公開ボタンが読む形。 */
export function shellPublicationOf(sheet: PublishSheetDto | null): ShellPublication | null {
  const publication = sheet?.publication;
  if (!sheet || !publication) return null;
  return { dest: publication.dest, range: publication.stopped ? "stopped" : publication.range, updated: sheet.status === "updated", url: bare(publication.url) };
}

/** 発信先の行。役割で出せない面は出さない。宣言の読めない発信先は「いまは公開できません」で押せない行。 */
export function destOptionsOf(sheet: PublishSheetDto | null): { options: PublishDestOption[]; site: string | null } {
  const list = sheet?.destinations ?? [];
  const optionOf = (entry: PublishSheetDto["destinations"][number]): PublishDestOption => ({
    id: entry.dest,
    label: entry.label,
    who: WHO[entry.dest],
    url: bare(entry.url),
    role: ROLE[entry.dest],
    connected: entry.available,
    ...(entry.available ? {} : { note: PUBLISH_MESSAGES.unavailable }),
  });
  const options = list.filter((entry) => entry.dest === "exp" && entry.reason !== "role").map(optionOf);
  const sites = list.filter((entry) => entry.dest === "site");
  const site = sites.find((entry) => entry.handle === sheet?.publication?.handle) ?? sites[0];
  options.push(site ? optionOf(site) : { id: "site", label: "自分のサイト", who: WHO.site, url: "", role: ROLE.site, connected: false });
  return { options, site: site?.handle ?? null };
}

/** 主ボタンの文言（省略は docs-ui の既定: 公開する／更新を公開／保存）。 */
export function actionOf(sheet: PublishSheetDto | null): string | undefined {
  if (!sheet) return undefined;
  const live = sheet.publication !== null && !sheet.publication.stopped;
  if (live && sheet.changesDestination) return "発信先を変える";
  if (sheet.primary === "publish") return "公開する";
  if (sheet.primary === "update") return "更新を公開";
  if (sheet.primary === "save") return "保存";
  return undefined;
}

function stopDetailOf(sheet: PublishSheetDto | null): string {
  const publication = sheet?.publication;
  if (!publication) return "";
  return publication.dest === "site"
    ? `${publication.label} の公開 API から消え、ページは自分だけに戻ります。URL の転送はサイトの側で行ってください。もう一度公開すると同じ URL になります。`
    : `${publication.label} から消え、URL は ${publication.label} の一覧へ転送されます。ページは自分だけに戻り、もう一度公開すると同じ URL になります。`;
}

/** 「直す」: 開いているページの題名か本文へフォーカスを移す。 */
export function focusPageField(field: PublishFixField): void {
  const main = document.getElementById("es-main");
  const target =
    field === "title"
      ? main?.querySelector<HTMLElement>("textarea.page-title")
      : field === "body"
        ? main?.querySelector<HTMLElement>('.doc[contenteditable="true"]')
        : document.querySelector<HTMLElement>(field === "cover" ? "[data-page-cover]" : field === "lead" ? "[data-page-lead]" : "[data-page-lang]");
  if (!target) return;
  target.focus();
  target.scrollIntoView?.({ block: "nearest" });
}

type View = { kind: "closed" } | { kind: "publish" } | { kind: "stop" } | { kind: "done"; url: string };

type State = {
  pageId: string | null;
  sheet: PublishSheetDto | null;
  loadError: string | null;
  view: View;
  selection: PublishSelection | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
};

type ExperienceOptionsState = {
  categories: { slug: string; labelEn: string; labelJa: string }[];
  candidates: { slug: string; title: string; providerName: string }[];
  unavailable: boolean;
  loaded: boolean;
  query: string;
  nextCursor: string | null;
  loadingMore: boolean;
};

const EMPTY_EXPERIENCE_OPTIONS: ExperienceOptionsState = {
  categories: [], candidates: [], unavailable: false, loaded: false, query: "", nextCursor: null, loadingMore: false,
};

const initialState = (pageId: string | null): State => ({
  pageId,
  sheet: null,
  loadError: null,
  view: { kind: "closed" },
  selection: null,
  loading: false,
  busy: false,
  error: null,
});

export type PagePublishUi = {
  status?: ShellHeaderProps["status"];
  publish?: ShellHeaderProps["publish"];
  overlay?: ReactNode;
  /** そのページを保存した（公開中なら、少し待って「更新あり」を確かめ直す）。 */
  pageSaved: (id: string) => void;
  /** 公開のシートを開く（⌘⇧P・useEditorFrame().openPublish）。ページが無ければ何もしない。 */
  open: () => void;
  /** 公開のシートが（確認・結果の画面も含めて）開いているか。開いているあいだは ⌘N・⌘K を効かせない。 */
  shown: boolean;
};

/**
 * 開いているページのヘッダーの状態・公開ボタンと、公開のシート（EditorShell の overlay）。EditorFrame が持つ
 * （シートの入力と状態を同じ木に置き、閉じたあとのフォーカスの順番を決めるため）。pageId が替われば最初からやり直す。
 */
export function usePagePublish(input: {
  pageId: string | null;
  isArticle: boolean;
  /** 公開の状態が分かった・変わった（一覧の 2 行目へ）。 */
  onPublication: (id: string, publication: SidebarPublication | null) => void;
  onNavigate: (path: string) => void;
  /** エディタの保存待ちを今すぐ送り、届き終わるのを待つ。全て保存できたら true。 */
  saveFirst: () => Promise<boolean>;
  /** 「直す」の欄が右のページ設定にあるとき、シートを閉じるのと同時に開く。 */
  revealField?: (field: PublishFixField) => void;
}): PagePublishUi {
  const { pageId, isArticle } = input;
  const [state, setState] = useState<State>(() => initialState(pageId));
  const [experienceOptions, setExperienceOptions] = useState<ExperienceOptionsState>(EMPTY_EXPERIENCE_OPTIONS);
  const experienceOptionsRequested = useRef(false);
  const experienceOptionsSequence = useRef(0);
  const pendingSheetFix = useRef<"category" | "related" | null>(null);
  const current = state.pageId === pageId ? state : initialState(pageId);
  if (state.pageId !== pageId) setState(current);

  const events = useRef(input);
  useEffect(() => {
    events.current = input;
  });
  useEffect(() => {
    if (current.view.kind !== "publish" || current.selection?.handle !== "exp" || experienceOptionsRequested.current) return;
    experienceOptionsRequested.current = true;
    const mine = ++experienceOptionsSequence.current;
    void fetch("/api/account/experience-options", { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
      if (!response.ok) throw new Error();
      const value = await response.json() as Pick<ExperienceOptionsState, "categories" | "candidates" | "nextCursor">;
      if (mine === experienceOptionsSequence.current) setExperienceOptions({ ...value, unavailable: false, loaded: true, query: "", loadingMore: false });
    }).catch(() => {
      if (mine === experienceOptionsSequence.current) setExperienceOptions({ ...EMPTY_EXPERIENCE_OPTIONS, unavailable: true, loaded: true });
    });
  }, [current.selection?.handle, current.view.kind]);

  const loadExperienceOptions = useCallback((query: string, cursor: string | null = null) => {
    const mine = ++experienceOptionsSequence.current;
    setExperienceOptions((before) => ({ ...before, query, unavailable: false, loadingMore: true }));
    const search = new URLSearchParams();
    if (query) search.set("q", query);
    if (cursor) search.set("cursor", cursor);
    const suffix = search.size === 0 ? "" : `?${search.toString()}`;
    void fetch(`/api/account/experience-options${suffix}`, { cache: "no-store", credentials: "same-origin" }).then(async (response) => {
      if (!response.ok) throw new Error();
      const value = await response.json() as Pick<ExperienceOptionsState, "categories" | "candidates" | "nextCursor">;
      if (mine !== experienceOptionsSequence.current) return;
      setExperienceOptions((before) => ({
        ...value,
        candidates: cursor ? [...before.candidates, ...value.candidates.filter((item) => !before.candidates.some((existing) => existing.slug === item.slug))] : value.candidates,
        unavailable: false, loaded: true, query, loadingMore: false,
      }));
    }).catch(() => {
      if (mine === experienceOptionsSequence.current) setExperienceOptions((before) => ({ ...before, unavailable: true, loaded: true, loadingMore: false }));
    });
  }, []);
  useEffect(() => {
    const field = pendingSheetFix.current;
    if (current.view.kind !== "publish" || field === null) return;
    const target = document.querySelector<HTMLElement>(`[data-publish-field="${field}"]`);
    if (!target) return;
    pendingSheetFix.current = null;
    target.focus();
    target.scrollIntoView?.({ block: "nearest" });
  }, [current.view.kind, experienceOptions]);
  const seq = useRef(0);
  // ページを替えるたびに進める。保存を待っているあいだにページを替えたら、前のページの読み込みを始めない
  const pageEpoch = useRef(0);
  const selectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFix = useRef<PublishFixField | null>(null);
  const stateRef = useRef(current);
  useEffect(() => {
    stateRef.current = current;
  });

  /** そのページの状態だけを変える（別のページへ移ったあとに届いた応答は捨てる）。 */
  const patch = useCallback((id: string, next: Partial<State>) => {
    setState((before) => (before.pageId === id ? { ...before, ...next } : before));
  }, []);

  /** シートのデータを読む。あとから頼んだ読み込みがあれば、前の応答は捨てる。 */
  const load = useCallback(
    (id: string, selection: PublishSelection | null): Promise<PublishSheetDto | null> => {
      const mine = ++seq.current;
      return loadPublishSheet(id, selection).then((result) => {
        if (mine !== seq.current) return null;
        if (!result.ok) {
          patch(id, { loading: false, loadError: result.message });
          return null;
        }
        patch(id, { loading: false, loadError: null, sheet: result.sheet });
        events.current.onPublication(id, sidebarPublicationOf(result.sheet));
        return result.sheet;
      });
    },
    [patch],
  );

  const clearTimers = () => {
    if (selectionTimer.current) clearTimeout(selectionTimer.current);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    selectionTimer.current = null;
    savedTimer.current = null;
  };

  // 開いたページの状態（ヘッダーの丸とボタン）
  useEffect(() => {
    if (pageId === null) return;
    void load(pageId, null);
    return () => {
      seq.current += 1;
      pageEpoch.current += 1;
      clearTimers();
    };
  }, [pageId, load]);

  const open = useCallback(() => {
    if (pageId === null) return;
    clearTimers();
    patch(pageId, { view: { kind: "publish" }, error: null, loading: true });
    const epoch = pageEpoch.current;
    // 書いた直後でも、保存し終えてから読む（「更新あり」と条件を最後の入力で決める）
    void events.current
      .saveFirst()
      .then((saved) => {
        // 保存を待つあいだに別のページへ移った: 前のページの読み込みを始めない（始めると seq が進み、移った先の応答が捨てられる）
        if (epoch !== pageEpoch.current) return null;
        if (!saved) patch(pageId, { error: PUBLISH_MESSAGES.unsaved });
        // まず現在の保存状態をサーバーから読む。Experience からの手渡しは
        // まだ一度も公開していないページの初期選択に限る。
        return load(pageId, null).then((sheet) => {
          if (!sheet) return null;
          const handoff = sheet.publication === null ? handoffSelection() : null;
          return handoff === null ? sheet : load(pageId, handoff);
        });
      })
      .then((sheet) => {
        if (sheet) patch(pageId, { selection: sheet.selection });
      });
  }, [pageId, load, patch]);

  // 「直す」: シートが閉じ、シートが開いた要素へフォーカスを戻したあと（同じ commit の片付けのあと）にその欄へ移る
  useEffect(() => {
    if (current.view.kind !== "closed" || pendingFix.current === null) return;
    const field = pendingFix.current;
    pendingFix.current = null;
    // The sheet restores focus while it unmounts. Move to the revealed page
    // field after that cleanup and after the rail has rendered.
    queueMicrotask(() => focusPageField(field));
  }, [current.view.kind]);

  const pageSaved = useCallback(
    (id: string) => {
      const publication = stateRef.current.sheet?.publication;
      if (id !== pageId || !publication || publication.stopped) return;
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => {
        savedTimer.current = null;
        const now = stateRef.current;
        void load(id, now.view.kind === "publish" ? now.selection : null);
      }, SAVED_REFRESH_DELAY_MS);
    },
    [pageId, load],
  );

  if (pageId === null) return { pageSaved, open, shown: false };

  const { sheet, view, selection, loading, busy, error, loadError } = current;
  const { options, site } = destOptionsOf(sheet);

  const change = (next: PublishSelection, delay = 0) => {
    if (selectionTimer.current) clearTimeout(selectionTimer.current);
    patch(pageId, { selection: next, error: null, loading: true });
    if (delay === 0) {
      void load(pageId, next);
      return;
    }
    selectionTimer.current = setTimeout(() => {
      selectionTimer.current = null;
      void load(pageId, next);
    }, delay);
  };

  const pick = (dest: ShellDest) => {
    const handle = dest === "site" ? site : dest;
    if (handle === null) return;
    const same = sheet?.publication?.handle === handle ? sheet.publication : null;
    // 本人のサイトは限定公開を持たない（範囲の欄も出ない）
    const range: PublishRange = dest === "site" ? "live" : (same?.range ?? selection?.range ?? "live");
    // あわせて載せる先（アプリ・ニュース・体験ページ）は発信先ごと。別の発信先へは持ち越さない（持ち越すと、その発信先に無い
    // 項目が入ったままになり、チェックも外せず公開できない）。同じ発信先を選び直したときだけ、選んでいたものを残す
    const extras = same?.extras ?? (selection?.handle === handle ? selection.extras : NO_EXTRAS);
    change({ handle, range, extras, slug: null, category: same && selection?.handle === handle ? selection.category : null, related: same && selection?.handle === handle ? selection.related : [] });
  };

  const close = () => {
    clearTimers();
    patch(pageId, { view: { kind: "closed" }, error: null });
  };

  const submit = async () => {
    if (!sheet || !selection || busy || loading || sheet.primary === null) return;
    clearTimers();
    patch(pageId, { busy: true, error: null });
    // 最後の入力を公開版に入れる。保存できなければ送らない（前の公開版はそのまま）
    if (!(await events.current.saveFirst())) {
      patch(pageId, { busy: false, error: PUBLISH_MESSAGES.unsaved });
      return;
    }
    const result = await publishPageRequest(pageId, {
      handle: selection.handle,
      range: selection.range,
      extras: selection.extras,
      category: selection.category,
      related: selection.related,
      ...(sheet.slug.editable && sheet.slug.value !== null ? { slug: selection.slug ?? sheet.slug.value } : {}),
    });
    if (!result.ok) {
      patch(pageId, { busy: false, error: result.message });
      void load(pageId, selection);
      return;
    }
    patch(pageId, { busy: false, view: { kind: "done", url: result.published.url } });
    void load(pageId, null);
  };

  const stop = async () => {
    if (busy) return;
    patch(pageId, { busy: true, error: null });
    const result = await stopPublishingRequest(pageId);
    if (!result.ok) {
      patch(pageId, { busy: false, error: result.message });
      return;
    }
    patch(pageId, { busy: false, view: { kind: "closed" } });
    void load(pageId, null);
  };

  const fix = (key: string) => {
    const problem = sheet?.problems[Number(key)];
    if (!problem) return;
    if (problem.fix === "category" || problem.fix === "related") {
      const target = document.querySelector<HTMLElement>(`[data-publish-field="${problem.fix}"]`);
      if (target) {
        target.focus();
        target.scrollIntoView?.({ block: "nearest" });
      } else {
        // Options may still be loading. Focus as soon as the authoritative
        // category/candidate response makes the field available.
        pendingSheetFix.current = problem.fix;
      }
      return;
    }
    const field: PublishFixField | null =
      problem.id === "title" || problem.id === "step-title"
        ? "title"
        : problem.fix === "body" || problem.fix === "cover" || problem.fix === "lead"
          ? problem.fix
          : problem.fix === "lang"
            ? "lang"
          : null;
    if (field === null) {
      patch(pageId, { error: PUBLISH_MESSAGES.noField });
      return;
    }
    pendingFix.current = field;
    events.current.revealField?.(field);
    close();
  };

  const toDestinations = () => {
    close();
    events.current.onNavigate("/destinations");
  };

  const selectedDest: ShellDest | undefined =
    selection === null ? undefined : selection.handle === "exp" || selection.handle === "niho" ? selection.handle : selection.handle === site ? "site" : undefined;
  const selectionError = sheet?.storageBlock ? PUBLISH_MESSAGES.storageNotCloud : sheet?.selectionError === "range" ? PUBLISH_MESSAGES.rangeNotOffered : sheet?.selectionError === "extras" ? PUBLISH_MESSAGES.extrasNotOffered : null;
  const live = sheet?.publication && !sheet.publication.stopped ? sheet.publication : null;

  let overlay: ReactNode = null;
  if (view.kind === "done") {
    const url = view.url;
    overlay = (
      <PublishSheet
        kind="done"
        host={hostOf(url)}
        url={bare(url)}
        onView={() => window.open(url, "_blank", "noopener,noreferrer")}
        onCopy={() => void navigator.clipboard?.writeText(url).catch(() => undefined)}
        onClose={close}
      />
    );
  } else if (view.kind === "stop") {
    overlay = (
      <PublishSheet
        kind="stop"
        dest={sheet?.publication?.label ?? ""}
        detail={stopDetailOf(sheet)}
        busy={busy}
        error={error}
        onConfirm={() => void stop()}
        onCancel={() => patch(pageId, { view: { kind: "publish" }, error: null })}
        onClose={close}
      />
    );
  } else if (view.kind === "publish") {
    const props: PublishFormProps = {
      current: live ? { updated: sheet?.status === "updated" } : null,
      dests: options,
      picked: selectedDest,
      missing: (sheet?.problems ?? []).map((problem, index) => ({ id: String(index), label: problem.message })),
      range: selection?.range ?? "live",
      extras: selection?.extras ?? NO_EXTRAS,
      onPick: pick,
      onConnect: toDestinations,
      onAddDest: toDestinations,
      onRange: (range) => selection && change({ ...selection, range }),
      onExtra: (key) => selection && change({ ...selection, extras: { ...selection.extras, [key]: !selection.extras[key] } }),
      onFix: fix,
      onPublish: () => void submit(),
      onUnpublish: () => patch(pageId, { view: { kind: "stop" }, error: null }),
      onClose: close,
      action: actionOf(sheet),
      submitDisabled: loading || busy || !sheet || sheet.primary === null,
      error: error ?? selectionError ?? loadError,
      experience: selection?.handle === "exp" ? {
        ...experienceOptions,
        category: selection.category,
        related: selection.related,
        onCategory: (category) => change({ ...selection, category }),
        onRelated: (slug) => change({ ...selection, related: selection.related.includes(slug) ? selection.related.filter((item) => item !== slug) : [...selection.related, slug] }),
        onQuery: (query) => loadExperienceOptions(query),
        onMore: () => experienceOptions.nextCursor && loadExperienceOptions(experienceOptions.query, experienceOptions.nextCursor),
      } : undefined,
      slug:
        sheet?.slugPrefix && sheet.selection
          ? {
              prefix: bare(sheet.slugPrefix),
              value: sheet.slug.editable ? (selection?.slug ?? sheet.slug.value ?? "") : (sheet.slug.value ?? ""),
              editable: sheet.slug.editable,
              error: slugMessage(sheet.slug.error),
              onChange: (value) => selection && change({ ...selection, slug: value }, SLUG_CHECK_DELAY_MS),
            }
          : undefined,
    };
    overlay = <PublishSheet kind="publish" {...props} />;
  }

  const publication = shellPublicationOf(sheet);
  return {
    status: sheet ? shellStatus(publication) : undefined,
    publish: { ...shellPublishButton({ pub: publication, isArticle }), onClick: open },
    overlay,
    pageSaved,
    open,
    shown: view.kind !== "closed",
  };
}
