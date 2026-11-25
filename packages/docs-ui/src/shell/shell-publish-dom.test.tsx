// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublishSheet, type PublishDestOption, type PublishFormProps } from "./index";

/*
 * 公開のシートに #39 で足した optional な props（URL の欄・主ボタンの文言と無効・失敗の 1 行・選べない発信先）と、
 * 公開をやめる確認（kind="stop"）。渡さないときの見た目と振る舞いは shell-sheet-dom.test.tsx・shell-screens.test.tsx のまま。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots.length = 0;
  document.body.innerHTML = "";
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  return host;
}

const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());
const byText = (host: ParentNode, selector: string, text: string) => [...host.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.trim().startsWith(text));

/** React の制御された input へ打つ（value の setter を通して input を起こす）。 */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const DESTS: PublishDestOption[] = [
  { id: "exp", label: "NIHO Travel", who: "旅行者向け · 英語", url: "travel.example.test/guides/x", role: "ライター", connected: true },
  { id: "niho", label: "NIHO", who: "鎌倉の人向け", url: "", role: "NIHO アカウント", connected: false, note: "いまは公開できません" },
  { id: "site", label: "自分のサイト", who: "本人のサイト", url: "", role: "接続済み", connected: false },
];

function form(props: Partial<PublishFormProps> = {}) {
  const base: PublishFormProps = {
    dests: DESTS,
    picked: "exp",
    missing: [],
    range: "live",
    extras: { app: false, news: false, xp: false },
    onPick: vi.fn(),
    onConnect: vi.fn(),
    onRange: vi.fn(),
    onExtra: vi.fn(),
    onFix: vi.fn(),
    onPublish: vi.fn(),
    onClose: vi.fn(),
  };
  return { ...base, ...props };
}

describe("公開のシート（#39 で足した props）", () => {
  it("URL の欄: 初回の公開までは「URL」の入力で、打つと onChange(値)。使えないときは一言と aria-invalid", () => {
    const onChange = vi.fn();
    const host = mount(<PublishSheet kind="publish" {...form({ slug: { prefix: "travel.example.test/guides/", value: "morning-walk", editable: true, onChange } })} />);
    const input = host.querySelector<HTMLInputElement>("input.es-input")!;
    const label = [...host.querySelectorAll("label")].find((node) => node.getAttribute("for") === input.id);
    expect(label?.textContent).toBe("URL");
    expect(input.value).toBe("morning-walk");
    expect(host.querySelector(".es-slug")!.textContent).toContain("travel.example.test/guides/");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(document.getElementById(input.getAttribute("aria-describedby")!)!.textContent).toBe("公開するまで変えられます");
    type(input, "morning-walk-2");
    expect(onChange).toHaveBeenCalledWith("morning-walk-2");

    const taken = mount(<PublishSheet kind="publish" {...form({ slug: { prefix: "travel.example.test/guides/", value: "index", editable: true, error: "この URL は使えません" } })} />);
    const invalid = taken.querySelector<HTMLInputElement>("input.es-input")!;
    expect(invalid.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(invalid.getAttribute("aria-describedby")!)!.textContent).toBe("この URL は使えません");
  });

  it("URL の欄: 公開したあとは入力を出さず、URL と「公開したあとは変えられません」だけ", () => {
    const host = mount(<PublishSheet kind="publish" {...form({ current: {}, slug: { prefix: "travel.example.test/guides/", value: "morning-walk", editable: false } })} />);
    expect(host.querySelector("input")).toBeNull();
    expect(host.querySelector(".es-sh-url")!.textContent).toBe("travel.example.test/guides/morning-walk");
    expect(host.textContent).toContain("公開したあとは変えられません");
  });

  it("slug を渡さなければ URL の欄は出さない（足もとの URL だけ）", () => {
    const host = mount(<PublishSheet kind="publish" {...form()} />);
    expect(host.querySelector(".es-slug")).toBeNull();
    expect(host.querySelector(".es-sh-url")).toBeNull();
    expect(host.querySelector("code.es-sh-note")!.textContent).toBe("travel.example.test/guides/x");
  });

  it("主ボタン: action で文言を替え、submitDisabled のあいだは押せない", () => {
    const onPublish = vi.fn();
    const host = mount(<PublishSheet kind="publish" {...form({ current: {}, action: "発信先を変える", submitDisabled: true, onPublish })} />);
    const button = byText(host, "button", "発信先を変える") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    click(button);
    expect(onPublish).not.toHaveBeenCalled();
    const ready = mount(<PublishSheet kind="publish" {...form({ current: {}, action: "発信先を変える", onPublish })} />);
    click(byText(ready, "button", "発信先を変える"));
    expect(onPublish).toHaveBeenCalledTimes(1);
  });

  it("失敗の 1 行は role=alert で足もとに出る。渡さなければ出ない", () => {
    const host = mount(<PublishSheet kind="publish" {...form({ error: "公開できませんでした。前の公開版と下書きはそのままです" })} />);
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe("公開できませんでした。前の公開版と下書きはそのままです");
    expect(alert.closest(".es-sh-foot")).not.toBeNull();
    const quiet = mount(<PublishSheet kind="publish" {...form()} />);
    expect(quiet.querySelector('[role="alert"]')).toBeNull();
  });

  it("選べない発信先（note）: 一言を出し、ボタンにしない（押しても onPick・onConnect を呼ばない）。note の無い未接続は「接続する ›」のまま", () => {
    const props = form();
    const host = mount(<PublishSheet kind="publish" {...props} />);
    const off = host.querySelector(".es-dst--off")!;
    expect(off.tagName).toBe("DIV");
    expect(off.textContent).toContain("NIHO");
    expect(off.textContent).toContain("いまは公開できません");
    click(off);
    expect(props.onPick).not.toHaveBeenCalled();
    expect(props.onConnect).not.toHaveBeenCalled();
    const site = byText(host, "button", "自分のサイト")!;
    expect(site.textContent).toContain("接続する");
    click(site);
    expect(props.onConnect).toHaveBeenCalledWith("site");
  });
});

describe("公開をやめる確認（kind=stop）", () => {
  it("開くと「やめない」にフォーカス。公開をやめる → onConfirm、やめない → onCancel、Esc → onClose", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const onClose = vi.fn();
    const host = mount(
      <PublishSheet kind="stop" dest="NIHO" detail="URL は NIHO の一覧へ転送されます。" onConfirm={onConfirm} onCancel={onCancel} onClose={onClose} />,
    );
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("公開をやめる");
    expect(dialog.querySelector("h2")!.textContent).toBe("NIHO での公開をやめますか");
    expect(host.textContent).toContain("URL は NIHO の一覧へ転送されます。");
    expect(document.activeElement?.textContent).toBe("やめない");
    click(byText(host, "button", "公開をやめる"));
    click(byText(host, "button", "やめない"));
    expect([onConfirm, onCancel].map((fn) => fn.mock.calls.length)).toEqual([1, 1]);
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("送っている途中（busy）は「公開をやめる」を押せず、失敗は role=alert の 1 行", () => {
    const onConfirm = vi.fn();
    const host = mount(
      <PublishSheet kind="stop" dest="NIHO" detail="x" busy error="公開をやめられませんでした" onConfirm={onConfirm} onCancel={vi.fn()} onClose={vi.fn()} />,
    );
    const confirm = byText(host, "button", "公開をやめる") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("公開をやめられませんでした");
  });
});
