// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsDto, SettingsFailure, SettingsPatchInput } from "@/lib/settings-client";
import { button, click, dto, field, LIMITS, mount, shown, type, unmount, unnamed } from "./settings-test-kit";

const push = vi.fn();
const save = vi.fn<(patch: SettingsPatchInput) => Promise<{ ok: true; settings: SettingsDto } | SettingsFailure>>();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/settings-client", () => ({ saveSettings: (patch: SettingsPatchInput) => save(patch) }));

import { SettingsAboutView } from "./SettingsAboutView";

beforeEach(() => {
  push.mockReset();
  save.mockReset();
});

afterEach(unmount);

describe("SettingsAboutView（/settings/about）", () => {
  it("opens with the saved text, saves both fields in one PATCH, and goes back to /settings", async () => {
    await mount(<SettingsAboutView initial={dto({ aboutName: "合成の呼び名", about: "合成の自己紹介です。" })} />);
    expect(field("呼び名").value).toBe("合成の呼び名");
    expect(field("説明と書き方の希望").value).toBe("合成の自己紹介です。");
    expect(shown()).toContain("公開はされません");
    save.mockResolvedValue({ ok: true, settings: dto({ aboutName: "直した呼び名", about: "直した自己紹介です。" }) });
    await type("呼び名", "直した呼び名");
    await type("説明と書き方の希望", "直した自己紹介です。");
    await click("あなたについてを保存");
    expect(save).toHaveBeenCalledWith({ aboutName: "直した呼び名", about: "直した自己紹介です。" });
    expect(push).toHaveBeenCalledWith("/settings");
  });

  it("stays on the page and says so when the save fails", async () => {
    await mount(<SettingsAboutView initial={dto()} />);
    save.mockResolvedValue({ ok: false, status: 400, error: "bad_request", message: "この内容では保存できません" });
    await type("呼び名", "みか");
    await click("あなたについてを保存");
    expect(push).not.toHaveBeenCalled();
    expect(shown()).toContain("この内容では保存できません");
    expect(field("呼び名").value).toBe("みか");
  });

  it("does not save a text over the limit", async () => {
    await mount(<SettingsAboutView initial={dto()} />);
    await type("説明と書き方の希望", "あ".repeat(LIMITS.aboutChars + 1));
    expect(button("あなたについてを保存")?.getAttribute("aria-disabled")).toBe("true");
    await click("あなたについてを保存");
    expect(save).not.toHaveBeenCalled();
    expect(shown()).toContain("説明と書き方の希望が長すぎるので保存できません");
    expect(shown()).toContain("2,001 / 2,000 字");
  });

  it("names every control and labels every field", async () => {
    await mount(<SettingsAboutView initial={dto()} />);
    expect(unnamed()).toEqual([]);
  });
});
