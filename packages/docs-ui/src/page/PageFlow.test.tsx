// @vitest-environment jsdom
import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PAGE_FLOW_TEXT, PageFlow, type PageFlowProps, type PageFlowRow } from "./PageFlow";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const ROWS: PageFlowRow[] = [
  { key: "rec", kind: "rec", name: "合成の録音", holder: { id: "h-rec", title: "合成の録音" }, tabs: [{ id: "t-rec", label: "", status: null, running: false }], current: false, from: null, action: null },
  { key: "transcript", kind: "transcript", name: "文字起こし", holder: null, tabs: [], current: false, from: null, action: null },
  { key: "s0", kind: "step", name: "文字起こし修正", holder: { id: "h0", title: "文字起こし修正" }, tabs: [{ id: "t0", label: "1", status: "done", running: false }], current: false, from: null, action: null },
  {
    key: "s1", kind: "step", name: "記事方針", holder: { id: "h1", title: "記事方針" }, current: true, from: "文字起こし修正", action: null,
    tabs: [{ id: "t1a", label: "1", status: "done", running: false }, { id: "t1b", label: "2", status: "done", running: false }],
  },
  { key: "s2", kind: "step", name: "記事本文", holder: { id: "h2", title: "記事本文" }, tabs: [{ id: "t2", label: "1", status: "run", running: true }], current: false, from: null, action: "done" },
  { key: "s3", kind: "step", name: "共有用の要約", holder: null, tabs: [], current: false, from: null, action: "go" },
];

function props(over: Partial<PageFlowProps> = {}): PageFlowProps {
  return {
    recipe: { id: "tpl-1", name: "記事" },
    recipes: [{ id: "tpl-1", name: "記事" }, { id: "tpl-2", name: "議事録" }, { id: "r-x", name: "壊れた手順", unusableReason: "段階がありません" }],
    folder: { id: "f", title: "円覚寺の取材" },
    rows: ROWS,
    busy: false,
    note: "「記事本文」を作成中です。画面を閉じても進みます。",
    onOpen: vi.fn(),
    onMake: vi.fn(),
    onTranscribe: vi.fn(),
    onChangeRecipe: vi.fn(),
    ...over,
  };
}

async function render(input: PageFlowProps): Promise<HTMLElement> {
  host = document.createElement("div");
  host.className = "es-root";
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<PageFlow {...input} />));
  return host;
}

const buttons = () => [...host!.querySelectorAll<HTMLButtonElement>("button")];
const byLabel = (label: string) => buttons().find((button) => button.getAttribute("aria-label") === label) ?? null;

describe("PageFlow（「ページ」パネルの流れ。#309）", () => {
  it("見出しは手順名とフォルダ名、行は 録音 › 文字起こし › 段階… で、無い段階は「（まだ）」", async () => {
    const node = await render(props());
    expect(node.querySelector(".es-flow-hd")?.textContent).toBe("記事· 円覚寺の取材");
    const rows = [...node.querySelectorAll(".es-flow-row")].map((row) => row.querySelector(".es-flow-go")?.textContent);
    // タブの札はタブが 2 つ以上のときだけ。状態の言葉（作成中…）は 1 つでも出す
    expect(rows).toEqual(["合成の録音", `文字起こし${PAGE_FLOW_TEXT.none}`, "文字起こし修正", "記事方針1 · 2文字起こし修正 から", "記事本文作成中…", `共有用の要約${PAGE_FLOW_TEXT.none}`]);
    // 今の行は aria-current と「◯◯ から」。作成中は回る印（色だけでなく言葉でも出す）
    expect(node.querySelector('[aria-current="page"]')?.textContent).toContain("記事方針");
    expect(node.querySelector(".es-flow-row--cur .es-flow-src")?.textContent).toBe("文字起こし修正 から");
    expect(node.querySelectorAll(".es-flow-go .es-busy")).toHaveLength(1);
  });

  it("右端は 作成（押せる）と 済み（押せない）。作成は行を渡し、行を押すとその入れ物を開く", async () => {
    const input = props();
    await render(input);
    const make = byLabel(PAGE_FLOW_TEXT.makeLabel("共有用の要約"))!;
    expect(make.textContent).toBe(PAGE_FLOW_TEXT.make);
    await act(async () => make.click());
    expect(input.onMake).toHaveBeenCalledWith(ROWS[5]);
    const done = byLabel(PAGE_FLOW_TEXT.doneLabel("記事本文"))!;
    expect(done.disabled).toBe(true);
    expect(done.textContent).toBe(PAGE_FLOW_TEXT.done);
    // 今のページより前の段階と録音の行には出ない
    expect(byLabel(PAGE_FLOW_TEXT.makeLabel("文字起こし修正"))).toBeNull();
    expect(byLabel(PAGE_FLOW_TEXT.makeLabel("合成の録音"))).toBeNull();
    await act(async () => byLabel(PAGE_FLOW_TEXT.open("文字起こし修正"))!.click());
    expect(input.onOpen).toHaveBeenCalledWith("h0");
  });

  it("送っている間は作成を押せない（aria-disabled。文字は薄めない）", async () => {
    const input = props({ busy: true });
    await render(input);
    const make = byLabel(PAGE_FLOW_TEXT.makeLabel("共有用の要約"))!;
    expect(make.getAttribute("aria-disabled")).toBe("true");
    await act(async () => make.click());
    expect(input.onMake).not.toHaveBeenCalled();
  });

  it("文字起こしの行は、録音のタブを開いているときエンジンのメニュー。使ったエンジンは済みで押せない", async () => {
    const rows: PageFlowRow[] = ROWS.map((row) => row.key === "transcript" ? { ...row, engines: [{ id: "gemini", label: "Gemini", used: true }, { id: "deepgram", label: "Deepgram", used: false }] } : row);
    const input = props({ rows });
    const node = await render(input);
    const open = byLabel(PAGE_FLOW_TEXT.makeLabel("文字起こし"))!;
    expect(open.getAttribute("aria-haspopup")).toBe("menu");
    await act(async () => open.click());
    const items = [...node.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual([`Gemini${PAGE_FLOW_TEXT.engineUsed}`, "Deepgram"]);
    expect(items[0]!.getAttribute("aria-disabled")).toBe("true");
    await act(async () => items[0]!.click());
    expect(input.onTranscribe).not.toHaveBeenCalled();
    await act(async () => items[1]!.click());
    expect(input.onTranscribe).toHaveBeenCalledWith("deepgram");
    expect(node.querySelector('[role="menu"]')).toBeNull();
  });

  it("見出しの ▾ でフォルダの手順を替える（今の手順と使えない手順は押せない）", async () => {
    const input = props();
    const node = await render(input);
    await act(async () => byLabel(PAGE_FLOW_TEXT.recipeButton("記事"))!.click());
    const items = [...node.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')];
    expect(items.map((item) => item.getAttribute("aria-disabled"))).toEqual(["true", null, "true"]);
    await act(async () => items[1]!.click());
    expect(input.onChangeRecipe).toHaveBeenCalledWith("tpl-2");
  });

  it("フォルダの外では一言を出し、一言（role=status）と run の操作を描く。ボタンに名前がある。axe の serious 以上ゼロ", async () => {
    const onAction = vi.fn();
    const node = await render(props({ folder: null, actions: [{ id: "cancel", label: "やめる", tone: "quiet" }, { id: "retry", label: "やり直す", busy: true }], onAction }));
    expect(node.querySelector(".es-flow-folder")?.textContent).toBe(`· ${PAGE_FLOW_TEXT.outside}`);
    expect(node.querySelector('[role="status"]')?.textContent).toBe("「記事本文」を作成中です。画面を閉じても進みます。");
    const cancel = buttons().find((button) => button.textContent === "やめる")!;
    await act(async () => cancel.click());
    expect(onAction).toHaveBeenCalledWith("cancel");
    const retry = buttons().find((button) => button.textContent?.includes("やり直す"))!;
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    for (const button of buttons()) expect(button.getAttribute("aria-label") || button.textContent?.trim(), button.outerHTML).toBeTruthy();
    const result = await axe.run(node, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
  });
});
