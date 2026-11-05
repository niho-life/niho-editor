// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EditorProps = {
  page?: { id: string | null; title?: string; blocks?: unknown[]; revision?: number | null; lang?: string };
  createOnOpen?: boolean;
  onCreated?: (id: string) => void;
  onLangChange?: (lang: "ja" | "en") => void;
  onLeftEmpty?: (id: string, options: { keepalive: boolean }) => void;
};
const editors: EditorProps[] = [];
const frame = { pageCreated: vi.fn(), pageTitleChanged: vi.fn(), pageSaved: vi.fn(), pageOpened: vi.fn(), pageLangChanged: vi.fn(), pageRemoved: vi.fn(), narrow: false };
/** 手順の帯が「この段階の本文が入れ替わった」と知らせる口（PageSteps のモックが預かる）。 */
const steps: { onBodyReplaced?: () => void } = {};

vi.mock("next/navigation", () => ({
  usePathname: () => "/p/new",
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./EditorFrame", () => ({ useEditorFrame: () => frame, isNarrowNow: () => false }));
vi.mock("@/lib/last-page", () => ({ rememberLastPage: vi.fn() }));
vi.mock("./PageEditor", () => ({
  PageEditor: (props: EditorProps) => {
    editors.push(props);
    return <div data-editor="" />;
  },
}));
vi.mock("./RecordingTranscript", () => ({
  RecordingTranscript: ({ pageId }: { pageId: string }) => <div data-transcript={pageId} />,
}));
// 手順の帯（#37）は PageSteps.test.tsx が見る。ここは、帯・文字起こし・本文の並びと渡す値だけを見る
vi.mock("./PageSteps", () => ({
  PageSteps: (props: { pageId: string; kind: string; parentId: string | null; media?: unknown; onBodyReplaced?: () => void; children?: unknown }) => {
    steps.onBodyReplaced = props.onBodyReplaced;
    return (
      <>
        <div data-steps={`${props.pageId}:${props.kind}:${props.parentId ?? "none"}`} />
        {props.media as never}
        {props.children as never}
      </>
    );
  },
}));
vi.mock("@/lib/pages-client", async (original) => ({
  ...(await original<typeof import("@/lib/pages-client")>()),
  readPageRequest: vi.fn(),
  discardPageRequest: vi.fn(),
}));

import { rememberLastPage } from "@/lib/last-page";
import { LEFT_EMPTY_PAGES_KEY, TAB_CREATED_PAGES_KEY } from "@/lib/left-empty-pages";
import { PageRequestError, discardPageRequest, readPageRequest } from "@/lib/pages-client";
import { NewPage, OpenPage } from "./FramePages";

const readPage = vi.mocked(readPageRequest);
const discard = vi.mocked(discardPageRequest);

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  editors.length = 0;
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/p/new");
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<NewPage />);
  });
}

describe("NewPage: the creation redirect belongs to the draft that made the page", () => {
  it("replaces /p/new with /p/{id} while the draft that created the page is still on screen", async () => {
    await mount();
    expect(editors.at(-1)!.createOnOpen).toBe(true);
    await act(async () => editors.at(-1)!.onCreated!("11111111-1111-4111-8111-111111111111"));
    expect(window.location.pathname).toBe("/p/11111111-1111-4111-8111-111111111111");
    expect(rememberLastPage).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("does not touch the URL when the draft was already left (the POST finishes after the user moved on)", async () => {
    await mount();
    const created = editors.at(-1)!.onCreated!;
    // 「録音から」へ移る・別の下書きへ戻るなどで、この下書きのエディタが外れる。URL は `/p/new` のまま
    await act(async () => root!.unmount());
    root = null;
    created("22222222-2222-4222-8222-222222222222");
    expect(window.location.pathname).toBe("/p/new");
    expect(rememberLastPage).not.toHaveBeenCalled();
    // ページは作られているので、一覧には載せる
    expect(frame.pageCreated).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222", "");
  });

  it("keeps the safe Experience handoff through creation and starts the private page in English", async () => {
    window.history.replaceState(null, "", "/p/new?destination=exp&lang=en&experience=morning-walk");
    await mount();
    expect(editors.at(-1)?.page).toMatchObject({ lang: "en" });
    await act(async () => editors.at(-1)!.onCreated!("55555555-5555-4555-8555-555555555555"));
    expect(`${window.location.pathname}${window.location.search}`).toBe("/p/55555555-5555-4555-8555-555555555555?destination=exp&lang=en&experience=morning-walk");
  });
});

describe("NewPage: a page left without anything added is discarded (owner decision 2026-11-05)", () => {
  const CREATED = "44444444-4444-4444-8444-444444444444";
  const candidates = () => JSON.parse(window.localStorage.getItem(LEFT_EMPTY_PAGES_KEY) ?? "[]") as string[];

  it("marks the page as made in this tab, and on leaving inside the app asks the server at once and drops it from the list", async () => {
    discard.mockResolvedValue(true);
    await mount();
    await act(async () => editors.at(-1)!.onCreated!(CREATED));
    expect(JSON.parse(window.sessionStorage.getItem(TAB_CREATED_PAGES_KEY)!)).toEqual([CREATED]);
    await act(async () => editors.at(-1)!.onLeftEmpty!(CREATED, { keepalive: false }));
    expect(discard).toHaveBeenCalledWith(CREATED);
    expect(frame.pageRemoved).toHaveBeenCalledWith(CREATED);
    expect(candidates()).toEqual([]);
  });

  it("on pagehide (close, reload) does not discard: it only adds the page to the candidates for the next start", async () => {
    await mount();
    await act(async () => editors.at(-1)!.onCreated!(CREATED));
    await act(async () => editors.at(-1)!.onLeftEmpty!(CREATED, { keepalive: true }));
    await act(async () => editors.at(-1)!.onLeftEmpty!(CREATED, { keepalive: true }));
    expect(discard).not.toHaveBeenCalled();
    expect(candidates()).toEqual([CREATED]);
  });

  it("keeps the row when the page is not empty, and keeps a candidate when the request did not get through", async () => {
    discard.mockResolvedValueOnce(false).mockRejectedValueOnce(new TypeError("offline")).mockRejectedValueOnce(new PageRequestError(404));
    await mount();
    await act(async () => editors.at(-1)!.onCreated!(CREATED));
    await act(async () => editors.at(-1)!.onLeftEmpty!(CREATED, { keepalive: false }));
    expect(candidates()).toEqual([]);
    await act(async () => editors.at(-1)!.onLeftEmpty!(CREATED, { keepalive: false }));
    expect(candidates()).toEqual([CREATED]);
    window.localStorage.clear();
    await act(async () => editors.at(-1)!.onLeftEmpty!(CREATED, { keepalive: false }));
    expect(candidates()).toEqual([]);
    expect(frame.pageRemoved).not.toHaveBeenCalled();
  });

  it("never asks for a page it did not create (before creation, or another id)", async () => {
    await mount();
    await act(async () => editors.at(-1)!.onLeftEmpty!(CREATED, { keepalive: false }));
    await act(async () => editors.at(-1)!.onCreated!(CREATED));
    await act(async () => editors.at(-1)!.onLeftEmpty!("55555555-5555-4555-8555-555555555555", { keepalive: false }));
    expect(discard).not.toHaveBeenCalled();
  });
});

describe("OpenPage: the steps band, the transcript, then the title and body", () => {
  const PAGE = "33333333-3333-4333-8333-333333333333";
  const summary = (kind: "note" | "rec" | "step", parent: string | null = null) => ({ id: PAGE, kind, title: "録音", lang: "ja" as const, parent, stepStatus: null, sortOrder: 0, publication: null, createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" });

  async function open(kind: "note" | "rec" | "step", parent: string | null = null) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<OpenPage summary={summary(kind, parent)} blocks={[]} revision={1} />);
    });
    return container;
  }

  const order = (host: HTMLElement) =>
    [...host.children].map((node) => node.getAttribute("data-steps") ?? node.getAttribute("data-transcript") ?? "editor");

  it("puts the steps band first, then the transcript (kind=rec), then the page editor", async () => {
    const host = await open("rec");
    expect(order(host)).toEqual([`${PAGE}:rec:none`, PAGE, "editor"]);
    expect(frame.pageOpened).toHaveBeenCalledTimes(1);
  });

  it("shows the band and the editor for an ordinary page, without the transcript", async () => {
    const host = await open("note");
    expect(order(host)).toEqual([`${PAGE}:note:none`, "editor"]);
    expect(host.querySelector("[data-transcript]")).toBeNull();
    // 既にあるページ（このタブの「新しいページ」で作っていない）は、空でも捨てない
    expect(editors.at(-1)!.onLeftEmpty).toBeUndefined();
  });

  it("treats a page made in this tab (opened again after a reload) like a new page: leaving it empty discards it", async () => {
    discard.mockResolvedValue(true);
    window.sessionStorage.setItem(TAB_CREATED_PAGES_KEY, JSON.stringify([PAGE]));
    await open("note");
    const leave = editors.at(-1)!.onLeftEmpty!;
    await act(async () => leave(PAGE, { keepalive: false }));
    expect(discard).toHaveBeenCalledWith(PAGE);
    expect(frame.pageRemoved).toHaveBeenCalledWith(PAGE);
    // タブを閉じるときは候補に足すだけ
    await act(async () => leave(PAGE, { keepalive: true }));
    expect(discard).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.localStorage.getItem(LEFT_EMPTY_PAGES_KEY)!)).toEqual([PAGE]);
  });

  it("gives the band the parent of a step subpage (the run belongs to the recording page)", async () => {
    const host = await open("step", "44444444-4444-4444-8444-444444444444");
    expect(order(host)).toEqual([`${PAGE}:step:44444444-4444-4444-8444-444444444444`, "editor"]);
  });

  it("段階が終わって本文が入れ替わったら、読み直してエディタを開き直す（#37。帯だけ「済み」にしない）", async () => {
    readPage.mockResolvedValue({ title: "記事方針", blocks: [{ type: "paragraph" }], revision: 7, updatedAt: "2026-10-31T04:00:00.000Z", lang: "ja" });
    await open("step", "44444444-4444-4444-8444-444444444444");
    // 開いたときは、サーバーが描いた本文と revision
    expect(editors.at(-1)!.page).toMatchObject({ id: PAGE, title: "録音", blocks: [], revision: 1 });
    const before = editors.length;

    await act(async () => steps.onBodyReplaced!());
    expect(readPage).toHaveBeenCalledWith(PAGE);
    // 入れ替わった本文と、worker が進めた revision でエディタを作り直す（Undo に混ぜず、自動保存も起こさない）
    expect(editors.length).toBeGreaterThan(before);
    expect(editors.at(-1)!.page).toMatchObject({ id: PAGE, title: "記事方針", blocks: [{ type: "paragraph" }], revision: 7 });
    // サーバーの更新時刻が進んだので一覧の行も動かす
    expect(frame.pageSaved).toHaveBeenCalledWith(PAGE);
  });

  it("読み直せなければエディタはそのまま（帯の「済み」だけが先に出る）", async () => {
    readPage.mockRejectedValue(new Error("offline"));
    await open("step", "44444444-4444-4444-8444-444444444444");
    await act(async () => steps.onBodyReplaced!());
    expect(editors.at(-1)!.page).toMatchObject({ title: "録音", blocks: [], revision: 1 });
  });
});

describe("OpenPage: the language and the recording length for the info panel", () => {
  const ID = "33333333-3333-4333-8333-333333333333";
  const summary = { id: ID, kind: "rec" as const, title: "合成の録音", lang: "en" as const, parent: null, stepStatus: null, sortOrder: 0, publication: null, createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z" };

  it("opens the editor in the page's language, tells the frame the recording length, and reports a saved language change to the list", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<OpenPage summary={summary} blocks={[]} revision={3} recordingSec={878} />);
    });
    expect(editors.at(-1)?.page).toMatchObject({ id: ID, lang: "en" });
    expect(frame.pageOpened).toHaveBeenCalledWith(summary, { recordingSec: 878 });
    await act(async () => editors.at(-1)!.onLangChange!("ja"));
    expect(frame.pageLangChanged).toHaveBeenCalledWith(ID, "ja");
  });

  it("passes no recording length when the server did not read one", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<OpenPage summary={{ ...summary, kind: "note" }} blocks={[]} revision={3} />);
    });
    expect(frame.pageOpened).toHaveBeenCalledWith({ ...summary, kind: "note" }, { recordingSec: null });
  });
});

describe("NewPage: a language saved after the page was created goes to the list", () => {
  it("reports the language for the created page only", async () => {
    await mount();
    await act(async () => editors.at(-1)!.onLangChange!("en"));
    expect(frame.pageLangChanged).not.toHaveBeenCalled();
    await act(async () => editors.at(-1)!.onCreated!("44444444-4444-4444-8444-444444444444"));
    await act(async () => editors.at(-1)!.onLangChange!("en"));
    expect(frame.pageLangChanged).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444", "en");
  });
});
