// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsDto, SettingsFailure, SettingsPatchInput } from "@/lib/settings-client";
import { SETTINGS_MESSAGES } from "@/settings/messages";
import { button, click, clickRow, dto, field, flush, mount, row, shown, status, type, unmount, unnamed } from "./settings-test-kit";

const push = vi.fn();
const save = vi.fn<(patch: SettingsPatchInput) => Promise<{ ok: true; settings: SettingsDto } | SettingsFailure>>();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/settings-client", () => ({ saveSettings: (patch: SettingsPatchInput) => save(patch) }));

import { SettingsTermsView } from "./SettingsTermsView";

const VARIANTS = "誤りやすい表記（「・」で区切る）";
const KITA = { term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌", "きた鎌倉"], note: "" };

beforeEach(() => {
  push.mockReset();
  save.mockReset();
});

afterEach(unmount);

describe("SettingsTermsView（/settings/terms）", () => {
  it("adds a row in place and sends the whole list, trimming nothing itself", async () => {
    await mount(<SettingsTermsView initial={dto()} />);
    expect(shown()).toContain("0 語 / 200 語");
    await click("固有名詞を追加");
    await type("表記", "北鎌倉");
    await type("よみ", "きたかまくら");
    await type(VARIANTS, "北鎌・きた鎌倉");
    save.mockResolvedValue({ ok: true, settings: dto({ glossary: [KITA] }) });
    await click("固有名詞を保存");
    expect(save).toHaveBeenCalledWith({ glossary: [KITA] });
    // 保存できたら行に戻る
    expect(row("北鎌倉", "を編集")).toBeTruthy();
    expect(shown()).toContain("北鎌 · きた鎌倉");
  });

  it("lets the 誤りやすい表記 be typed one after another: the separator stays and the next word does not join the first", async () => {
    await mount(<SettingsTermsView initial={dto()} />);
    await click("固有名詞を追加");
    await type("表記", "北鎌倉");
    // 1 語 → 区切り → 続きの語を、打った順に入れる（区切りを打った時点で欄が描き直されると「・」が消えて繋がる）
    for (const value of ["北鎌", "北鎌・", "北鎌・き", "北鎌・きた鎌倉"]) {
      await type(VARIANTS, value);
      expect(field(VARIANTS).value).toBe(value);
    }
    const glossary = [{ term: "北鎌倉", reading: "", variants: ["北鎌", "きた鎌倉"], note: "" }];
    save.mockResolvedValue({ ok: true, settings: dto({ glossary }) });
    await click("固有名詞を保存");
    // 配列に分けるのは保存のとき
    expect(save).toHaveBeenCalledWith({ glossary });
  });

  it("re-opens a row with the saved 誤りやすい表記 joined by the separator it asks for", async () => {
    await mount(<SettingsTermsView initial={dto({ glossary: [KITA] })} />);
    await clickRow("北鎌倉", "を編集");
    expect(field(VARIANTS).value).toBe("北鎌・きた鎌倉");
  });

  it("drops a trailing separator and blank entries when it saves", async () => {
    await mount(<SettingsTermsView initial={dto()} />);
    await click("固有名詞を追加");
    await type("表記", "円覚寺");
    await type(VARIANTS, "えんがく ・ ・ 円覚 ・");
    save.mockResolvedValue({ ok: true, settings: dto() });
    await click("固有名詞を保存");
    expect(save.mock.calls[0]?.[0]?.glossary?.[0]?.variants).toEqual(["えんがく", "円覚"]);
  });

  it("edits one row in its place and deletes a row, sending the whole list each time", async () => {
    const ENKAKU = { term: "円覚寺", reading: "えんがくじ", variants: [], note: "" };
    await mount(<SettingsTermsView initial={dto({ glossary: [KITA, ENKAKU] })} />);
    await clickRow("円覚寺", "を編集");
    await type("補足", "臨済宗");
    save.mockResolvedValue({ ok: true, settings: dto({ glossary: [KITA, { ...ENKAKU, note: "臨済宗" }] }) });
    await click("固有名詞を保存");
    expect(save.mock.calls[0]?.[0]).toEqual({ glossary: [KITA, { ...ENKAKU, note: "臨済宗" }] });
    await clickRow("北鎌倉", "を編集");
    save.mockResolvedValue({ ok: true, settings: dto({ glossary: [{ ...ENKAKU, note: "臨済宗" }] }) });
    await click("北鎌倉を削除");
    expect(save.mock.calls[1]?.[0]).toEqual({ glossary: [{ ...ENKAKU, note: "臨済宗" }] });
    expect(row("北鎌倉", "を編集")).toBeUndefined();
  });

  it("does not save a row without 表記", async () => {
    await mount(<SettingsTermsView initial={dto()} />);
    await click("固有名詞を追加");
    await type("よみ", "よみだけ");
    expect(button("固有名詞を保存")?.getAttribute("aria-disabled")).toBe("true");
    await click("固有名詞を保存");
    expect(save).not.toHaveBeenCalled();
  });

  it("leaves the 固有名詞 alone when the edit is cancelled, and keeps the row open when the save fails", async () => {
    await mount(<SettingsTermsView initial={dto({ glossary: [{ term: "円覚寺", reading: "えんがくじ", variants: [], note: "" }] })} />);
    await clickRow("円覚寺", "を編集");
    await type("表記", "書き換え");
    await click("固有名詞の編集をやめる");
    expect(save).not.toHaveBeenCalled();
    expect(shown()).toContain("円覚寺");
    await clickRow("円覚寺", "を編集");
    save.mockResolvedValue({ ok: false, status: 503, error: "unavailable", message: SETTINGS_MESSAGES.unavailable });
    await type("表記", "書き換え");
    await click("固有名詞を保存");
    expect(status()).toBe(SETTINGS_MESSAGES.unavailable);
    expect(field("表記").value).toBe("書き換え");
  });

  it("does not open another row while a save is on the way, and closes only the row it saved", async () => {
    const ENKAKU = { term: "円覚寺", reading: "えんがくじ", variants: [], note: "" };
    await mount(<SettingsTermsView initial={dto({ glossary: [KITA, ENKAKU] })} />);
    await clickRow("北鎌倉", "を編集");
    await type("補足", "臨済宗");
    let answer: (value: { ok: true; settings: SettingsDto }) => void = () => undefined;
    save.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await click("固有名詞を保存");
    // 送っている間は、別の行・追加を押しても開かない（押せないことは aria-disabled で伝える）
    expect(row("円覚寺", "を編集")?.getAttribute("aria-disabled")).toBe("true");
    await clickRow("円覚寺", "を編集");
    expect(field("補足").value).toBe("臨済宗");
    expect(row("円覚寺", "を編集")).toBeTruthy();
    // 保存が返ったら、送った行だけが閉じる
    answer({ ok: true, settings: dto({ glossary: [{ ...KITA, note: "臨済宗" }, ENKAKU] }) });
    await flush();
    expect(row("北鎌倉", "を編集")).toBeTruthy();
    expect(row("円覚寺", "を編集")?.getAttribute("aria-disabled")).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps a row opened after the save of another one has come back", async () => {
    const ENKAKU = { term: "円覚寺", reading: "えんがくじ", variants: [], note: "" };
    await mount(<SettingsTermsView initial={dto({ glossary: [KITA, ENKAKU] })} />);
    await clickRow("北鎌倉", "を編集");
    save.mockResolvedValue({ ok: true, settings: dto({ glossary: [KITA, ENKAKU] }) });
    await click("固有名詞を保存");
    await clickRow("円覚寺", "を編集");
    await type("補足", "臨済宗");
    expect(field("補足").value).toBe("臨済宗");
  });

  it("names every control and labels every field, also while a row is open", async () => {
    await mount(<SettingsTermsView initial={dto({ glossary: [KITA] })} />);
    expect(unnamed()).toEqual([]);
    await clickRow("北鎌倉", "を編集");
    expect(unnamed()).toEqual([]);
  });
});
