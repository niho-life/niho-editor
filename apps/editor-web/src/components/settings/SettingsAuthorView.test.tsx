// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsDto, SettingsFailure, SettingsPatchInput } from "@/lib/settings-client";
import { button, click, dto, field, LIMITS, mount, shown, type, unmount, unnamed } from "./settings-test-kit";

const push = vi.fn();
const save = vi.fn<(patch: SettingsPatchInput) => Promise<{ ok: true; settings: SettingsDto } | SettingsFailure>>();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/settings-client", () => ({ saveSettings: (patch: SettingsPatchInput) => save(patch) }));

import { SettingsAuthorView } from "./SettingsAuthorView";

beforeEach(() => {
  push.mockReset();
  save.mockReset();
});

afterEach(unmount);

describe("SettingsAuthorView（/settings/author）", () => {
  it("opens with the saved role and bio, saves both in one PATCH, and goes back to /settings", async () => {
    await mount(<SettingsAuthorView initial={dto({ authorRole: "合成の案内人", authorBio: "海辺の朝を書きます。" })} />);
    expect(field("肩書").value).toBe("合成の案内人");
    expect(field("紹介文").value).toBe("海辺の朝を書きます。");
    save.mockResolvedValue({ ok: true, settings: dto({ authorRole: "合成の編集者", authorBio: "直した紹介文です。" }) });
    await type("肩書", "合成の編集者");
    await type("紹介文", "直した紹介文です。");
    await click("公開用の著者紹介を保存");
    expect(save).toHaveBeenCalledWith({ authorRole: "合成の編集者", authorBio: "直した紹介文です。" });
    expect(push).toHaveBeenCalledWith("/settings");
  });

  it("sends a blank field as null (none)", async () => {
    await mount(<SettingsAuthorView initial={dto({ authorRole: "合成の案内人", authorBio: null })} />);
    expect(field("紹介文").value).toBe("");
    save.mockResolvedValue({ ok: true, settings: dto() });
    await type("肩書", "   ");
    await click("公開用の著者紹介を保存");
    expect(save).toHaveBeenCalledWith({ authorRole: null, authorBio: null });
  });

  it("stays on the page and says so when the save fails", async () => {
    await mount(<SettingsAuthorView initial={dto()} />);
    save.mockResolvedValue({ ok: false, status: 400, error: "bad_request", message: "この内容では保存できません" });
    await type("肩書", "合成の案内人");
    await click("公開用の著者紹介を保存");
    expect(push).not.toHaveBeenCalled();
    expect(shown()).toContain("この内容では保存できません");
    expect(field("肩書").value).toBe("合成の案内人");
  });

  it("does not save a bio over the limit", async () => {
    await mount(<SettingsAuthorView initial={dto()} />);
    await type("紹介文", "あ".repeat(LIMITS.authorBioChars + 1));
    expect(button("公開用の著者紹介を保存")?.getAttribute("aria-disabled")).toBe("true");
    await click("公開用の著者紹介を保存");
    expect(save).not.toHaveBeenCalled();
    expect(shown()).toContain("紹介文が長すぎるので保存できません");
  });

  it("names every control and labels every field", async () => {
    await mount(<SettingsAuthorView initial={dto()} />);
    expect(unnamed()).toEqual([]);
  });
});
