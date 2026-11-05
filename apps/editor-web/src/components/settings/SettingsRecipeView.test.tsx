// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDITOR_SETTINGS_TEXT } from "niho-docs-ui/shell";
import type { GuideExtractionPreview, SettingsDto, SettingsFailure, SettingsPatchInput } from "@/lib/settings-client";
import type { RecipeSample } from "@niho/editor-store";
import { SETTINGS_MESSAGES } from "@/settings/messages";
import { blur, button, click, clickRow, customRecipe, DEFAULT_RECIPE_IDS, DEFAULTS, dto, echoRecipes, field, mount, shown, status, type, unmount, unnamed } from "./settings-test-kit";

const push = vi.fn();
const save = vi.fn<(patch: SettingsPatchInput) => Promise<{ ok: true; settings: SettingsDto } | SettingsFailure>>();
const duplicate = vi.fn<(recipeId: string) => Promise<{ ok: true; settings: SettingsDto } | SettingsFailure>>();
const importSample = vi.fn<(recipeId: string, input: { file: File } | { url: string }) => Promise<{ ok: true; sample: RecipeSample } | SettingsFailure>>();
const load = vi.fn<() => Promise<{ ok: true; settings: SettingsDto } | SettingsFailure>>();
const loadExtraction = vi.fn<(recipeId: string) => Promise<{ ok: true; extraction: GuideExtractionPreview | null } | SettingsFailure>>();
const extract = vi.fn<(recipeId: string) => Promise<{ ok: true; extraction: GuideExtractionPreview } | SettingsFailure>>();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/settings-client", () => ({
  saveSettings: (patch: SettingsPatchInput) => save(patch),
  duplicateSettingsRecipe: (recipeId: string) => duplicate(recipeId),
  importRecipeSample: (recipeId: string, input: { file: File } | { url: string }) => importSample(recipeId, input),
  loadSettings: () => load(),
  loadGuideExtraction: (recipeId: string) => loadExtraction(recipeId),
  extractGuide: (recipeId: string) => extract(recipeId),
}));

import { SettingsRecipeView } from "./SettingsRecipeView";

const open = (recipeId: string, initial: SettingsDto = dto()) => mount(<SettingsRecipeView initial={initial} recipeId={recipeId} />);
const withCustom = (patch: Parameters<typeof customRecipe>[0] = {}) => {
  const base = dto();
  return { ...base, recipes: [...base.recipes, customRecipe(patch)] };
};
const sentRecipe = (call: number, id: string) => save.mock.calls[call]?.[0]?.recipes?.find((recipe) => recipe.id === id);

beforeEach(() => {
  for (const mock of [push, save, duplicate, importSample, load, loadExtraction, extract]) mock.mockReset();
  loadExtraction.mockResolvedValue({ ok: true, extraction: null });
  save.mockImplementation(async (patch) => ({ ok: true, settings: echoRecipes(patch.recipes ?? []) }));
});

afterEach(unmount);

describe("SettingsRecipeView（/settings/recipes/{id}）", () => {
  it("edits a stage in the sheet and sends the whole effective list, with the edited one in its place", async () => {
    await open("tpl-1");
    const first = DEFAULTS["tpl-1"]!.steps[0]!;
    await clickRow(`段階 1 ${first.name}`, "を開く");
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("段階 1 の編集");
    await type("指示", "短く整える。");
    expect(shown()).toContain("6 字");
    await click("段階を保存");
    const sent = save.mock.calls[0]?.[0]?.recipes;
    expect(sent?.map((recipe) => recipe.id)).toEqual([...DEFAULT_RECIPE_IDS]);
    expect(sent?.[0]).toEqual({ id: "tpl-1", ...DEFAULTS["tpl-1"], steps: DEFAULTS["tpl-1"]!.steps.map((step, index) => (index === 0 ? { ...step, instruction: "短く整える。" } : step)) });
    // 保存できたらシートは閉じ、h1 の下で言う
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(status()).toBe(SETTINGS_MESSAGES.saved);
  });

  it("does not send a stage whose instruction is empty", async () => {
    await open("tpl-1");
    await clickRow(`段階 1 ${DEFAULTS["tpl-1"]!.steps[0]!.name}`, "を開く");
    await type("指示", "  ");
    expect(shown()).toContain("指示を書いてください。");
    expect(button("段階を保存")?.getAttribute("aria-disabled")).toBe("true");
    await click("段階を保存");
    expect(save).not.toHaveBeenCalled();
  });

  it("renames the recipe on blur, and refuses a name another recipe uses", async () => {
    await open("tpl-1");
    await type("手順の名前", "記事制作（短め）");
    await blur("手順の名前");
    expect(sentRecipe(0, "tpl-1")?.name).toBe("記事制作（短め）");
    await type("手順の名前", DEFAULTS["tpl-2"]!.name);
    expect(shown()).toContain("この手順名はほかの手順と重複しています。");
    await blur("手順の名前");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("reorders stages from the ⋯ menu right away, preserving each stage id and profile", async () => {
    await open("tpl-1");
    const original = DEFAULTS["tpl-1"]!.steps;
    const [first, second] = original as [typeof original[number], typeof original[number]];
    await click("段階 2 のメニュー");
    await click("上へ");
    const sent = sentRecipe(0, "tpl-1");
    expect(sent?.steps.map((step) => [step.id, step.profile])).toEqual([
      [second.id, second.profile],
      [first.id, first.profile],
      ...original.slice(2).map((step) => [step.id, step.profile]),
    ]);
    // 端は押せない
    await click("段階 1 のメニュー");
    expect(button("上へ")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("does not offer to add or remove a 段階 of a default 手順, and says why", async () => {
    await open("tpl-1");
    expect(button("段階を追加")).toBeUndefined();
    expect(shown()).toContain(EDITOR_SETTINGS_TEXT.fixedSteps);
    expect(button("複製して足す")).toBeTruthy();
    await click("段階 1 のメニュー");
    expect(button("削除")).toBeUndefined();
    expect(button("複製")).toBeUndefined();
  });

  it("adds and removes a 段階 of a recipe the owner made (never sending an empty instruction)", async () => {
    await open("r-talk", withCustom());
    await click("段階を追加");
    await type("名前", "見出し");
    expect(button("段階を保存")?.getAttribute("aria-disabled")).toBe("true");
    await type("指示", "見出しを立てる。");
    await click("段階を保存");
    const added = sentRecipe(0, "r-talk");
    expect(added?.steps.map((step) => [step.name, step.instruction, step.profile])).toEqual([
      ["まとめ", "まとめる。", "standard"],
      ["見出し", "見出しを立てる。", "standard"],
    ]);
    await click("段階 2 のメニュー");
    await click("削除");
    expect(sentRecipe(1, "r-talk")?.steps.map((step) => step.name)).toEqual(["まとめ"]);
  });

  it("duplicates a 手順 through the owner-scoped API and opens the copy", async () => {
    await open("tpl-1");
    const initial = dto();
    const copy = customRecipe({ id: "r-server-copy", name: "記事制作のコピー" });
    duplicate.mockResolvedValue({ ok: true, settings: dto({ recipes: [...initial.recipes, copy] }) });
    await click("複製して足す");
    expect(duplicate).toHaveBeenCalledWith("tpl-1");
    expect(save).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/settings/recipes/r-server-copy");
  });

  it("offers 既定に戻す only for a changed default, and sends the default definition back (never a list missing a default)", async () => {
    await open("tpl-1");
    await click("手順のメニュー");
    expect(button("既定に戻す")).toBeUndefined();
    const remove = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.startsWith("削除"));
    expect(remove?.getAttribute("aria-disabled")).toBe("true");
    expect(remove?.textContent).toContain("既定の手順");
    await unmount();

    const modified = dto();
    modified.recipes[1] = { ...modified.recipes[1]!, name: "議事録（短め）", guide: "短く", steps: [{ ...DEFAULTS["tpl-2"]!.steps[0]!, name: "要点", instruction: "要点だけ。" }], modified: true };
    await open("tpl-2", modified);
    expect(shown()).toContain("変更あり");
    await click("手順のメニュー");
    await click("既定に戻す");
    const sent = save.mock.calls[0]?.[0]?.recipes;
    // PATCH は既定の手順が揃っていることを求める（外すと 400 になる）
    expect(sent?.map((recipe) => recipe.id)).toEqual([...DEFAULT_RECIPE_IDS]);
    expect(sent?.[1]).toEqual({ id: "tpl-2", ...DEFAULTS["tpl-2"] });
    expect(status()).toBe(SETTINGS_MESSAGES.saved);
    expect((field("手順の名前") as HTMLInputElement).value).toBe(DEFAULTS["tpl-2"]!.name);
  });

  it("removes a recipe the owner made by leaving it out, then goes back to /settings", async () => {
    await open("r-talk", withCustom());
    await click("手順のメニュー");
    await click("削除");
    expect(save.mock.calls[0]?.[0]?.recipes?.map((recipe) => recipe.id)).toEqual([...DEFAULT_RECIPE_IDS]);
    expect(push).toHaveBeenCalledWith("/settings");
  });

  it("keeps the recipe and says so when the save fails", async () => {
    await open("tpl-1");
    save.mockResolvedValue({ ok: false, status: 503, error: "unavailable", message: SETTINGS_MESSAGES.unavailable });
    await clickRow("文書ガイド", "開く");
    await type("文書ガイド", "新しいガイド");
    await click("文書ガイドを保存");
    expect(status()).toBe(SETTINGS_MESSAGES.unavailable);
    // シートは開いたまま、下書きも残る（シートの中でも言う）
    expect(field("文書ガイド").value).toBe("新しいガイド");
    expect(document.querySelector('[role="dialog"] [role="status"]')?.textContent).toBe(SETTINGS_MESSAGES.unavailable);
  });

  it("imports a sample (the server attaches it) and reads the settings again", async () => {
    await open("r-talk", withCustom());
    const sample: RecipeSample = { id: "sample-1", name: "朝市レポート.md", chars: 8200 };
    importSample.mockResolvedValue({ ok: true, sample });
    load.mockResolvedValue({ ok: true, settings: withCustom({ samples: [sample] }) });
    await clickRow("お手本の文書を 取り込む", "ファイル・URL");
    expect(button("取り込む")?.getAttribute("aria-disabled")).toBe("true");
    await type("公開 Web ページの URL", "https://example.invalid/a");
    await click("取り込む");
    expect(importSample).toHaveBeenCalledWith("r-talk", { url: "https://example.invalid/a" });
    expect(save).not.toHaveBeenCalled();
    expect(shown()).toContain("朝市レポート.md");
    expect(status()).toBe("お手本文書を追加しました");
  });

  it("removes a sample right away and offers the extraction only with samples", async () => {
    const sample: RecipeSample = { id: "sample-1", name: "朝市レポート.md", chars: 8200 };
    await open("r-talk", withCustom({ samples: [sample] }));
    expect(button("文書ガイドを抽出")).toBeTruthy();
    await click("朝市レポート.md を外す");
    expect(sentRecipe(0, "r-talk")?.samples).toEqual([]);
    expect(button("文書ガイドを抽出")).toBeUndefined();
  });

  it("extracts, shows the 抽出 sheet, and applies only what is pressed", async () => {
    const sample: RecipeSample = { id: "sample-1", name: "朝市レポート.md", chars: 8200 };
    await open("r-talk", withCustom({ samples: [sample] }));
    extract.mockResolvedValue({ ok: true, extraction: { sampleIds: ["sample-1"], guide: "## 抽出したガイド", candidates: [{ term: "朝市", reading: "あさいち", variants: [], note: "" }] } });
    await click("文書ガイドを抽出");
    expect(extract).toHaveBeenCalledWith("r-talk");
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("抽出した案");
    expect(save).not.toHaveBeenCalled();
    await click("選んだ固有名詞を追加");
    expect(sentRecipe(0, "r-talk")?.terms).toEqual([{ term: "朝市", reading: "あさいち", variants: [], note: "" }]);
    await click("文書ガイドに置き換える");
    expect(sentRecipe(1, "r-talk")?.guide).toBe("## 抽出したガイド");
  });

  it("edits この手順だけの固有名詞 one row at a time, splitting the variants only at save", async () => {
    await open("r-talk", withCustom());
    await click("追加");
    await type("表記", "鎌倉ひとはこ");
    await type("誤りやすい表記（「・」で区切る）", "鎌倉一箱・");
    expect(field("誤りやすい表記（「・」で区切る）").value).toBe("鎌倉一箱・");
    await click("固有名詞を保存");
    expect(sentRecipe(0, "r-talk")?.terms).toEqual([{ term: "鎌倉ひとはこ", reading: "", variants: ["鎌倉一箱"], note: "" }]);
  });

  it("names every control and labels every field, with each sheet open", async () => {
    const sample: RecipeSample = { id: "sample-1", name: "朝市レポート.md", chars: 8200 };
    await open("r-talk", withCustom({ samples: [sample] }));
    expect(unnamed()).toEqual([]);
    const openers: [string, () => Promise<void>][] = [
      ["段階 1 まとめ", () => clickRow("段階 1 まとめ", "を開く")],
      ["文書ガイド", () => clickRow("文書ガイド", "開く")],
      ["お手本の文書を取り込む", () => clickRow("お手本の文書を 取り込む", "ファイル・URL")],
    ];
    for (const [opener, openIt] of openers) {
      await openIt();
      expect(unnamed(), opener).toEqual([]);
      await click("閉じる");
    }
  });
});
