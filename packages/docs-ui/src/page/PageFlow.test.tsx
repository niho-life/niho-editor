// @vitest-environment jsdom
import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PAGE_FLOW_SELF_KEY, PAGE_FLOW_TEXT, PageFlow, type PageFlowProps, type PageFlowRow } from "./PageFlow";

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

/** 流れの中（記事方針のタブを開いている）。記事本文は今のタブから作成中、その後ろの 2 段階はまだ無い。 */
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
  { key: "s4", kind: "step", name: "SNS 投稿", holder: null, tabs: [], current: false, from: null, action: "go" },
];

/** 直接書いたページ（流れの外。どの行も今でない）。段階は全部これから。 */
const WRITTEN: PageFlowRow[] = [
  { key: "rec", kind: "rec", name: "録音", holder: null, tabs: [], current: false, from: null, action: null },
  { key: "transcript", kind: "transcript", name: "文字起こし", holder: null, tabs: [], current: false, from: null, action: null },
  { key: "step:plan", kind: "step", name: "記事方針", holder: null, tabs: [], current: false, from: null, action: "go" },
  { key: "step:body", kind: "step", name: "記事本文", holder: null, tabs: [], current: false, from: null, action: "go" },
];

/** 録音のタブを開いている（段階は録音のタブからは作らない。文字起こしの行にエンジン）。 */
const RECORDING: PageFlowRow[] = [
  { key: "rec", kind: "rec", name: "合成の録音", holder: { id: "h-rec", title: "合成の録音" }, tabs: [{ id: "t-rec", label: "", status: null, running: false }], current: true, from: null, action: null },
  {
    key: "transcript", kind: "transcript", name: "文字起こし", holder: { id: "h-tr", title: "文字起こし" }, tabs: [{ id: "t-tr", label: "Gemini", status: null, running: false }], current: false, from: null, action: "go",
    engines: [{ id: "gemini", label: "Gemini", used: true }, { id: "deepgram", label: "Deepgram", used: false }],
  },
  { key: "step:fix", kind: "step", name: "文字起こし修正", holder: null, tabs: [], current: false, from: null, action: null },
  { key: "step:plan", kind: "step", name: "記事方針", holder: null, tabs: [], current: false, from: null, action: null },
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
const rowEls = () => [...host!.querySelectorAll<HTMLElement>(".es-flow-row")];
/** 行の名前（読み上げの言葉を含む）。 */
const names = () => rowEls().map((row) => row.querySelector(".es-flow-nm")?.textContent);
/** 行の状態（済み・いま・これから）と印（✓ は svg、○ は番号、● は空）。 */
const marks = () => rowEls().map((row) => {
  const state = row.className.match(/es-flow-row--(done|cur|todo)/)?.[1];
  const dot = row.querySelector(".es-flow-dot")!;
  return `${state}:${dot.querySelector(".es-busy") ? "busy" : dot.querySelector("svg") ? "✓" : dot.textContent || "●"}`;
});
const makeButtons = () => [...host!.querySelectorAll<HTMLButtonElement>(".es-flow-mk button")];
const pressable = () => [...host!.querySelectorAll<HTMLButtonElement>(".es-flow-go[aria-pressed]")];
/** 読み上げる文字（aria-hidden の印・札を除く）。 */
const spoken = (node: Element) => [...node.children].filter((child) => child.getAttribute("aria-hidden") !== "true").map((child) => child.textContent).join("");

describe("PageFlow（「手順」のカード。#309 → #344）", () => {
  it("流れの中: 見出しは手順名とフォルダ名。行は 録音 › 文字起こし › 段階… で、済み ✓・いま ●・これから ○（番号）。「（まだ）」は無い", async () => {
    const node = await render(props());
    expect(node.querySelector("section.es-flow")?.getAttribute("aria-label")).toBe("手順");
    expect(node.querySelector(".es-flow-hd")?.textContent).toBe("記事· 円覚寺の取材");
    expect(names()).toEqual([
      "合成の録音（済み）",
      "文字起こし（これから）",
      "文字起こし修正（済み）",
      "記事方針（いま開いているページ）",
      "記事本文（済み）",
      "共有用の要約（これから）",
      "SNS 投稿（これから）",
    ]);
    // 読み上げの言葉は見えない文字（印に頼らない）
    expect(node.querySelectorAll(".es-flow-nm .es-vh")).toHaveLength(7);
    // ✓ は入れ物があり今でない行、● は今の行、○ は番号（出している並びでの順番）。作成中は回る印
    expect(marks()).toEqual(["done:✓", "todo:2", "done:✓", "cur:●", "done:busy", "todo:6", "todo:7"]);
    expect(node.textContent).not.toContain("（まだ）");
    // 今の行は aria-current と「◯◯ から」。タブの札（2 つ以上のとき）と状態の言葉（作成中…）は小さく出す
    expect(node.querySelector('[aria-current="page"]')?.textContent).toContain("記事方針");
    expect(node.querySelector(".es-flow-row--cur .es-flow-src")?.textContent).toBe("文字起こし修正 から");
    expect(node.querySelector(".es-flow-row--cur small")?.textContent).toBe("1 · 2");
    expect(rowEls()[4]!.querySelector("small")?.textContent).toBe("作成中…");
  });

  it("作成のボタンは 1 つ（既定はいちばん後の段階まで）。段階の行を押すと目標が替わり「ここまで」の札。押すと目標の行を渡す", async () => {
    const input = props();
    const node = await render(input);
    // 行ごとの「作成」「済み」は無い
    expect(makeButtons()).toHaveLength(1);
    const make = makeButtons()[0]!;
    expect(make.className).toContain("es-btn--primary");
    // 今のタブの次（記事本文）から作り直すので 3 段階
    expect(make.textContent).toBe("SNS 投稿まで作る（3 段階）");
    expect(pressable().map((button) => [spoken(button), button.getAttribute("aria-pressed")])).toEqual([
      ["共有用の要約（これから）", "false"],
      ["SNS 投稿（これから）ここまで", "true"],
    ]);
    expect(node.querySelector(".es-flow-mk")?.textContent).toContain(PAGE_FLOW_TEXT.pickHint);
    // フォルダの中では「新しいフォルダにまとまります」は出さない
    expect(node.textContent).not.toContain(PAGE_FLOW_TEXT.outside);

    await act(async () => pressable()[0]!.click());
    expect(make.textContent).toBe("共有用の要約まで作る（2 段階）");
    expect(pressable().map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(rowEls()[5]!.querySelector(".es-flow-tag")?.textContent).toBe(PAGE_FLOW_TEXT.goal);
    // 目標より後ろの段階は薄く（作らない）
    expect(rowEls()[6]!.className).toContain("es-flow-row--after");
    await act(async () => make.click());
    expect(input.onMake).toHaveBeenCalledWith(ROWS[5]);

    // ✓ の行を押すと、その入れ物を開く（今の行は押せない）
    const fix = buttons().find((button) => button.title === PAGE_FLOW_TEXT.open("文字起こし修正"))!;
    await act(async () => fix.click());
    expect(input.onOpen).toHaveBeenCalledWith("h0");
    expect(node.querySelector(".es-flow-row--cur button")).toBeNull();
  });

  it("目標までが 1 段階なら「（N 段階）」を添えず、段階を選ぶ一言も出さない。作れる段階が無ければボタンを出さない", async () => {
    const one = ROWS.map((row) => (row.key === "s2" || row.key === "s4" ? { ...row, action: null } : row));
    const node = await render(props({ rows: one.filter((row) => row.key !== "s4") }));
    expect(makeButtons().map((button) => button.textContent)).toEqual(["共有用の要約まで作る"]);
    expect(node.querySelector(".es-flow-mk")?.textContent).not.toContain(PAGE_FLOW_TEXT.pickHint);
    act(() => root?.unmount());
    host?.remove();

    await render(props({ rows: ROWS.map((row) => ({ ...row, action: row.action === "go" ? null : row.action })) }));
    expect(host!.querySelector(".es-flow-mk")).toBeNull();
    expect(pressable()).toEqual([]);
  });

  it("送っている間は作成を押せない（aria-disabled と回る印。文字は薄めない）", async () => {
    const input = props({ busy: true });
    await render(input);
    const make = makeButtons()[0]!;
    expect(make.getAttribute("aria-disabled")).toBe("true");
    expect(make.querySelector(".es-busy")).not.toBeNull();
    await act(async () => make.click());
    expect(input.onMake).not.toHaveBeenCalled();
  });

  it("流れの外（直接書いたページ）: 録音・文字起こしは出さず「このページ」から始める。フォルダの外ならボタンの下に一言", async () => {
    const input = props({ rows: WRITTEN, folder: null, note: null });
    const node = await render(input);
    // 見出しはフォルダ名を出さない（フォルダの外の長い一言も無い）
    expect(node.querySelector(".es-flow-hd")?.textContent).toBe("記事");
    expect(names()).toEqual(["このページ（いま開いているページ）", "記事方針（これから）", "記事本文（これから）"]);
    expect(marks()).toEqual(["cur:●", "todo:2", "todo:3"]);
    expect(rowEls()[0]!.querySelector(".es-flow-tag--now")?.textContent).toBe(PAGE_FLOW_TEXT.now);
    expect(makeButtons().map((button) => button.textContent)).toEqual(["記事本文まで作る（2 段階）"]);
    expect([...node.querySelectorAll(".es-flow-mk p")].map((line) => line.textContent)).toEqual([PAGE_FLOW_TEXT.pickHint, PAGE_FLOW_TEXT.outside]);
    await act(async () => makeButtons()[0]!.click());
    expect(input.onMake).toHaveBeenCalledWith(WRITTEN[3]);
    expect(rowEls()[0]!.closest("li")?.querySelector("button")).toBeNull();
    expect(PAGE_FLOW_SELF_KEY).toBe("self");
  });

  it("録音のタブ: ボタンは「文字起こしを作る ▾」でエンジンのメニュー（使ったエンジンは済みで押せない）。段階は押せない", async () => {
    const input = props({ rows: RECORDING });
    const node = await render(input);
    expect(marks()).toEqual(["cur:●", "done:✓", "todo:3", "todo:4"]);
    expect(pressable()).toEqual([]);
    const open = makeButtons()[0]!;
    expect(makeButtons()).toHaveLength(1);
    expect(open.textContent).toBe(PAGE_FLOW_TEXT.transcribe);
    expect(open.getAttribute("aria-haspopup")).toBe("menu");
    expect(node.querySelector(".es-flow-mk")?.textContent).not.toContain(PAGE_FLOW_TEXT.pickHint);
    await act(async () => open.click());
    expect(open.getAttribute("aria-expanded")).toBe("true");
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

  it("一言（role=status）と run の操作を描く。ボタンに名前がある。axe の serious 以上ゼロ（流れの中・外・録音のタブ）", async () => {
    const onAction = vi.fn();
    const node = await render(props({ actions: [{ id: "cancel", label: "やめる", tone: "quiet" }, { id: "retry", label: "やり直す", busy: true }], onAction }));
    expect(node.querySelector('[role="status"]')?.textContent).toBe("「記事本文」を作成中です。画面を閉じても進みます。");
    const cancel = buttons().find((button) => button.textContent === "やめる")!;
    await act(async () => cancel.click());
    expect(onAction).toHaveBeenCalledWith("cancel");
    const retry = buttons().find((button) => button.textContent?.includes("やり直す"))!;
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    for (const rows of [ROWS, WRITTEN, RECORDING]) {
      await act(async () => root!.render(<PageFlow {...props({ rows, folder: null })} />));
      for (const button of buttons()) expect(button.getAttribute("aria-label") || button.textContent?.trim(), button.outerHTML).toBeTruthy();
      const result = await axe.run(node, { rules: { "color-contrast": { enabled: false } } });
      expect(result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
    }
  });
});
