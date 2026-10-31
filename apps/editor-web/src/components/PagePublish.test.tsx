// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageSummary } from "@niho/editor-store";
import type { PublishSheetDto } from "@/lib/publish-client";
import { EditorFrame, useEditorFrame, type FrameInitial } from "./EditorFrame";
import { SAVED_REFRESH_DELAY_MS, actionOf, destOptionsOf } from "./PagePublish";

const PAGE = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";

const nav = vi.hoisted(() => ({ pathname: "/", push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
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

function destination(handle: "exp" | "niho", patch: Partial<PublishSheetDto["destinations"][number]> = {}): PublishSheetDto["destinations"][number] {
  const host = handle === "exp" ? "experience.niho.life/guides" : "niho.life/article";
  return { handle, dest: handle, label: handle === "exp" ? "NIHO Experience" : "NIHO", available: true, reason: null, url: `https://${host}/morning-walk`, ...patch };
}

/** シートのデータ（サーバーの sheetPlan の写し）。既定は「公開していない・選んでいない」。 */
function sheet(patch: Partial<PublishSheetDto> = {}): PublishSheetDto {
  return {
    status: "private",
    publication: null,
    destinations: [destination("exp"), destination("niho")],
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

/** NIHO を選んだときのデータ。 */
function nihoPlan(patch: Partial<PublishSheetDto> = {}): PublishSheetDto {
  return sheet({
    selection: { handle: "niho", range: "live", extras: NONE, slug: null },
    ranges: ["live", "unlisted"],
    extras: [
      { key: "app", checked: false },
      { key: "news", checked: false },
    ],
    url: "https://niho.life/article/morning-walk",
    slug: { value: "morning-walk", editable: true, error: null },
    slugPrefix: "https://niho.life/article/",
    primary: "publish",
    ...patch,
  });
}

const LIVE: PublishSheetDto["publication"] = {
  handle: "niho",
  dest: "niho",
  label: "NIHO",
  slug: "morning-walk",
  url: "https://niho.life/article/morning-walk",
  range: "live",
  extras: NONE,
  stopped: false,
  version: 1,
  publishedAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z",
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
    const post = options.post ?? new Response(JSON.stringify({ published: { status: "published", operation: "publish", url: "https://niho.life/article/morning-walk", version: 1, notices: [] } }), { status: 200 });
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
  const { registerPageSaver } = frame;
  useEffect(
    () =>
      registerPageSaver(async () => {
        order.push("save");
        return editor.saveGate ?? editor.saved;
      }),
    [registerPageSaver],
  );
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
/** 発信先の行（名前がちょうど name のもの。「NIHO」と「NIHO Experience」を取り違えない）。 */
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
    expect($(".es-sb-list .es-di-sub")!.textContent).toBe("NIHO");
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
    const { calls } = server({ sheets: [sheet(), sheet(), nihoPlan({ problems, primary: null })] });
    await mount();
    await click($(".es-pubbtn"));
    await click(dest("NIHO"));
    expect(calls.at(-1)!.url).toBe(`/api/pages/${PAGE}/publish?handle=niho&range=live&extras=`);
    expect(dialog()!.textContent).toContain("本文に見出しを 1 つ以上入れてください");
    expect(primary().disabled).toBe(true);
    await click(primary());
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("公開する → 公開しました。「見る」は公開版の URL を新しいタブで開く。状態は公開中になる", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const { calls } = server({ sheets: [sheet(), sheet(), nihoPlan(), sheet({ status: "published", publication: LIVE, canStop: true })] });
    await mount();
    await click($(".es-pubbtn"));
    await click(dest("NIHO"));
    expect($<HTMLInputElement>(".es-slug input")!.value).toBe("morning-walk");
    expect(primary().disabled).toBe(false);
    await click(primary());
    expect(calls.find((call) => call.method === "POST")!.body).toEqual({ handle: "niho", range: "live", extras: NONE, slug: "morning-walk" });
    expect(dialog()!.getAttribute("aria-label")).toBe("公開しました");
    expect(dialog()!.textContent).toContain("niho.life に公開しました");
    await click(byText("button", "見る"));
    expect(open).toHaveBeenCalledWith("https://niho.life/article/morning-walk", "_blank", "noopener,noreferrer");
    expect($(".es-pubbtn")!.textContent).toBe("公開中 ▾");
  });

  it("開く前と公開を送る前に、エディタの保存待ちを送り終える（最後の入力を公開版に入れる）", async () => {
    server({ sheets: [sheet(), sheet(), nihoPlan(), sheet({ status: "published", publication: LIVE, canStop: true })] });
    await mount();
    order.length = 0;
    await click($(".es-pubbtn"));
    expect(order).toEqual(["save", "GET"]);
    await click(dest("NIHO"));
    order.length = 0;
    await click(primary());
    expect(order.slice(0, 2)).toEqual(["save", "POST"]);
  });

  it("保存できなければ公開を送らず、一言を出す（開くときは読むだけ読んで、一言を出す）", async () => {
    editor.saved = false;
    const { calls } = server({ sheets: [sheet(), sheet(), nihoPlan()] });
    await mount();
    await click($(".es-pubbtn"));
    expect($('[role="alert"]')!.textContent).toBe("保存できていないので公開できません。保存の状態を確かめてから、もう一度お試しください");
    await click(dest("NIHO"));
    await click(primary());
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect($('[role="alert"]')!.textContent).toBe("保存できていないので公開できません。保存の状態を確かめてから、もう一度お試しください");
    expect(dialog()!.getAttribute("aria-label")).toBe("公開");
  });

  it("公開に失敗したら、シートの足もとに 1 行（role=alert）。シートは開いたまま", async () => {
    const failed = () => new Response(JSON.stringify({ error: "failed", retryable: true, message: "公開できませんでした。前の公開版と下書きはそのままです。もう一度お試しください" }), { status: 503 });
    server({ sheets: [sheet(), sheet(), nihoPlan()], post: failed });
    await mount();
    await click($(".es-pubbtn"));
    await click(dest("NIHO"));
    await click(primary());
    expect(dialog()!.getAttribute("aria-label")).toBe("公開");
    expect($('[role="alert"]')!.textContent).toBe("公開できませんでした。前の公開版と下書きはそのままです。もう一度お試しください");
  });

  it("公開をやめる前に確認が出る。「やめない」で戻り、「公開をやめる」で送ってシートを閉じる", async () => {
    const live = nihoPlan({ status: "published", publication: LIVE, canStop: true, primary: null, slug: { value: "morning-walk", editable: false, error: null } });
    const stopped = sheet({ status: "stopped", publication: { ...LIVE, stopped: true } });
    const { calls } = server({ sheets: [live, live, stopped] });
    await mount();
    await click($(".es-pubbtn"));
    expect(primary().textContent).toBe("保存");
    expect(primary().disabled).toBe(true);
    await click(byText("button", "公開をやめる"));
    expect(dialog()!.getAttribute("aria-label")).toBe("公開をやめる");
    expect(dialog()!.textContent).toContain("NIHO での公開をやめますか");
    expect(dialog()!.textContent).toContain("URL は NIHO の一覧へ転送されます");
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
    ];
    const plan = nihoPlan({ problems, primary: null, selection: { handle: "niho", range: "live", extras: NONE, slug: null } });
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
  });

  it("「直す」: editor に欄の無い条件（カバー写真など）はシートを開いたまま、まだ直せないと一言", async () => {
    const plan = nihoPlan({ problems: [{ id: "cover", message: "カバー写真を選んでください", fix: "cover" }], primary: null });
    server({ sheets: [sheet(), plan] });
    await mount();
    await click($(".es-pubbtn"));
    await click(byText("button", "直す"));
    expect(dialog()).not.toBeNull();
    expect($('[role="alert"]')!.textContent).toBe("この項目を直す欄は、まだ editor にありません");
  });

  it("公開中に別の発信先を選ぶと「発信先を変える」", async () => {
    const live = sheet({ status: "published", publication: LIVE, canStop: true, selection: { handle: "niho", range: "live", extras: NONE, slug: null } });
    const move = nihoPlan({
      status: "published",
      publication: LIVE,
      canStop: true,
      selection: { handle: "exp", range: "live", extras: NONE, slug: null },
      url: "https://experience.niho.life/guides/morning-walk",
      slugPrefix: "https://experience.niho.life/guides/",
      changesDestination: true,
    });
    const { calls } = server({ sheets: [live, live, move] });
    await mount();
    await click($(".es-pubbtn"));
    await click(dest("NIHO Experience"));
    expect(primary().textContent).toBe("発信先を変える");
    await click(primary());
    expect(calls.find((call) => call.method === "POST")!.body).toMatchObject({ handle: "exp" });
  });

  it("別の発信先を選ぶと、前の発信先だけにある「あわせて」は持ち越さない（体験ページに載せる → NIHO で公開できなくならない）", async () => {
    const expPlan = sheet({
      selection: { handle: "exp", range: "live", extras: { app: false, news: false, xp: true }, slug: null },
      extras: [
        { key: "app", checked: false },
        { key: "xp", checked: true },
      ],
      url: "https://experience.niho.life/guides/morning-walk",
      slug: { value: "morning-walk", editable: true, error: null },
      slugPrefix: "https://experience.niho.life/guides/",
      primary: "publish",
    });
    const { calls } = server({ sheets: [sheet(), expPlan, nihoPlan()] });
    await mount();
    await click($(".es-pubbtn"));
    const requested = () => calls.filter((call) => call.method === "GET").map((call) => new URL(call.url, "http://localhost").searchParams);
    await click(dest("NIHO"));
    const last = requested().at(-1)!;
    expect(last.get("handle")).toBe("niho");
    expect(last.get("extras") ?? "").toBe("");
    expect(primary().disabled).toBe(false);
    // 同じ発信先を選び直すときは、選んでいたものを残す
    await click(dest("NIHO"));
    expect(requested().at(-1)!.get("extras") ?? "").toBe("");
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
    server({ sheets: [sheet(), sheet({ storageBlock: "LOCAL", selection: { handle: "niho", range: "live", extras: NONE, slug: null } }), nihoPlan({ storageBlock: "LOCAL", primary: null })] });
    await mount();
    await click($(".es-pubbtn"));
    await click(dest("NIHO"));
    expect($('[role="alert"]')!.textContent).toBe("保存先が NIHO クラウドではないので、公開できません（公開は保存先がクラウドのときだけです）");
    expect(primary().disabled).toBe(true);
  });

  it("「接続する」「発信先を追加」は発信先の設定へ移る", async () => {
    server({ sheets: [sheet()] });
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
    const { options, site } = destOptionsOf(sheet({ destinations: [destination("exp", { available: false, reason: "role", url: null }), destination("niho", { available: false, reason: "unavailable", url: null })] }));
    expect(options.map(({ id, connected, note }) => ({ id, connected, note }))).toEqual([
      { id: "niho", connected: false, note: "いまは公開できません" },
      { id: "site", connected: false, note: undefined },
    ]);
    expect(site).toBeNull();
  });

  it("主ボタンの文言", () => {
    expect(actionOf(null)).toBeUndefined();
    expect(actionOf(nihoPlan())).toBe("公開する");
    expect(actionOf(nihoPlan({ primary: "update", publication: LIVE }))).toBe("更新を公開");
    expect(actionOf(nihoPlan({ primary: "publish", publication: LIVE, changesDestination: true }))).toBe("発信先を変える");
    expect(actionOf(nihoPlan({ primary: null, publication: LIVE }))).toBeUndefined();
  });
});
