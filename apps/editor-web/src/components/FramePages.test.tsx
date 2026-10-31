// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EditorProps = {
  page?: { id: string | null; title?: string; blocks?: unknown[]; revision?: number | null; lang?: string };
  onCreated?: (id: string) => void;
  onLangChange?: (lang: "ja" | "en") => void;
};
const editors: EditorProps[] = [];
const frame = { pageCreated: vi.fn(), pageTitleChanged: vi.fn(), pageSaved: vi.fn(), pageOpened: vi.fn(), pageLangChanged: vi.fn(), narrow: false };
/** 手順の帯が「この段階の本文が入れ替わった」と知らせる口（PageSteps のモックが預かる）。 */
const steps: { onBodyReplaced?: () => void } = {};

vi.mock("next/navigation", () => ({ usePathname: () => "/p/new", useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }));
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
vi.mock("@/lib/pages-client", () => ({ readPageRequest: vi.fn() }));

import { rememberLastPage } from "@/lib/last-page";
import { readPageRequest } from "@/lib/pages-client";
import { NewPage, OpenPage } from "./FramePages";

const readPage = vi.mocked(readPageRequest);

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  editors.length = 0;
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/p/new");
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
