// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDITOR_SETTINGS_TEXT } from "niho-docs-ui/shell";
import type { MediaStorageUsage, SettingsDto, SettingsFailure, SettingsPatchInput, UsageSummary } from "@/lib/settings-client";
import { SETTINGS_MESSAGES } from "@/settings/messages";
import { button, buttons, click, DEFAULT_RECIPE_IDS, dto, echoRecipes, link, mount, shown, status, unmount, unnamed } from "./settings-test-kit";

const push = vi.fn();
const save = vi.fn<(patch: SettingsPatchInput) => Promise<{ ok: true; settings: SettingsDto } | SettingsFailure>>();
const usage = vi.fn<() => Promise<{ ok: true; usage: UsageSummary } | SettingsFailure>>();
const storageUsage = vi.fn<() => Promise<{ ok: true; usage: MediaStorageUsage } | SettingsFailure>>();
const logout = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/logout", () => ({ logoutAndLeave: () => logout() }));
vi.mock("@/lib/settings-client", () => ({
  saveSettings: (patch: SettingsPatchInput) => save(patch),
  loadAiUsage: () => usage(),
  loadStorageUsage: () => storageUsage(),
}));

import { SettingsHubView } from "./SettingsHubView";

const AUDIO = { maxBytes: 2 * 1024 ** 3, maxDurationSec: 6 * 3600, retentionDays: 30 };
const USAGE: UsageSummary = { month: "2026-10", inputTokens: 1234, outputTokens: 56, costUsd: 0.42, limitUsd: 5, nearLimit: false };
const STORAGE_USAGE: MediaStorageUsage = { imageBytes: "1073741824", audioBytes: "4096", totalBytes: "1073745920" };
const DESTINATIONS = {
  faces: [{ handle: "exp" as const, label: "NIHO Experience", host: null, path: null, available: false, reason: "role" as const, published: 0 }],
  sites: [{ id: "11111111-2222-4333-8444-555555555555", handle: "synthetic", mode: "api" as const, siteUrl: "https://synthetic.example", urlShape: { host: "synthetic.example", path: "posts" }, articleUrl: "https://synthetic.example/posts/{slug}", apiUrl: "https://api.example.invalid", assetPolicy: "copy-on-import" as const, pushEnabled: false as const, createdAt: "2030-01-01T00:00:00.000Z", removedAt: null, keys: [], published: 0 }],
  modes: ["api" as const, "wordpress" as const, "ghost" as const],
};

const open = (initial: SettingsDto = dto()) => mount(<SettingsHubView initial={initial} audio={AUDIO} account={{ name: "合成の名前", caption: "synthetic@example.invalid", initial: "合" }} destinations={DESTINATIONS} />);

beforeEach(() => {
  for (const mock of [push, save, usage, storageUsage, logout]) mock.mockReset();
  usage.mockResolvedValue({ ok: true, usage: USAGE });
  storageUsage.mockResolvedValue({ ok: true, usage: STORAGE_USAGE });
});

afterEach(unmount);

describe("SettingsHubView（/settings）", () => {
  it("lists only what can be changed, with the facts moved into the データ ⓘ", async () => {
    await open();
    const text = shown();
    expect(text).toContain("記事制作");
    expect(text).toContain("文字起こし › 文字起こし修正");
    expect(text).toContain("$0.42 / $5.00");
    expect(text).toContain("2026-10");
    expect(text).toContain("1 GiB");
    expect(text).toContain("画像 1 GiB · 音声 4 KiB");
    expect(text).toContain("30 日で消えます（文字起こしとページは残ります）");
    expect(text).toContain("2 GiB・6 時間まで");
    for (const gone of ["Deepgram", "時間切れ", "受け付ける形式", "保存先"]) expect(text).not.toContain(gone);
    expect(buttons().map((item) => item.textContent?.trim())).not.toContain("編集");
  });

  it("puts the account and each destination in separate groups, and ログアウト at the bottom", async () => {
    await open();
    const me = document.querySelector<HTMLAnchorElement>("a.es-row--me")!;
    expect(me.getAttribute("href")).toBe("/account");
    expect(me.textContent).toContain("合成の名前");
    expect(me.textContent).toContain("synthetic@example.invalid");
    expect(link("NIHO Experience")?.textContent).toContain("未接続");
    expect(link("synthetic.example")?.textContent).toContain("接続済み");
    await act(async () => link("発信先を追加・管理")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(push).toHaveBeenCalledWith("/destinations");
    await click("ログアウト");
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it("shows the public author introduction under アカウント and links to its page", async () => {
    await open(dto({ authorRole: "合成の案内人", authorBio: null }));
    const row = link("公開用の著者紹介")!;
    expect(row.getAttribute("href")).toBe("/settings/author");
    expect(row.textContent).toContain("合成の案内人");
    await act(async () => row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(push).toHaveBeenCalledWith("/settings/author");
  });

  it("goes to the detail pages through the router (the rows are links)", async () => {
    await open();
    expect(link("あなたについて")?.getAttribute("href")).toBe("/settings/about");
    await act(async () => link("固有名詞")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(push).toHaveBeenCalledWith("/settings/terms");
    await act(async () => link("記事制作")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(push).toHaveBeenCalledWith("/settings/recipes/tpl-1");
  });

  it("warns once the month is close to the limit, in the row", async () => {
    await open();
    expect(shown()).not.toContain(EDITOR_SETTINGS_TEXT.nearLimit);
    await unmount();
    usage.mockResolvedValue({ ok: true, usage: { ...USAGE, costUsd: 4.5, nearLimit: true } });
    await open();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(EDITOR_SETTINGS_TEXT.nearLimit);
    await unmount();
    usage.mockResolvedValue({ ok: true, usage: { ...USAGE, costUsd: 5, nearLimit: true } });
    await open();
    expect(shown()).toContain(EDITOR_SETTINGS_TEXT.overLimit);
  });

  it("says so when the usage cannot be read, and still shows the rest", async () => {
    usage.mockResolvedValue({ ok: false, status: 503, error: "unavailable", message: SETTINGS_MESSAGES.usageFailed });
    await open();
    expect(shown()).toContain(SETTINGS_MESSAGES.usageFailed);
    expect(shown()).toContain("記事制作");
  });

  it("shows a storage-specific error without a previous capacity value", async () => {
    storageUsage.mockResolvedValue({ ok: false, status: 503, error: "unavailable", message: SETTINGS_MESSAGES.storageUsageFailed });
    await open();
    expect(shown()).toContain(SETTINGS_MESSAGES.storageUsageFailed);
    expect(shown()).not.toContain("画像 1 GiB");
  });

  it("saves the 提案の言語 and takes the answer as the new state", async () => {
    await open();
    save.mockResolvedValue({ ok: true, settings: dto({ aiLang: "en" }) });
    await click("English");
    expect(save).toHaveBeenCalledWith({ aiLang: "en" });
    expect(status()).toBe(SETTINGS_MESSAGES.saved);
    expect(button("English")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("turns 「Web を検索する」 off and on in place (on by default, #283)", async () => {
    await open();
    expect(shown()).toContain("Web を検索する");
    expect(button("する")?.getAttribute("aria-pressed")).toBe("true");
    save.mockResolvedValue({ ok: true, settings: dto({ webSearch: false }) });
    await click("しない");
    expect(save).toHaveBeenCalledWith({ webSearch: false });
    expect(status()).toBe(SETTINGS_MESSAGES.saved);
    expect(button("しない")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the old value and says so when the save fails", async () => {
    await open();
    save.mockResolvedValue({ ok: false, status: 503, error: "unavailable", message: SETTINGS_MESSAGES.unavailable });
    await click("English");
    expect(status()).toBe(SETTINGS_MESSAGES.unavailable);
    expect(button("書いた言語のまま")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("adds a 手順 with the whole effective list and opens its page", async () => {
    await open();
    save.mockImplementation(async (patch) => ({ ok: true, settings: echoRecipes(patch.recipes ?? []) }));
    await click("手順を追加");
    const sent = save.mock.calls[0]?.[0]?.recipes;
    expect(sent?.map((recipe) => recipe.id).slice(0, DEFAULT_RECIPE_IDS.length)).toEqual([...DEFAULT_RECIPE_IDS]);
    expect(sent).toHaveLength(DEFAULT_RECIPE_IDS.length + 1);
    const added = sent?.at(-1);
    expect(added?.name).toBe("新しい手順");
    expect(added?.steps.every((step) => step.profile === "standard")).toBe(true);
    expect(push).toHaveBeenCalledWith(`/settings/recipes/${added?.id}`);
  });

  it("does not offer 手順を追加 at the limit", async () => {
    const base = dto();
    const extra = Array.from({ length: base.limits.recipes - base.recipes.length }, (_, index) => ({ ...base.recipes[0]!, id: `r-${index}`, name: `足した手順 ${index}`, isDefault: false, defaults: null }));
    await open({ ...base, recipes: [...base.recipes, ...extra] });
    expect(button("手順を追加")).toBeUndefined();
  });

  it("names every control and labels every field", async () => {
    await open();
    expect(unnamed()).toEqual([]);
  });
});
