// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDITOR_DESTINATIONS_TEXT } from "niho-docs-ui/shell";
import type { CreateSiteInput, DestinationsDto, DestinationsFailure, IssuedKeyDto, SiteDestinationDto } from "@/lib/destinations-client";
import { DESTINATION_MESSAGES } from "@/publish/messages";

const push = vi.fn();
const load = vi.fn<() => Promise<{ ok: true; value: DestinationsDto } | DestinationsFailure>>();
const create = vi.fn<(input: CreateSiteInput) => Promise<{ ok: true; value: { site: SiteDestinationDto; key: IssuedKeyDto } } | DestinationsFailure>>();
const writeText = vi.fn<(value: string) => Promise<void>>();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/destinations-client", () => ({ loadDestinations: () => load(), createSite: (input: CreateSiteInput) => create(input) }));

import { DestinationsView } from "./DestinationsView";

// 合成の値だけを使う（鍵の形だけが要るところは、鍵でない文字列を使う）
const PLAINTEXT = "ek_synthetic-plaintext-key-value-not-a-real-key";
const MASKED = "ek_••••••••3f9a";
const SITE_ID = "11111111-2222-4333-8444-555555555555";

const site: SiteDestinationDto = {
  id: SITE_ID,
  handle: "mika-sato",
  mode: "api",
  siteUrl: "https://mika-sato.example",
  urlShape: { host: "mika-sato.example", path: "posts" },
  articleUrl: "https://mika-sato.example/posts/{slug}",
  apiUrl: "https://api.editor.niho.life/v1/mika-sato/published.json",
  assetPolicy: "copy-on-import",
  pushEnabled: false,
  createdAt: "2026-10-30T00:00:00.000Z",
  removedAt: null,
  keys: [{ id: "k1", masked: MASKED, createdAt: "2026-10-30T00:00:00.000Z", revokedAt: null, active: true }],
  published: 1,
};

function dto(patch: Partial<DestinationsDto> = {}): DestinationsDto {
  return {
    faces: [
      { handle: "exp", label: "NIHO Experience", host: "experience.niho.life", path: "guides", available: true, reason: null, published: 2 },
      { handle: "niho", label: "NIHO", host: null, path: null, available: false, reason: "role", published: 0 },
    ],
    sites: [],
    modes: ["api", "wordpress", "ghost"],
    ...patch,
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  push.mockReset();
  load.mockReset();
  create.mockReset();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  load.mockResolvedValue({ ok: true, value: dto({ sites: [site] }) });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(initial: DestinationsDto = dto()) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<DestinationsView initial={initial} />);
  });
  return container;
}

const buttons = () => [...(container?.querySelectorAll("button") ?? [])];
/** aria-label が無いボタンは見える文字で探す（「発信先を追加」のカードは、下に説明の行を持つ）。 */
const button = (label: string) =>
  buttons().find((item) => {
    const name = item.getAttribute("aria-label") ?? item.textContent ?? "";
    return name === label || (item.getAttribute("aria-label") === null && name.startsWith(label));
  });
const click = async (label: string) => {
  const target = button(label);
  if (!target) throw new Error(`no button named ${label}`);
  await act(async () => target.click());
};
const inputs = () => [...(container?.querySelectorAll<HTMLInputElement>("input") ?? [])];
const type = async (label: string, value: string) => {
  const node = [...(container?.querySelectorAll("label") ?? [])].find((item) => item.textContent === label);
  const input = node ? inputs().find((item) => item.id === node.htmlFor) : undefined;
  if (!input) throw new Error(`no field named ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const status = () => container?.querySelector('[role="status"]')?.textContent;

describe("DestinationsView", () => {
  it("goes back to 設定 through the router (「← 設定」 is a link to /settings)", async () => {
    const host = await mount();
    const back = host.querySelector<HTMLAnchorElement>("a.es-back")!;
    expect(back.getAttribute("href")).toBe("/settings");
    await act(async () => void back.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(push).toHaveBeenCalledWith("/settings");
  });

  it("hides every legacy face and opens a personal site's settings", async () => {
    const text = (await mount(dto({ sites: [site] }))).textContent ?? "";
    expect(text).not.toContain("NIHO Experience");
    expect(text).toContain("接続済み");
    expect(text).not.toContain("旅行者向け · 英語");
    expect(text).not.toContain("鎌倉の人向け");
    expect(text).not.toContain(EDITOR_DESTINATIONS_TEXT.noRole);
    expect(text).toContain("mika-sato.example");
    expect(text).not.toContain("mika-sato.example/posts");
    await click("mika-sato.example の設定");
    expect(push).toHaveBeenCalledWith(`/destinations/${SITE_ID}`);
  });

  it("ignores legacy face DTO rows regardless of their old availability reason", async () => {
    const disconnected = dto({ faces: [{ handle: "exp", label: "NIHO Experience", host: null, path: null, available: false, reason: "role", published: 0 }] });
    expect((await mount(disconnected)).textContent).not.toContain("NIHO Experience");
    await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    const failed = dto({ faces: [{ handle: "exp", label: "NIHO Experience", host: null, path: null, available: false, reason: "unavailable", published: 0 }] });
    const text = (await mount(failed)).textContent ?? "";
    expect(text).not.toContain("NIHO Experience");
    expect(text).not.toContain("接続を確認できません");
  });

  it("adds a site, sends the URL shape from the site URL, and shows the new key once", async () => {
    await mount();
    create.mockResolvedValue({ ok: true, value: { site, key: { id: "k1", masked: MASKED, plaintext: PLAINTEXT, createdAt: "2026-10-30T00:00:00.000Z" } } });
    await click("発信先を追加");
    await type("handle（公開 API の URL に入る）", " mika-sato ");
    await type("サイトの URL（https）", " https://mika-sato.example ");
    await type("記事の前に付く path（空でもよい）", "/posts/");
    await click("この発信先を追加");
    expect(create).toHaveBeenCalledWith({ handle: "mika-sato", mode: "api", siteUrl: "https://mika-sato.example", urlShape: { host: "mika-sato.example", path: "posts" } });
    // 鍵は 1 回だけ。閉じると画面から消える
    expect(container?.textContent).toContain(PLAINTEXT);
    expect(status()).toBe(DESTINATION_MESSAGES.keyOnce);
    await click("新しい鍵をコピー");
    expect(writeText).toHaveBeenCalledWith(PLAINTEXT);
    await click("新しい鍵を閉じる");
    expect(container?.textContent).not.toContain(PLAINTEXT);
    // 一覧はサーバーから読み直す
    expect(load).toHaveBeenCalled();
    expect(container?.textContent).toContain("mika-sato.example");
    expect(container?.textContent).not.toContain("mika-sato.example/posts");
  });

  it("says why when the site URL is not a URL, without sending anything", async () => {
    await mount();
    await click("発信先を追加");
    await type("サイトの URL（https）", "mika-sato.example");
    await click("この発信先を追加");
    expect(create).not.toHaveBeenCalled();
    expect(status()).toBe(DESTINATION_MESSAGES.invalid_site_url);
  });

  it("keeps the draft and says the server's reason when the handle is taken", async () => {
    await mount();
    create.mockResolvedValue({ ok: false, status: 409, error: "handle_taken", message: DESTINATION_MESSAGES.handle_taken });
    await click("発信先を追加");
    await type("handle（公開 API の URL に入る）", "mika-sato");
    await type("サイトの URL（https）", "https://mika-sato.example");
    await click("この発信先を追加");
    expect(status()).toBe(DESTINATION_MESSAGES.handle_taken);
    // 下書きは残る（入れ直さなくてよい）
    expect(button("この発信先を追加")).toBeTruthy();
    expect(container?.textContent).not.toContain(PLAINTEXT);
  });

  it("says so when the clipboard cannot be used, and never puts the key in the URL", async () => {
    await mount();
    create.mockResolvedValue({ ok: true, value: { site, key: { id: "k1", masked: MASKED, plaintext: PLAINTEXT, createdAt: "2026-10-30T00:00:00.000Z" } } });
    await click("発信先を追加");
    await type("サイトの URL（https）", "https://mika-sato.example");
    await click("この発信先を追加");
    writeText.mockRejectedValue(new Error("denied"));
    await click("新しい鍵をコピー");
    expect(status()).toContain("コピーできませんでした");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("cancels the draft without sending anything", async () => {
    await mount();
    await click("発信先を追加");
    await click("発信先を追加するのをやめる");
    expect(create).not.toHaveBeenCalled();
    expect(button("発信先を追加")).toBeTruthy();
  });
});
