// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EditorSettingsPatch } from "@niho/editor-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaStorageUsage, SettingsFailure, SettingsDto, UsageSummary } from "@/lib/settings-client";
import type { SettingsFacts } from "@/settings/facts";
import { EDITOR_SETTINGS_TEXT } from "niho-docs-ui/shell";
import { SETTINGS_MESSAGES } from "@/settings/messages";

const save = vi.fn<(patch: EditorSettingsPatch) => Promise<{ ok: true; settings: SettingsDto } | SettingsFailure>>();
const usage = vi.fn<() => Promise<{ ok: true; usage: UsageSummary } | SettingsFailure>>();
const storageUsage = vi.fn<() => Promise<{ ok: true; usage: MediaStorageUsage } | SettingsFailure>>();

vi.mock("@/lib/settings-client", () => ({
  saveSettings: (patch: EditorSettingsPatch) => save(patch),
  loadAiUsage: () => usage(),
  loadStorageUsage: () => storageUsage(),
}));

import { SettingsView } from "./SettingsView";

// 合成の値だけを使う
const FACTS: SettingsFacts = {
  transcription: {
    engine: "deepgram",
    timeoutSec: 1200,
    audio: { maxBytes: 2 * 1024 ** 3, maxDurationSec: 6 * 3600, retentionDays: 30, extensions: ["m4a", "mp3"], contentTypes: ["audio/mp4"] },
  },
};

const STEP = { id: "k7m2q9xa", name: "文字起こし修正", instruction: "整える。" };

type RecipeDefaults = NonNullable<SettingsDto["recipes"][number]["defaults"]>;

/** 既定の手順 3 つの元の定義（応答の `defaults`。「既定に戻す」はこの値で置き換えた一覧を送る）。 */
const DEFAULTS: Record<"tpl-1" | "tpl-2" | "tpl-3", RecipeDefaults> = {
  "tpl-1": { name: "記事制作", guide: "お手本", steps: [STEP] },
  "tpl-2": { name: "議事録", guide: "", steps: [{ id: "d9c3x7mf", name: "議事録", instruction: "" }] },
  "tpl-3": { name: "インサイト整理", guide: "", steps: [{ id: "u3e7z6rh", name: "インサイト", instruction: "" }] },
};

// 上限の値そのものは editor-store が決める（`settings-api.test.ts` が応答と突き合わせる）。ここは形だけを合わせる
const LIMITS: SettingsDto["limits"] = {
  glossary: 200,
  termChars: 100,
  variants: 20,
  noteChars: 200,
  recipes: 20,
  recipeNameChars: 80,
  guideChars: 20_000,
  steps: 12,
  stepNameChars: 80,
  instructionChars: 8_000,
  aboutChars: 2_000,
};

function dto(patch: Partial<SettingsDto> = {}): SettingsDto {
  return {
    aiLang: "same",
    glossary: [],
    about: "",
    recipes: (["tpl-1", "tpl-2", "tpl-3"] as const).map((id) => ({
      id,
      ...structuredClone(DEFAULTS[id]),
      isDefault: true,
      modified: false,
      defaults: structuredClone(DEFAULTS[id]),
    })),
    limits: LIMITS,
    ...patch,
  };
}

const USAGE: UsageSummary = { month: "2026-10", inputTokens: 1234, outputTokens: 56, costUsd: 0.42, limitUsd: 5, nearLimit: false };
const STORAGE_USAGE: MediaStorageUsage = { imageBytes: "1073741824", audioBytes: "4096", totalBytes: "1073745920" };

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  save.mockReset();
  usage.mockReset();
  usage.mockResolvedValue({ ok: true, usage: USAGE });
  storageUsage.mockReset();
  storageUsage.mockResolvedValue({ ok: true, usage: STORAGE_USAGE });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(initial: SettingsDto = dto(), facts: SettingsFacts = FACTS) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<SettingsView initial={initial} facts={facts} />);
  });
  return container;
}

const buttons = () => [...(container?.querySelectorAll("button") ?? [])];
const button = (label: string) => buttons().find((item) => (item.getAttribute("aria-label") ?? item.textContent) === label);
const click = async (label: string) => {
  const target = button(label);
  if (!target) throw new Error(`no button named ${label}`);
  await act(async () => target.click());
};
const inputs = () => [...(container?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea") ?? [])];
const field = (label: string) => {
  const node = [...(container?.querySelectorAll("label") ?? [])].find((item) => item.textContent === label);
  const input = node ? inputs().find((item) => item.id === node.htmlFor) : undefined;
  if (!input) throw new Error(`no field named ${label}`);
  return input;
};
const labelFor = (input: HTMLInputElement | HTMLTextAreaElement) => [...(container?.querySelectorAll("label") ?? [])].find((item) => item.htmlFor === input.id);
const valueOf = (label: string) => field(label).value;
const type = async (label: string, value: string) => {
  const input = field(label);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const status = () => container?.querySelector('[role="status"]')?.textContent;

describe("SettingsView", () => {
  it("shows the five items of #108 and cloud media usage", async () => {
    const text = (await mount()).textContent ?? "";
    expect(text).toContain("Deepgram");
    expect(text).toContain(EDITOR_SETTINGS_TEXT.engineFixed);
    expect(text).toContain("2 GiB");
    expect(text).toContain("6 時間");
    expect(text).toContain("30 日で消えます");
    expect(text).toContain("文字起こしの結果とページは残ります");
    expect(text).toContain("記事制作");
    expect(text).toContain("文字起こし › 文字起こし修正");
    expect(text).toContain("NIHO クラウド");
    expect(text).toContain("Web と Mac アプリで共通");
    expect(text).toContain("1 GiB");
    expect(text).toContain("画像 1 GiB・音声 4 KiB");
    expect(text).toContain(EDITOR_SETTINGS_TEXT.cloudStorageFixed);
    expect(text).toContain("$0.42 / $5.00");
    expect(text).toContain("2026-10");
  });

  it("says why Gemini is not offered yet, and names the fake engine as the fake", async () => {
    expect((await mount()).textContent).toContain(EDITOR_SETTINGS_TEXT.geminiLater);
    await act(async () => root?.unmount());
    expect((await mount(dto(), { ...FACTS, transcription: { ...FACTS.transcription, engine: "fake" } })).textContent).toContain(EDITOR_SETTINGS_TEXT.engineFake);
  });

  it("warns once the month is close to the limit", async () => {
    const text = (await mount(dto(), FACTS)).textContent ?? "";
    expect(text).not.toContain(EDITOR_SETTINGS_TEXT.nearLimit);
    await act(async () => root?.unmount());
    usage.mockResolvedValue({ ok: true, usage: { ...USAGE, costUsd: 4.5, nearLimit: true } });
    expect((await mount()).textContent).toContain(EDITOR_SETTINGS_TEXT.nearLimit);
    await act(async () => root?.unmount());
    usage.mockResolvedValue({ ok: true, usage: { ...USAGE, costUsd: 5, nearLimit: true } });
    expect((await mount()).textContent).toContain(EDITOR_SETTINGS_TEXT.overLimit);
  });

  it("says so when the usage cannot be read, and still shows the rest", async () => {
    usage.mockResolvedValue({ ok: false, status: 503, error: "unavailable", message: SETTINGS_MESSAGES.usageFailed });
    const text = (await mount()).textContent ?? "";
    expect(text).toContain(SETTINGS_MESSAGES.usageFailed);
    expect(text).toContain("Deepgram");
  });

  it("shows a storage-specific error without a previous capacity value", async () => {
    storageUsage.mockResolvedValue({ ok: false, status: 503, error: "unavailable", message: SETTINGS_MESSAGES.storageUsageFailed });
    const text = (await mount()).textContent ?? "";
    expect(text).toContain(SETTINGS_MESSAGES.storageUsageFailed);
    expect(text).not.toContain("画像 1 GiB");
  });

  it("saves the 提案の言語 and takes the answer as the new state", async () => {
    await mount();
    save.mockResolvedValue({ ok: true, settings: dto({ aiLang: "en" }) });
    await click("English");
    expect(save).toHaveBeenCalledWith({ aiLang: "en" });
    expect(status()).toBe(SETTINGS_MESSAGES.saved);
    expect(button("English")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the old value and says so when the save fails", async () => {
    await mount();
    save.mockResolvedValue({ ok: false, status: 503, error: "unavailable", message: SETTINGS_MESSAGES.unavailable });
    await click("English");
    expect(status()).toBe(SETTINGS_MESSAGES.unavailable);
    expect(button("書いた言語のまま")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("edits the 固有名詞 in the page and sends the rows, trimming nothing itself", async () => {
    await mount();
    await click("固有名詞を編集");
    await click("行を追加");
    await type("1 行目の表記", "北鎌倉");
    await type("1 行目のよみ", "きたかまくら");
    await type("1 行目の誤りやすい表記（「・」で区切る）", "北鎌・きた鎌倉");
    const glossary = [{ term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌", "きた鎌倉"], note: "" }];
    save.mockResolvedValue({ ok: true, settings: dto({ glossary }) });
    await click("固有名詞を保存");
    expect(save).toHaveBeenCalledWith({ glossary });
    // 保存できたら編集は閉じ、まとめが出る
    expect(button("固有名詞を編集")).toBeTruthy();
    expect(container?.textContent).toContain("北鎌倉");
  });

  it("lets the 誤りやすい表記 be typed one after another: the separator stays and the next word does not join the first", async () => {
    await mount();
    await click("固有名詞を編集");
    await click("行を追加");
    await type("1 行目の表記", "北鎌倉");
    const field = "1 行目の誤りやすい表記（「・」で区切る）";
    // 1 語 → 区切り → 続きの語を、打った順に入れる（区切りを打った時点で欄が描き直されると「・」が消えて繋がる）
    await type(field, "北鎌");
    expect(valueOf(field)).toBe("北鎌");
    await type(field, "北鎌・");
    expect(valueOf(field)).toBe("北鎌・");
    await type(field, "北鎌・き");
    expect(valueOf(field)).toBe("北鎌・き");
    await type(field, "北鎌・きた鎌倉");
    expect(valueOf(field)).toBe("北鎌・きた鎌倉");

    const glossary = [{ term: "北鎌倉", reading: "", variants: ["北鎌", "きた鎌倉"], note: "" }];
    save.mockResolvedValue({ ok: true, settings: dto({ glossary }) });
    await click("固有名詞を保存");
    // 配列に分けるのは保存のとき
    expect(save).toHaveBeenCalledWith({ glossary });
  });

  it("re-opens the editor with the saved 誤りやすい表記 joined by the separator it asks for", async () => {
    await mount(dto({ glossary: [{ term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌", "きた鎌倉"], note: "" }] }));
    await click("固有名詞を編集");
    expect(valueOf("1 行目の誤りやすい表記（「・」で区切る）")).toBe("北鎌・きた鎌倉");
  });

  it("drops a trailing separator and blank entries when it saves", async () => {
    await mount();
    await click("固有名詞を編集");
    await click("行を追加");
    await type("1 行目の表記", "円覚寺");
    await type("1 行目の誤りやすい表記（「・」で区切る）", "えんがく ・ ・ 円覚 ・");
    save.mockResolvedValue({ ok: true, settings: dto() });
    await click("固有名詞を保存");
    expect(save.mock.calls[0]?.[0]?.glossary?.[0]?.variants).toEqual(["えんがく", "円覚"]);
  });

  it("leaves the 固有名詞 alone when the edit is cancelled", async () => {
    await mount(dto({ glossary: [{ term: "円覚寺", reading: "えんがくじ", variants: [], note: "" }] }));
    await click("固有名詞を編集");
    await type("1 行目の表記", "書き換え");
    await click("固有名詞の編集をやめる");
    expect(save).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("円覚寺");
  });

  it("edits a 手順 and sends the whole effective list, with the edited one in its place", async () => {
    await mount();
    await click("記事制作を編集");
    await type("手順の名前", "記事制作（短め）");
    await type("段階 1 の指示", "短く整える。");
    save.mockResolvedValue({ ok: true, settings: dto() });
    await click("記事制作（短め）を保存");
    const sent = save.mock.calls[0]?.[0]?.recipes;
    expect(sent?.map((recipe) => recipe.id)).toEqual(["tpl-1", "tpl-2", "tpl-3"]);
    expect(sent?.[0]).toEqual({ id: "tpl-1", name: "記事制作（短め）", guide: "お手本", steps: [{ ...STEP, instruction: "短く整える。" }] });
  });

  it("does not offer to add or remove a 段階 of a default 手順, and says why", async () => {
    await mount();
    await click("記事制作を編集");
    expect(button("段階を追加")).toBeUndefined();
    expect(button("この段階を削除（段階 1）")).toBeUndefined();
    expect(container?.textContent).toContain("段階の数を変えられません");
  });

  it("duplicates a default 手順 with fresh 段階の id, and the copy can gain a 段階", async () => {
    await mount();
    save.mockImplementation(async (patch) => {
      const recipes = (patch.recipes ?? []).map((recipe) => {
        const base = recipe.id in DEFAULTS ? structuredClone(DEFAULTS[recipe.id as keyof typeof DEFAULTS]) : null;
        return { ...recipe, isDefault: base !== null, modified: false, defaults: base };
      });
      return { ok: true, settings: dto({ recipes }) };
    });
    await click("記事制作を複製");
    const sent = save.mock.calls[0]?.[0]?.recipes ?? [];
    expect(sent).toHaveLength(4);
    const copy = sent[3]!;
    expect(copy.name).toBe("記事制作のコピー");
    expect(copy.id).toMatch(/^r-[0-9a-f]{1,16}$/);
    expect(copy.steps[0]?.id).not.toBe(STEP.id);
    expect(copy.steps[0]?.id).toMatch(/^s-[0-9a-f]{1,16}$/);

    // 足した手順は消せる。編集を開くと、その行のボタンは編集の中のものに替わる
    expect(button("記事制作のコピーを削除")).toBeTruthy();
    await click("記事制作のコピーを編集");
    expect(button("段階を追加")).toBeTruthy();
    expect(button("この段階を削除（段階 1）")).toBeUndefined();
  });

  it("adds a 手順 and opens it for editing, and removes one by leaving it out", async () => {
    await mount();
    save.mockImplementation(async (patch) => {
      const recipes = (patch.recipes ?? []).map((recipe) => {
        const base = recipe.id in DEFAULTS ? structuredClone(DEFAULTS[recipe.id as keyof typeof DEFAULTS]) : null;
        return { ...recipe, isDefault: base !== null, modified: false, defaults: base };
      });
      return { ok: true, settings: dto({ recipes }) };
    });
    await click("手順を追加");
    expect(save.mock.calls[0]?.[0]?.recipes).toHaveLength(4);
    expect(field("手順の名前").value).toBe("新しい手順");

    await click("新しい手順の編集をやめる");
    await click("新しい手順を削除");
    expect(save.mock.calls[1]?.[0]?.recipes?.map((recipe) => recipe.id)).toEqual(["tpl-1", "tpl-2", "tpl-3"]);
  });

  it("offers 既定に戻す only for a default 手順 that was changed, and sends the default definition back (never a list missing a default)", async () => {
    const modified = dto();
    modified.recipes[1] = {
      ...modified.recipes[1]!,
      name: "議事録（短め）",
      guide: "短く",
      steps: [{ id: "d9c3x7mf", name: "要点", instruction: "要点だけ。" }],
      modified: true,
    };
    await mount(modified);
    expect(button("記事制作を既定に戻す")).toBeUndefined();
    save.mockResolvedValue({ ok: true, settings: dto() });
    await click("議事録（短め）を既定に戻す");
    const sent = save.mock.calls[0]?.[0]?.recipes;
    // PATCH は既定の 3 つが揃っていることを求める（外すと 400 になる）
    expect(sent?.map((recipe) => recipe.id)).toEqual(["tpl-1", "tpl-2", "tpl-3"]);
    // 戻した手順は、応答の `defaults` と同じ中身で送る（サーバーは既定と同じ写しを保存しないので、既定に戻る）
    expect(sent?.[1]).toEqual({ id: "tpl-2", ...DEFAULTS["tpl-2"] });
    expect(status()).toBe(SETTINGS_MESSAGES.saved);
  });

  it("closes the editor when the 手順 being edited is reset", async () => {
    const modified = dto();
    modified.recipes[1] = { ...modified.recipes[1]!, name: "議事録（短め）", modified: true };
    await mount(modified);
    save.mockResolvedValue({ ok: true, settings: dto() });
    await click("議事録（短め）を編集");
    expect(field("手順の名前").value).toBe("議事録（短め）");
    // 編集を開いたままだとその行の「既定に戻す」は隠れるので、やめてから戻す
    await click("議事録（短め）の編集をやめる");
    await click("議事録（短め）を既定に戻す");
    expect(save.mock.calls[0]?.[0]?.recipes?.[1]).toEqual({ id: "tpl-2", ...DEFAULTS["tpl-2"] });
  });

  it("names every control and labels every field (読み上げに名前がある)", async () => {
    await mount();
    for (const item of buttons()) expect((item.getAttribute("aria-label") ?? item.textContent ?? "").trim().length, item.outerHTML.slice(0, 80)).toBeGreaterThan(0);
    await click("固有名詞を編集");
    await click("行を追加");
    for (const input of inputs()) {
      expect(input.id, input.outerHTML.slice(0, 80)).toBeTruthy();
      expect(labelFor(input)?.textContent, input.outerHTML.slice(0, 80)).toBeTruthy();
    }
  });
});

describe("「あなたについて」（AI に毎回渡す本人の説明）", () => {
  it("shows a summary, opens the editor, and saves it", async () => {
    save.mockResolvedValue({ ok: true, settings: dto({ about: "直した自己紹介です。" }) });
    const text = (await mount(dto({ about: "合成の自己紹介です。文章は短く書きます。" }))).textContent ?? "";
    expect(text).toContain("合成の自己紹介です。文章は短く書きます。");
    // 公開の著者情報とは別物だと分かる一言
    await click("あなたについてを編集");
    expect(container?.textContent).toContain("公開のときに出る著者の情報とは別のもの");
    await type("あなたについて", "直した自己紹介です。");
    await click("あなたについてを保存");
    expect(save).toHaveBeenCalledWith({ about: "直した自己紹介です。" });
  });

  it("says when it is empty, and does not save a text over the limit", async () => {
    await mount(dto({ about: "" }));
    expect(container?.textContent).toContain(EDITOR_SETTINGS_TEXT.empty);
    await click("あなたについてを編集");
    await type("あなたについて", "あ".repeat(LIMITS.aboutChars + 1));
    await click("あなたについてを保存");
    expect(save).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("長すぎるので保存できません");
  });
});
