// @vitest-environment jsdom
import { useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountPage,
  EditorShell,
  PublishSheet,
  SettingsPage,
  ShellField,
  ShellRail,
  ShellRailSection,
  ShellSettingsPage,
  ShellToggle,
  SitePage,
  type PublishDestOption,
  type PublishExtras,
  type PublishRange,
  type ShellDest,
} from "./index";

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

const key = (target: Element | Document, name: string, init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
  });
const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());
const byText = (host: ParentNode, selector: string, text: string) => [...host.querySelectorAll<HTMLButtonElement>(selector)].find((el) => el.textContent?.trim().startsWith(text));

const DESTS: PublishDestOption[] = [
  { id: "exp", label: "NIHO Experience", who: "旅行者向け · 英語", url: "experience.niho.life/guides/x", role: "ライター", connected: true },
  { id: "niho", label: "NIHO", who: "鎌倉の人向け", url: "niho.life/article/x", role: "NIHO アカウント", connected: true },
  { id: "site", label: "自分のサイト", who: "本人のサイト", url: "mika-sato.example/posts/x", role: "接続済み", connected: true },
];

/** 公開のシートを開閉する呼ぶ側（状態は呼ぶ側が持つ）。 */
function Opener({ missing = [], onFix = vi.fn(), onPublish = vi.fn() }: { missing?: { id: string; label: string }[]; onFix?: (id: string) => void; onPublish?: () => void }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ShellDest | undefined>(undefined);
  const [range, setRange] = useState<PublishRange>("live");
  const [extras, setExtras] = useState<PublishExtras>({ app: true, news: false, xp: true });
  return (
    <EditorShell
      sidebar={null}
      header={
        <button type="button" onClick={() => setOpen(true)}>
          公開
        </button>
      }
      sidebarOpen={false}
      railOpen={false}
      overlay={
        open ? (
          <PublishSheet
            kind="publish"
            dests={DESTS}
            picked={picked}
            missing={picked === "exp" ? missing : []}
            range={range}
            extras={extras}
            onPick={setPicked}
            onRange={setRange}
            onExtra={(extra) => setExtras((current) => ({ ...current, [extra]: !current[extra] }))}
            onFix={onFix}
            onPublish={onPublish}
            onClose={() => setOpen(false)}
          />
        ) : undefined
      }
    >
      x
    </EditorShell>
  );
}

describe("公開のシート（dialog・Esc・フォーカス）", () => {
  it("開くと role=dialog（aria-label=公開）が .es-root の中に出て、中（先頭の発信先）へフォーカスが移る", () => {
    const host = mount(<Opener />);
    const opener = byText(host, "button", "公開")!;
    act(() => opener.focus());
    click(opener);
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("公開");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(host.querySelector(".es-root")!.contains(dialog)).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toContain("NIHO Experience");
  });

  it("Esc で閉じ、フォーカスは開いた公開ボタンへ戻る", () => {
    const host = mount(<Opener />);
    const opener = byText(host, "button", "公開")!;
    act(() => opener.focus());
    click(opener);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    key(document.activeElement!, "Escape");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("幕（シートの外）を押すと閉じる。シートの中を押しても閉じない", () => {
    const host = mount(<Opener />);
    click(byText(host, "button", "公開"));
    act(() => {
      host.querySelector(".es-sheet")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => {
      host.querySelector(".es-veil")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Tab はシートの中で回る（最後から先頭へ、Shift+Tab で先頭から最後へ）", () => {
    const host = mount(<Opener />);
    click(byText(host, "button", "公開"));
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const items = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled)")];
    const first = items[0]!;
    const last = items[items.length - 1]!;
    act(() => last.focus());
    key(last, "Tab");
    expect(document.activeElement).toBe(first);
    act(() => first.focus());
    key(first, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe("公開のシート（外を inert にする。#43）", () => {
  const inertOf = (host: HTMLElement) => [...host.querySelectorAll("[inert]")].map((el) => el.className || el.tagName.toLowerCase());

  it("開いているあいだ、シートの外（.es-root の中の兄弟: 本文へ移動・枠）は inert。シート自身は inert でない", () => {
    const host = mount(<Opener />);
    expect(inertOf(host)).toEqual([]);
    click(byText(host, "button", "公開"));
    const root = host.querySelector(".es-root")!;
    const veil = host.querySelector<HTMLElement>(".es-veil")!;
    expect(veil.parentElement).toBe(root);
    // .es-root の子のうち、幕（veil）以外がすべて inert
    for (const child of root.children) expect(child.hasAttribute("inert"), child.className).toBe(child !== veil);
    expect(inertOf(host)).toEqual(["es-skip", "es-ws"]);
    expect(veil.closest("[inert]")).toBeNull();
    expect(host.querySelector('[role="dialog"]')!.closest("[inert]")).toBeNull();
  });

  it("閉じると inert を外し、そのあとで開いた公開ボタンへフォーカスを戻す", () => {
    const host = mount(<Opener />);
    const opener = byText(host, "button", "公開")!;
    act(() => opener.focus());
    click(opener);
    expect(opener.closest("[inert]")).not.toBeNull();
    key(document.activeElement!, "Escape");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(inertOf(host)).toEqual([]);
    expect(document.activeElement).toBe(opener);
  });

  it("開く前から inert・aria-hidden だった要素は、閉じても元のまま（付けた分だけを外す）", () => {
    const host = mount(<Opener />);
    const ws = host.querySelector(".es-ws")!;
    const skip = host.querySelector(".es-skip")!;
    ws.setAttribute("inert", "");
    skip.setAttribute("aria-hidden", "true");
    click(byText(host, "button", "公開"));
    expect(ws.hasAttribute("inert")).toBe(true);
    expect(skip.hasAttribute("inert")).toBe(true);
    act(() => {
      host.querySelector(".es-veil")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    // もとから inert だった枠は inert のまま、付けた「本文へ移動」の inert は外れ、aria-hidden には触らない
    expect(ws.hasAttribute("inert")).toBe(true);
    expect(skip.hasAttribute("inert")).toBe(false);
    expect(skip.getAttribute("aria-hidden")).toBe("true");
  });

  it(".es-root の外（同じページの別の要素）には触らない", () => {
    const outside = document.createElement("div");
    outside.className = "outside";
    document.body.append(outside);
    const host = mount(<Opener />);
    click(byText(host, "button", "公開"));
    expect(outside.hasAttribute("inert")).toBe(false);
    expect(host.hasAttribute("inert")).toBe(false);
  });
});

/** レールを開閉する呼ぶ側。withClose が false なら ShellRail に onClose を渡さない（従来の全画面）。 */
function RailOpener({ withClose = true, sidebarOpen = false }: { withClose?: boolean; sidebarOpen?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <EditorShell
      sidebar={
        <aside className="es-sb" aria-label="ページ">
          <button type="button">一覧の項目</button>
        </aside>
      }
      header={
        <header className="es-dt">
          <button type="button" aria-expanded={open} aria-controls="es-rail" onClick={() => setOpen((value) => !value)}>
            このページの設定と AI
          </button>
        </header>
      }
      rail={
        <ShellRail onClose={withClose ? () => setOpen(false) : undefined}>
          <ShellRailSection title="ページ設定" open onToggle={() => undefined}>
            <button type="button">言語</button>
          </ShellRailSection>
          <ShellRailSection title="AIと作る" fill>
            <input type="text" aria-label="AI に相談" />
          </ShellRailSection>
        </ShellRail>
      }
      sidebarOpen={sidebarOpen}
      railOpen={open}
    >
      本文
    </EditorShell>
  );
}

describe("レールのシート（900px 未満。#43）", () => {
  let narrow = true;
  beforeEach(() => {
    narrow = true;
    window.matchMedia = ((query: string) => ({ matches: narrow && query === "(max-width:900px)", media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  const open = (host: HTMLElement) => {
    const opener = byText(host, "button", "このページの設定と AI")!;
    act(() => opener.focus());
    click(opener);
    return opener;
  };

  it("onClose があると role=dialog（aria-modal・レールの名前）の下からのシートになり、開くと中へフォーカスが移る", () => {
    const host = mount(<RailOpener />);
    open(host);
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("AIと作る");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.classList.contains("es-sheet--rail")).toBe(true);
    expect(dialog.querySelector("h2")?.textContent).toBe("AIと作る");
    // aria-controls の先（#es-rail）はシートの中。aside（landmark）は重ねない
    expect(dialog.querySelector("#es-rail")).not.toBeNull();
    expect(host.querySelector("aside.es-rail")).toBeNull();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("Esc で閉じ、フォーカスは開いたボタンへ戻る。AI の入力欄の中の Esc でも閉じる", () => {
    const host = mount(<RailOpener />);
    const opener = open(host);
    key(document.activeElement!, "Escape");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);

    open(host);
    const input = host.querySelector<HTMLInputElement>('input[aria-label="AI に相談"]')!;
    act(() => input.focus());
    key(input, "Escape");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("幕と「閉じる」で閉じる。シートの中を押しても閉じない", () => {
    const host = mount(<RailOpener />);
    open(host);
    act(() => {
      host.querySelector(".es-sheet")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => {
      host.querySelector(".es-veil")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    open(host);
    click(byText(host, '[role="dialog"] button', "閉じる"));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("Tab はシートの中で回る（「閉じる」から AI の入力欄まで）", () => {
    const host = mount(<RailOpener />);
    open(host);
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const first = byText(dialog, "button", "閉じる")!;
    const last = dialog.querySelector<HTMLInputElement>('input[aria-label="AI に相談"]')!;
    act(() => last.focus());
    key(last, "Tab");
    expect(document.activeElement).toBe(first);
    key(first, "Tab", { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("開いているあいだ、シートの外（本文・ヘッダー・一覧・本文へ移動）は inert。閉じると外す", () => {
    const host = mount(<RailOpener />);
    open(host);
    const inert = [...host.querySelectorAll("[inert]")].map((el) => el.className);
    expect(inert.sort()).toEqual(["es-canvas", "es-dt", "es-sb", "es-skip"]);
    expect(host.querySelector('[role="dialog"]')!.closest("[inert]")).toBeNull();
    key(document.activeElement!, "Escape");
    // 閉じたレールは会話 state を保つため mount したまま、専用 wrapper だけが hidden + inert になる。
    expect([...host.querySelectorAll("[inert]")].map((element) => element.className)).toEqual(["es-rail-presence"]);
    expect(host.querySelector<HTMLElement>(".es-rail-presence")?.hidden).toBe(true);
  });

  it("一覧が全画面のあいだ（view=list）は、隠れているレールをダイアログにしない: 見えている一覧を inert にしない", () => {
    const host = mount(<RailOpener sidebarOpen />);
    open(host);
    expect(host.querySelector("[data-editor-shell]")?.getAttribute("data-view")).toBe("list");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector("aside.es-rail")).not.toBeNull();
    expect(host.querySelector("aside.es-sb")?.closest("[inert]")).toBeNull();
    expect(byText(host, "button", "一覧の項目")?.closest("[inert]")).toBeNull();
  });

  it("一覧が閉じてレールが開いている（view=rail）あいだだけシートになる", () => {
    const host = mount(<RailOpener />);
    open(host);
    expect(host.querySelector("[data-editor-shell]")?.getAttribute("data-view")).toBe("rail");
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("900px 以上、または onClose が無いときは、従来どおり aside（ダイアログにしない）", () => {
    narrow = false;
    const wide = mount(<RailOpener />);
    open(wide);
    expect(wide.querySelector('[role="dialog"]')).toBeNull();
    expect(wide.querySelector('aside.es-rail[aria-label="AIと作る"]')).not.toBeNull();

    narrow = true;
    const legacy = mount(<RailOpener withClose={false} />);
    open(legacy);
    expect(legacy.querySelector('[role="dialog"]')).toBeNull();
    expect(legacy.querySelector("aside.es-rail")).not.toBeNull();
  });
});

describe("公開のシート（選ぶ・直す・公開）", () => {
  it("発信先を選ぶと条件と範囲が出て、radio の aria-checked が替わる", () => {
    const host = mount(<Opener />);
    click(byText(host, "button", "公開"));
    expect(host.textContent).toContain("発信先を選ぶと条件が出ます");
    expect(byText(host, "button", "公開する")!.disabled).toBe(true);
    click(byText(host, '[role="radio"]', "NIHO Experience"));
    expect(byText(host, '[role="radio"]', "NIHO Experience")!.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("NIHO Experience の条件はそろっています");
    expect(byText(host, "button", "公開する")!.disabled).toBe(false);
    click(byText(host, '[role="radio"]', "限定公開"));
    expect(byText(host, '[role="radio"]', "限定公開")!.getAttribute("aria-checked")).toBe("true");
    expect(byText(host, '[role="radio"]', "公開")!.getAttribute("aria-checked")).toBe("false");
  });

  it("あわせて: 押すと aria-checked が替わる。体験ページに載せるは NIHO Experience 以外では押せない", () => {
    const host = mount(<Opener />);
    click(byText(host, "button", "公開"));
    click(byText(host, '[role="radio"]', "NIHO Experience"));
    const news = byText(host, '[role="checkbox"]', "ニュースレター")!;
    expect(news.getAttribute("aria-checked")).toBe("false");
    click(news);
    expect(news.getAttribute("aria-checked")).toBe("true");
    const xp = byText(host, '[role="checkbox"]', "体験ページに載せる")!;
    click(xp);
    expect(xp.getAttribute("aria-checked")).toBe("false");
    click(byText(host, '[role="radio"]', "自分のサイト"));
    const xpOff = byText(host, '[role="checkbox"]', "体験ページに載せる")!;
    expect(xpOff.getAttribute("aria-disabled")).toBe("true");
    click(xpOff);
    expect(xpOff.getAttribute("aria-checked")).toBe("false");
  });

  it("足りないものがあれば公開は押せず、「直す」で onFix(id)", () => {
    const onFix = vi.fn();
    const onPublish = vi.fn();
    const host = mount(<Opener missing={[{ id: "cat", label: "カテゴリ" }]} onFix={onFix} onPublish={onPublish} />);
    click(byText(host, "button", "公開"));
    click(byText(host, '[role="radio"]', "NIHO Experience"));
    expect(host.textContent).toContain("あと 1 つ");
    const publish = byText(host, "button", "公開する")!;
    expect(publish.disabled).toBe(true);
    click(publish);
    expect(onPublish).not.toHaveBeenCalled();
    click(byText(host, "button", "直す"));
    expect(onFix).toHaveBeenCalledWith("cat");
  });

  it("条件がそろえば「公開する」で onPublish", () => {
    const onPublish = vi.fn();
    const host = mount(<Opener onPublish={onPublish} />);
    click(byText(host, "button", "公開"));
    click(byText(host, '[role="radio"]', "NIHO"));
    click(byText(host, "button", "公開する"));
    expect(onPublish).toHaveBeenCalledTimes(1);
  });
});

describe("公開しました・発信先を追加", () => {
  it("公開しました: 開くと「見る」にフォーカス。見る・コピー・閉じるが呼ばれ、Esc でも閉じる", () => {
    const onView = vi.fn();
    const onCopy = vi.fn();
    const onClose = vi.fn();
    const host = mount(<PublishSheet kind="done" host="niho.life" url="niho.life/article/x" onView={onView} onCopy={onCopy} onClose={onClose} />);
    expect(host.querySelector('[role="dialog"]')!.getAttribute("aria-label")).toBe("公開しました");
    expect(document.activeElement?.textContent).toBe("見る");
    click(byText(host, "button", "見る"));
    click(byText(host, "button", "リンクをコピー"));
    click(byText(host, "button", "閉じる"));
    expect([onView, onCopy, onClose].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
    key(document.activeElement!, "Escape");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("発信先を追加: 選ぶと onPick(id)。先頭にフォーカス", () => {
    const onPick = vi.fn();
    const host = mount(<PublishSheet kind="addDest" onPick={onPick} onClose={vi.fn()} />);
    expect(document.activeElement?.textContent).toContain("公開APIで受け取る");
    click(byText(host, "button", "WordPress"));
    expect(onPick).toHaveBeenCalledWith("wordpress");
  });
});

describe("設定系ページの部品", () => {
  it("スイッチ: 押すと onChange(反転)。aria-checked が props に従う", () => {
    const onChange = vi.fn();
    const host = mount(<ShellToggle checked={false} label="話者の推定" onChange={onChange} />);
    const toggle = host.querySelector<HTMLElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("入力: label が入力と結ばれ、打つと onChange(値)", () => {
    const onChange = vi.fn();
    const host = mount(<ShellField label="名前" value="Mika" onChange={onChange} />);
    const input = host.querySelector<HTMLInputElement>("input")!;
    expect(host.querySelector("label")!.getAttribute("for")).toBe(input.id);
    expect(input.value).toBe("Mika");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Mika S");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("Mika S");
  });

  it("設定: 項目帯を押すと、その節（id）へスクロールする", () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this.id);
    };
    const host = mount(<SettingsPage profile={{ initial: "M", name: "n", titleJa: "a", titleEn: "b", bio: "c" }} aiLang="same" terms="t" recipes={[]} engine="mac" speakers saveTo="cloud" />);
    click(byText(host, ".es-secnav button", "文字起こし"));
    click(byText(host, ".es-secnav button", "保存"));
    expect(scrolled).toEqual(["es-s-tr", "es-s-save"]);
  });

  it("設定: 選択チップを押すと onChange、スイッチを押すと onSpeakers", () => {
    const onEngine = vi.fn();
    const onSpeakers = vi.fn();
    const host = mount(
      <SettingsPage profile={{ initial: "M", name: "n", titleJa: "a", titleEn: "b", bio: "c" }} aiLang="same" terms="t" recipes={[]} engine="mac" onEngine={onEngine} speakers onSpeakers={onSpeakers} saveTo="cloud" />,
    );
    click(byText(host, ".es-pills button", "Gemini"));
    expect(onEngine).toHaveBeenCalledWith("gemini");
    click(host.querySelector('[role="switch"]'));
    expect(onSpeakers).toHaveBeenCalledWith(false);
  });

  it("自分のサイト: 戻る・コピー・再発行・WordPress のスイッチ・接続の解除が props のコールバックへ渡る", () => {
    const fns = { onBack: vi.fn(), onCopyApi: vi.fn(), onReissueKey: vi.fn(), onWordpress: vi.fn(), onDisconnect: vi.fn() };
    const host = mount(<SitePage host="mika-sato.example" apiUrl="u" maskedKey="k" wordpress={{ on: false }} articleUrl="a" published={[]} {...fns} />);
    click(host.querySelector('button[aria-label="発信先に戻る"]'));
    click(byText(host, "button", "コピー"));
    click(byText(host, "button", "再発行"));
    click(host.querySelector('[role="switch"]'));
    click(byText(host, "button", "接続を解除"));
    expect(fns.onBack).toHaveBeenCalled();
    expect(fns.onCopyApi).toHaveBeenCalled();
    expect(fns.onReissueKey).toHaveBeenCalled();
    expect(fns.onWordpress).toHaveBeenCalledWith(true);
    expect(fns.onDisconnect).toHaveBeenCalled();
  });

  it("役割とつながり: 招待の受ける・辞退、体験ホストの申し込み", () => {
    const fns = { onAccept: vi.fn(), onDecline: vi.fn(), onApply: vi.fn() };
    const host = mount(
      <AccountPage
        account={{ name: "Mika Sato", initial: "M", email: "mika@example.com" }}
        roles={[{ id: "host", name: "体験ホスト", detail: "d", off: { action: "申し込む" } }]}
        invite={{ initial: "N", name: "NIHO kamakura", detail: "d" }}
        links={[]}
        {...fns}
      />,
    );
    click(byText(host, "button", "受ける"));
    click(byText(host, "button", "辞退"));
    click(byText(host, "button", "申し込む"));
    expect(fns.onAccept).toHaveBeenCalled();
    expect(fns.onDecline).toHaveBeenCalled();
    expect(fns.onApply).toHaveBeenCalledWith("host");
  });

  it("設定系ページの枠: 戻るボタンと印があれば 1 行（h1 の隣）。なければ h1 だけ", () => {
    const withBack = mount(
      <ShellSettingsPage title="x.example" back={{ label: "発信先に戻る", onClick: vi.fn() }} pill={<span>p</span>}>
        c
      </ShellSettingsPage>,
    );
    expect(withBack.querySelector(".es-page-hd h1")!.textContent).toBe("x.example");
    const plain = mount(<ShellSettingsPage title="設定">c</ShellSettingsPage>);
    expect(plain.querySelector(".es-page-hd")).toBeNull();
    expect(plain.querySelector("h1")!.textContent).toBe("設定");
  });
});
