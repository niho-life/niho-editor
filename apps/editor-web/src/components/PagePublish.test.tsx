// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageSummary } from "@niho/editor-store";
import type { PublishSheetDto } from "@/lib/publish-client";
import { EditorFrame, useEditorFrame, type FrameInitial } from "./EditorFrame";
import { SAVED_REFRESH_DELAY_MS, actionOf, destOptionsOf } from "./PagePublish";

const PAGE = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";

const nav = vi.hoisted(() => ({ pathname: "/", search: "", push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));

/** 操作の順（エディタの保存・GET・POST）と、エディタの「今すぐ保存」の結果。 */
const order: string[] = [];
const editor = { saved: true, saveGate: null as Promise<boolean> | null };

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
});

beforeEach(() => {
  nav.pathname = `/p/${PAGE}`;
  nav.search = "";
  window.history.replaceState(null, "", "/");
  order.length = 0;
  editor.saved = true;
  editor.saveGate = null;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const NONE = { app: false, news: false, xp: false };

function destination(patch: Partial<PublishSheetDto["destinations"][number]> = {}): PublishSheetDto["destinations"][number] {
  return { handle: "field-notes", dest: "site", label: "自分のサイト", available: true, reason: null, url: "https://notes.example.net/morning-walk", ...patch };
}

/** シートのデータ（サーバーの sheetPlan の写し）。既定は「公開していない・選んでいない」。 */
function sheet(patch: Partial<PublishSheetDto> = {}): PublishSheetDto {
  return {
    status: "private",
    publication: null,
    destinations: [destination()],
    selection: null,
    ranges: [],
    extras: [],
    selectionError: null,
    storageBlock: null,
    problems: [],
    notices: [],
    url: null,
    slug: { value: null, editable: false, error: null },
    slugPrefix: null,
    primary: null,
    changesDestination: false,
    canStop: false,
    ...patch,
  };
}

/** 本人サイトを選んだときのデータ。 */
function sitePlan(patch: Partial<PublishSheetDto> = {}): PublishSheetDto {
  return sheet({
    selection: { handle: "field-notes", range: "live", extras: NONE, slug: null, category: null, related: [] },
    ranges: ["live"],
    extras: [],
    url: "https://notes.example.net/morning-walk",
    slug: { value: "morning-walk", editable: true, error: null },
    slugPrefix: "https://notes.example.net/",
    primary: "publish",
    ...patch,
  });
}

const LIVE: PublishSheetDto["publication"] = {
  handle: "field-notes",
  dest: "site",
  label: "自分のサイト",
  slug: "morning-walk",
  url: "https://notes.example.net/morning-walk",
  range: "live",
  extras: NONE,
  stopped: false,
  version: 1,
  publishedAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z",
};

const LEGACY_EXP_LIVE: PublishSheetDto["publication"] = {
  ...LIVE,
  handle: "exp",
  dest: "exp",
  label: "NIHO Experience",
  url: "https://experience.invalid/guides/morning-walk",
};

type Call = { method: string; url: string; body: unknown };

/** `/api/pages/{id}/publish` の代わり。GET は sheets の順に返す（尽きたら最後のもの）。 */
function server(options: { sheets: PublishSheetDto[]; post?: Response | (() => Response); stop?: Response }) {
  const calls: Call[] = [];
  const queue = [...options.sheets];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    order.push(method);
    if (method === "GET") {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return new Response(JSON.stringify({ sheet: next }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/stop")) return options.stop ?? new Response(JSON.stringify({ stopped: { status: "stopped" } }), { status: 200 });
    const post = options.post ?? new Response(JSON.stringify({ published: { status: "published", operation: "publish", url: "https://notes.example.net/morning-walk", version: 1, notices: [] } }), { status: 200 });
    return typeof post === "function" ? post() : post;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function summary(): PageSummary {
  return { id: PAGE, kind: "article", title: "Morning walk", lang: "en", parent: null, stepStatus: null, sortOrder: 0, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-31T02:00:00.000Z", publication: null };
}

/** ページの中身の代わり（題名と本文の欄だけ）。保存を知らせるボタンも持つ。 */
function FakePage() {
  const frame = useEditorFrame();
  const { registerPageSaver, attachPage } = frame;
  useEffect(() => {
    const save = async () => {
      order.push("save");
      return editor.saveGate ?? editor.saved;
    };
    const unregister = registerPageSaver(save);
    const detach = attachPage({
      id: PAGE, status: "saved", flush: save, revision: () => 1, reopen: () => undefined,
      shared: null, setShared: () => undefined, lang: "en", setLang: () => undefined, langNote: null,
      text: { read: () => "合成の本文", subscribe: () => () => undefined },
      publicationFields: <><textarea data-page-lead="" aria-label="公開用リード" /><input data-page-cover="" type="file" aria-label="カバー画像を選ぶ" /><div data-page-lang="" tabIndex={-1} role="group" aria-label="言語" /></>,
    });
    return () => { unregister(); detach(); };
  }, [registerPageSaver, attachPage]);
  return (
    <>
      <textarea className="page-title" aria-label="タイトル" defaultValue="Morning walk" />
      <div className="doc" contentEditable suppressContentEditableWarning tabIndex={-1} aria-label="本文" />
      <button type="button" data-saved onClick={() => frame.pageSaved(PAGE)}>
        保存した
      </button>
    </>
  );
}

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const initial: FrameInitial = { pages: [summary()], next: null, recent: [], now: Date.parse("2026-10-31T03:00:00.000Z"), me: { name: "開発ユーザー", caption: "stub", initial: "開" }, initialNarrow: false };
  await act(async () => root!.render(<EditorFrame initial={initial}>{<FakePage />}</EditorFrame>));
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => container!.querySelector<T>(selector);
const byText = (selector: string, text: string) => [...container!.querySelectorAll<HTMLButtonElement>(selector)].find((el) => el.textContent?.trim().startsWith(text));
/** 発信先の行（名前がちょうど name のもの）。 */
const dest = (name: string) => [...container!.querySelectorAll<HTMLElement>(".es-dst")].find((el) => el.querySelector("b")?.textContent === name);
const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
const dialog = () => $('[role="dialog"]');
const primary = () => $<HTMLButtonElement>(".es-sh-foot .es-btn--primary")!;

describe("ヘッダーの状態と公開ボタン", () => {
  it("開いたページの公開の状態を読み、状態の丸と「公開」を出す。公開中は「公開中 ▾」と一覧の 2 行目に発信先", async () => {
    server({ sheets: [sheet()] });
    await mount();
    expect($(".es-pubbtn")!.textContent).toBe("公開");
    await act(async () => root!.unmount());
    root = null;
    container!.remove();

    server({ sheets: [sheet({ status: "published", publication: LIVE, canStop: true })] });
    await mount();
    expect($(".es-pubbtn")!.textContent).toBe("公開中 ▾");
    expect($(".es-sb-list .es-di-sub")!.textContent).toBe("自分のサイト");
  });

  it("⌘⇧P（jsdom は Mac ではないので Ctrl+Shift+P）で公開のシートを開く", async () => {
    server({ sheets: [sheet()] });
    await mount();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "P", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(dialog()?.getAttribute("aria-label")).toBe("公開");
  });
});

describe("公開のシート", () => {
  it("足りないものがあるあいだ公開は押せない（押しても送らない）", async () => {
    const problems = [{ id: "headings", message: "本文に見出しを 1 つ以上入れてください", fix: "body" as const }];
    const { calls } = server({ sheets: [sheet(), sheet(), sitePlan({ problems, primary: null })] });
    await mount();
    await click($(".es-pubbtn"));
    await click(dest("自分のサイト"));
    expect(calls.at(-1)!.url).toBe(`/api/pages/${PAGE}/publish?handle=field-notes&range=live&extras=&related=`);
    expect(dialog()!.textContent).toContain("本文に見出しを 1 つ以上入れてください");
    expect(primary().disabled).toBe(true);
    await click(primary());
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("公開する → 公開しました。「見る」は公開版の URL を新しいタブで開く。状態は公開中になる", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const { calls } = server({ sheets: [sheet(), sheet(), sitePlan(), sheet({ status: "published", publication: LIVE, canStop: true })] });
    await mount();
    await click($(".es-pubbtn"));
    await click(dest("自分のサイト"));
    expect($<HTMLInputElement>(".es-slug input")!.value).toBe("morning-walk");
    expect(primary().disabled).toBe(false);
    await click(primary());
    expect(calls.find((call) => call.method === "POST")!.body).toEqual({ handle: "field-notes", range: "live", extras: NONE, category: null, related: [], slug: "morning-walk" });
    expect(dialog()!.getAttribute("aria-label")).toBe("公開しました");
    expect(dialog()!.textContent).toContain("notes.example.net に公開しました");
    await click(byText("button", "見る"));
    expect(open).toHaveBeenCalledWith("https://notes.example.net/morning-walk", "_blank", "noopener,noreferrer");
    expect($(".es-pubbtn")!.textContent).toBe("公開中 ▾");
  });

  it("開く前と公開を送る前に、エディタの保存待ちを送り終える（最後の入力を公開版に入れる）", async () => {
    server({ sheets: [sheet(), sheet(), sitePlan(), sheet({ status: "published", publication: LIVE, canStop: true })] });
    await mount();
    order.length = 0;
    await click($(".es-pubbtn"));
    expect(order).toEqual(["save", "GET"]);
    await click(dest("自分のサイト"));
    order.length = 0;
    await click(primary());
    expect(order.slice(0, 2)).toEqual(["save", "POST"]);
  });

  it("保存できなければ公開を送らず、一言を出す（開くときは読むだけ読んで、一言を出す）", async () => {
    editor.saved = false;
    const { calls } = server({ sheets: [sheet(), sheet(), sitePlan()] });
    await mount();
    await click($(".es-pubbtn"));
    expect($('[role="alert"]')!.textContent).toBe("保存できていないので公開できません。保存の状態を確かめてから、もう一度お試しください");
    await click(dest("自分のサイト"));
    await click(primary());
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect($('[role="alert"]')!.textContent).toBe("保存できていないので公開できません。保存の状態を確かめてから、もう一度お試しください");
    expect(dialog()!.getAttribute("aria-label")).toBe("公開");
  });

  it("公開に失敗したら、シートの足もとに 1 行（role=alert）。シートは開いたまま", async () => {
    const failed = () => new Response(JSON.stringify({ error: "failed", retryable: true, message: "公開できませんでした。前の公開版と下書きはそのままです。もう一度お試しください" }), { status: 503 });
    server({ sheets: [sheet(), sheet(), sitePlan()], post: failed });
    await mount();
    await click($(".es-pubbtn"));
    await click(dest("自分のサイト"));
    await click(primary());
    expect(dialog()!.getAttribute("aria-label")).toBe("公開");
    expect($('[role="alert"]')!.textContent).toBe("公開できませんでした。前の公開版と下書きはそのままです。もう一度お試しください");
  });

  it("公開をやめる前に確認が出る。「やめない」で戻り、「公開をやめる」で送ってシートを閉じる", async () => {
    const live = sheet({ status: "published", publication: LIVE, canStop: true, primary: null, slug: { value: "morning-walk", editable: false, error: null } });
    const stopped = sheet({ status: "stopped", publication: { ...LIVE, stopped: true } });
    const { calls } = server({ sheets: [live, live, stopped] });
    await mount();
    await click($(".es-pubbtn"));
    expect(primary().textContent).toBe("保存");
    expect(primary().disabled).toBe(true);
    await click(byText("button", "公開をやめる"));
    expect(dialog()!.getAttribute("aria-label")).toBe("公開をやめる");
    expect(dialog()!.textContent).toContain("自分のサイト での公開をやめますか");
    expect(calls.some((call) => call.url.endsWith("/stop"))).toBe(false);
    await click(byText("button", "やめない"));
    expect(dialog()!.getAttribute("aria-label")).toBe("公開");
    await click(byText("button", "公開をやめる"));
    await click(byText(".es-sh-foot button", "公開をやめる"));
    expect(calls.filter((call) => call.url.endsWith("/stop")).map((call) => call.method)).toEqual(["POST"]);
    expect(dialog()).toBeNull();
    expect($(".es-pubbtn")!.textContent).toBe("公開");
    expect($(".es-sb-list .es-di-sub")!.textContent).toBe("公開をやめた");
  });

  it("「直す」: 本文の問題はシートを閉じて本文へ、題名の問題は題名へフォーカスを移す", async () => {
    const problems = [
      { id: "title", message: "題名を入れてください", fix: "body" as const },
      { id: "headings", message: "本文に見出しを 1 つ以上入れてください", fix: "body" as const },
      { id: "step-title", message: "工程の段階名が題名のままです", fix: "body" as const },
    ];
    const plan = sitePlan({ problems, primary: null });
    server({ sheets: [sheet(), plan] });
    await mount();
    await click($(".es-pubbtn"));
    await click(byText("button", "直す"));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe($("textarea.page-title"));

    await click($(".es-pubbtn"));
    await click(container!.querySelectorAll<HTMLButtonElement>(".es-need button")[1]);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe($(".doc"));

    await click($(".es-pubbtn"));
    await click(container!.querySelectorAll<HTMLButtonElement>(".es-need button")[2]);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe($("textarea.page-title"));
  });

  it("「直す」: リード・カバー画像・言語はシートを閉じず、シートの中の記事の情報の欄へ移る", async () => {
    const problems = [
      { id: "lead", message: "リードを入れてください", fix: "lead" as const },
      { id: "cover", message: "カバー写真を選んでください", fix: "cover" as const },
      { id: "lang", message: "英語のページにしてください", fix: "lang" as const },
    ];
    server({ sheets: [sheet(), sitePlan({ problems, primary: null })] });
    await mount();
    await click($(".es-pubbtn"));
    // 記事の情報（リード・カバー画像・言語）はシートの中。本文の列とレールには無い
    expect(dialog()?.querySelector(".es-sh-fields [data-page-lead]")).not.toBeNull();
    expect($("#es-main [data-page-lead]")).toBeNull();
    expect($("#es-rail [data-page-lead]")).toBeNull();
    await click(byText("button", "直す"));
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(dialog()!.querySelector("[data-page-lead]"));
    await click(container!.querySelectorAll<HTMLButtonElement>(".es-need button")[1]);
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(dialog()!.querySelector("[data-page-cover]"));
    await click(container!.querySelectorAll<HTMLButtonElement>(".es-need button")[2]);
    expect(dialog()).not.toBeNull();
    expect(document.activeElement).toBe(dialog()!.querySelector("[data-page-lang]"));
  });

  it("legacy Experience query and saved DTO rows cannot restore Experience UI or upstream option fetches", async () => {
    nav.search = "destination=exp&lang=en&experience=coastal-tea";
    const legacyFace = { ...destination(), handle: "exp", dest: "exp" as const, label: "NIHO Experience", url: "https://experience.invalid/guides/morning-walk" };
    const legacy = sheet({ status: "published", publication: LEGACY_EXP_LIVE, destinations: [legacyFace, destination()], selection: null });
    const { calls } = server({ sheets: [legacy, legacy] });
    await mount();
    expect($(".es-sb-list .es-di-sub")).toBeNull();
    await click($(".es-pubbtn"));
    expect(dialog()?.textContent).not.toContain("NIHO Experience");
    expect(dialog()?.textContent).toContain("自分のサイト");
    expect(calls.every((call) => !call.url.includes("experience-options") && !call.url.includes("handle=exp"))).toBe(true);
  });

  it("保存を待つあいだに別のページへ移ったら、前のページの読み込みを始めず、移った先の公開の状態は捨てられない", async () => {
    const PAGE_B = "7a1d3b5f-2c4e-4d6f-9a81-0b2c3d4e5f60";
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        const published = url.includes(PAGE_B);
        return new Response(JSON.stringify({ sheet: published ? sheet({ status: "published", publication: LIVE, canStop: true }) : sheet() }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    let release!: () => void;
    editor.saveGate = new Promise<boolean>((resolve) => {
      release = () => resolve(true);
    });
    const pageB: PageSummary = { ...summary(), id: PAGE_B, title: "Evening walk" };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const initial: FrameInitial = { pages: [summary(), pageB], next: null, recent: [], now: Date.parse("2026-10-31T03:00:00.000Z"), me: { name: "開発ユーザー", caption: "stub", initial: "開" }, initialNarrow: false };
    const render = () => act(async () => root!.render(<EditorFrame initial={initial}>{<FakePage />}</EditorFrame>));
    await render();
    await click($(".es-pubbtn"));
    // A の保存を待っている途中で B へ移る
    nav.pathname = `/p/${PAGE_B}`;
    await render();
    await act(async () => release());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    // A は最初の読み込みの 1 回だけ（保存のあとの読み込みは始めない）。B の応答（公開中）が画面に出る
    expect(calls.filter((url) => url.includes(PAGE))).toHaveLength(1);
    expect(calls.filter((url) => url.includes(PAGE_B))).toHaveLength(1);
    expect($(".es-pubbtn")?.textContent).toContain("公開中");
  });

  it("保存先がクラウドでないときは、理由を一言出して公開は押せない（storageBlock）", async () => {
    server({ sheets: [sheet(), sheet({ storageBlock: "LOCAL", selection: { handle: "field-notes", range: "live", extras: NONE, slug: null, category: null, related: [] } }), sitePlan({ storageBlock: "LOCAL", primary: null })] });
    await mount();
    await click($(".es-pubbtn"));
    await click(dest("自分のサイト"));
    expect($('[role="alert"]')!.textContent).toBe("保存先が NIHO クラウドではないので、公開できません（公開は保存先がクラウドのときだけです）");
    expect(primary().disabled).toBe(true);
  });

  it("「接続する」「発信先を追加」は発信先の設定へ移る", async () => {
    server({ sheets: [sheet({ destinations: [] })] });
    await mount();
    await click($(".es-pubbtn"));
    await click(byText("button", "自分のサイト"));
    expect(nav.push).toHaveBeenLastCalledWith("/destinations");
  });

  it("公開中のページを保存したら、少し待って「更新あり」を確かめ直す", async () => {
    vi.useFakeTimers();
    const { calls } = server({ sheets: [sheet({ status: "published", publication: LIVE, canStop: true }), sheet({ status: "updated", publication: LIVE, canStop: true })] });
    await mount();
    await act(async () => vi.runOnlyPendingTimersAsync());
    const gets = () => calls.filter((call) => call.method === "GET").length;
    expect(gets()).toBe(1);
    await click($("[data-saved]"));
    await click($("[data-saved]"));
    await act(async () => vi.advanceTimersByTimeAsync(SAVED_REFRESH_DELAY_MS));
    expect(gets()).toBe(2);
    expect($(".es-pubbtn")!.textContent).toBe("更新を公開");
  });
});

describe("写し", () => {
  it("役割で出せない面は出さず、宣言の読めない面は「いまは公開できません」。サイトが無ければ「接続する」の行", () => {
    const legacyExp = { ...destination(), handle: "exp", dest: "exp" as const, label: "NIHO Experience", available: true };
    const legacyNiho = { ...destination(), handle: "niho", dest: "niho" as const, label: "NIHO", available: true };
    const { options, site } = destOptionsOf(sheet({ destinations: [legacyExp, legacyNiho] }));
    expect(options.map(({ id, connected, note }) => ({ id, connected, note }))).toEqual([
      { id: "site", connected: false, note: undefined },
    ]);
    expect(site).toBeNull();
  });

  it("主ボタンの文言", () => {
    expect(actionOf(null)).toBeUndefined();
    expect(actionOf(sitePlan())).toBe("公開する");
    expect(actionOf(sitePlan({ primary: "update", publication: LIVE }))).toBe("更新を公開");
    expect(actionOf(sitePlan({ primary: "publish", publication: LIVE, changesDestination: true }))).toBe("発信先を変える");
    expect(actionOf(sitePlan({ primary: null, publication: LIVE }))).toBeUndefined();
  });
});
