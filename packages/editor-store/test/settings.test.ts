import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SETTINGS_LIMITS,
  cleanSettingsPatch,
  getEditorSettings,
  isSettingsRecipe,
  isSettingsTerm,
  saveEditorSettings,
  settingsProblem,
  type EditorSettingsPatch,
  type SettingsRecipe,
  type SettingsTerm,
} from "../src/settings.ts";
import type { Queryable } from "../src/types.ts";

// 合成のユーザー ID だけを使う（実在の人の値を入れない）
const OWNER = "synthetic-owner-a";

const term = (patch: Partial<SettingsTerm> = {}): SettingsTerm => ({ term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌"], note: "合成", ...patch });
const recipe = (patch: Partial<SettingsRecipe> = {}): SettingsRecipe => ({
  id: "tpl-1",
  name: "記事制作",
  guide: "## 構成\n見出しを 4 本。",
  steps: [{ id: "s-1", name: "記事方針", instruction: "方針を書く。" }],
  ...patch,
});

describe("settingsProblem", () => {
  it("passes an empty change and each item on its own", () => {
    assert.equal(settingsProblem({}), null);
    assert.equal(settingsProblem({ aiLang: "ja" }), null);
    assert.equal(settingsProblem({ glossary: [term()] }), null);
    assert.equal(settingsProblem({ recipes: [recipe()] }), null);
    assert.equal(settingsProblem({ aboutName: "呼び名" }), null);
    assert.equal(settingsProblem({ aiLang: "same", glossary: [], recipes: [] }), null);
  });

  it("refuses an unknown key, a non-object and an unknown language", () => {
    for (const patch of [null, undefined, [], "x", 1, { nope: 1 }, { aiLang: "ja", nope: 1 }]) {
      assert.equal(settingsProblem(patch), "ai_lang", JSON.stringify(patch));
    }
    for (const aiLang of ["fr", "JA", "", null, 1]) assert.equal(settingsProblem({ aiLang }), "ai_lang", String(aiLang));
  });

  it("refuses a glossary row without a 表記, with control characters, over the limits, or repeated", () => {
    assert.equal(settingsProblem({ glossary: [term({ term: "" })] }), "glossary");
    assert.equal(settingsProblem({ glossary: [term({ term: "  " })] }), "glossary");
    assert.equal(settingsProblem({ glossary: [term({ term: "a\nb" })] }), "glossary");
    assert.equal(settingsProblem({ glossary: [term({ reading: "x".repeat(SETTINGS_LIMITS.termChars + 1) })] }), "glossary");
    assert.equal(settingsProblem({ glossary: [term({ note: "x".repeat(SETTINGS_LIMITS.noteChars + 1) })] }), "glossary");
    assert.equal(settingsProblem({ glossary: [term({ variants: Array.from({ length: SETTINGS_LIMITS.variants + 1 }, (_, i) => `v${i}`) })] }), "glossary");
    // 空の誤りやすい表記は断らずに落とす（cleanSettingsPatch）
    assert.equal(settingsProblem({ glossary: [term({ variants: ["", " "] })] }), null);
    assert.equal(settingsProblem({ glossary: Array.from({ length: SETTINGS_LIMITS.glossary + 1 }, (_, i) => term({ term: `t${i}` })) }), "glossary");
    // 同じ表記を 2 行持てない（AI の表で先に書いた方が勝つ、を作らない）
    assert.equal(settingsProblem({ glossary: [term(), term({ reading: "ちがう" })] }), "glossary");
    assert.equal(isSettingsTerm({ term: "x", reading: "", variants: [], note: "", extra: 1 }), false);
  });

  it("refuses a recipe without a step, with a bad id, over the limits, or repeated", () => {
    assert.equal(settingsProblem({ recipes: [recipe({ steps: [] })] }), "recipes");
    assert.equal(settingsProblem({ recipes: [recipe({ id: "Tpl-1" })] }), "recipes");
    assert.equal(settingsProblem({ recipes: [recipe({ id: "-x" })] }), "recipes");
    assert.equal(settingsProblem({ recipes: [recipe({ id: "a".repeat(65) })] }), "recipes");
    assert.equal(settingsProblem({ recipes: [recipe({ name: " " })] }), "recipes");
    assert.equal(settingsProblem({ recipes: [recipe({ guide: "x".repeat(SETTINGS_LIMITS.guideChars + 1) })] }), "recipes");
    assert.equal(settingsProblem({ recipes: [recipe({ steps: Array.from({ length: SETTINGS_LIMITS.steps + 1 }, (_, i) => ({ id: `s-${i}`, name: `段階 ${i}`, instruction: "" })) })] }), "recipes");
    assert.equal(settingsProblem({ recipes: [recipe({ steps: [{ id: "s-1", name: "a", instruction: "" }, { id: "s-1", name: "b", instruction: "" }] })] }), "recipes");
    assert.equal(settingsProblem({ recipes: [recipe(), recipe()] }), "recipes");
    assert.equal(settingsProblem({ recipes: Array.from({ length: SETTINGS_LIMITS.recipes + 1 }, (_, i) => recipe({ id: `r-${i}` })) }), "recipes");
    assert.equal(isSettingsRecipe({ ...recipe(), extra: 1 }), false);
  });

  it("keeps newlines in お手本 and 指示, but not in a name", () => {
    assert.equal(settingsProblem({ recipes: [recipe({ guide: "a\nb\tc" })] }), null);
    assert.equal(settingsProblem({ recipes: [recipe({ steps: [{ id: "s-1", name: "方針", instruction: "a\nb" }] })] }), null);
    assert.equal(settingsProblem({ recipes: [recipe({ name: "a\nb" })] }), "recipes");
    assert.equal(settingsProblem({ recipes: [recipe({ guide: "a\u0000b" })] }), "recipes");
  });
});

describe("cleanSettingsPatch", () => {
  it("trims every text and drops empty 誤りやすい表記, leaving items that were not passed out", () => {
    const cleaned = cleanSettingsPatch({
      glossary: [term({ term: " 北鎌倉 ", reading: " きたかまくら ", variants: [" 北鎌 ", "  "], note: " 合成 " })],
      recipes: [recipe({ name: " 記事制作 ", guide: " ## 構成 ", steps: [{ id: "s-1", name: " 方針 ", instruction: " 書く " }] })],
    });
    assert.deepEqual(cleaned.glossary, [{ term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌"], note: "合成" }]);
    assert.deepEqual(cleaned.recipes, [{ id: "tpl-1", name: "記事制作", guide: "## 構成", steps: [{ id: "s-1", name: "方針", instruction: "書く" }] }]);
    assert.equal("aiLang" in cleaned, false);
    assert.deepEqual(Object.keys(cleanSettingsPatch({ aiLang: "en" })), ["aiLang"]);
    assert.equal(settingsProblem({ aboutName: "あ".repeat(SETTINGS_LIMITS.aboutNameChars) }), null);
    assert.equal(settingsProblem({ aboutName: "あ".repeat(SETTINGS_LIMITS.aboutNameChars + 1) }), "about_name");
    // The save normalizer collapses whitespace in the single-line name field.
    assert.equal(settingsProblem({ aboutName: "a\nb" }), null);
    assert.equal(settingsProblem({ aboutName: 7 }), "about_name");
    assert.deepEqual(cleanSettingsPatch({ aboutName: "  合成\n  呼び名  " }), { aboutName: "合成 呼び名" });
  });
});

describe("editor settings without a database", () => {
  const untouchable: Queryable = {
    query: (() => {
      throw new Error("must not reach the database");
    }) as unknown as Queryable["query"],
  };

  it("refuses an empty or over-long owner before querying", async () => {
    await assert.rejects(() => getEditorSettings(untouchable, ""), TypeError);
    await assert.rejects(() => saveEditorSettings(untouchable, "x".repeat(257), { aiLang: "ja" }), TypeError);
  });

  it("refuses a change that settingsProblem turns down before querying", async () => {
    for (const patch of [{ aiLang: "fr" }, { glossary: [{ term: "" }] }, { recipes: [{ id: "x" }] }] as unknown as EditorSettingsPatch[]) {
      await assert.rejects(() => saveEditorSettings(untouchable, OWNER, patch), TypeError, JSON.stringify(patch));
    }
  });
});

describe("editor settings read", () => {
  it("answers the defaults for a missing row, and drops stored values that no longer fit the shape", async () => {
    const rows = (value: unknown) => ({ query: async () => ({ rows: value === undefined ? [] : [value] }) }) as unknown as Queryable;
    assert.deepEqual(await getEditorSettings(rows(undefined), OWNER), { aiLang: "same", glossary: [], recipes: [], aboutName: "", about: "", webSearch: true });
    const mixed = await getEditorSettings(rows({ ai_lang: "nope", glossary: [term(), { term: "" }], recipes: [recipe(), { id: "bad" }] }), OWNER);
    assert.deepEqual(mixed, { aiLang: "same", glossary: [term()], recipes: [recipe()], aboutName: "", about: "", webSearch: true });
    assert.deepEqual(await getEditorSettings(rows({ ai_lang: "en", glossary: "nope", recipes: null, about_name: 7, about: 7, web_search: "no" }), OWNER), { aiLang: "en", glossary: [], recipes: [], aboutName: "", about: "", webSearch: true });
    assert.equal((await getEditorSettings(rows({ ai_lang: "ja", web_search: false }), OWNER)).webSearch, false);
    assert.equal((await getEditorSettings(rows({ ai_lang: "ja", about: "合成の自己紹介" }), OWNER)).about, "合成の自己紹介");
    assert.equal((await getEditorSettings(rows({ ai_lang: "ja", about_name: "合成の呼び名", about: "保存済み" }), OWNER)).aboutName, "合成の呼び名");
  });

  it("keeps 「あなたについて」 within its limit and trims it", async () => {
    assert.equal(settingsProblem({ about: "合成の自己紹介" }), null);
    assert.equal(settingsProblem({ about: "あ".repeat(SETTINGS_LIMITS.aboutChars) }), null);
    assert.equal(settingsProblem({ about: "あ".repeat(SETTINGS_LIMITS.aboutChars + 1) }), "about");
    assert.equal(settingsProblem({ about: 7 }), "about");
    assert.equal(settingsProblem({ about: "a\u0000b" }), "about");
    assert.deepEqual(cleanSettingsPatch({ about: "  合成の自己紹介  " }), { about: "合成の自己紹介" });
  });

  it("takes the Web search switch only as a boolean (#283)", () => {
    assert.equal(settingsProblem({ webSearch: false }), null);
    assert.equal(settingsProblem({ webSearch: true }), null);
    assert.equal(settingsProblem({ webSearch: "off" }), "web_search");
    assert.equal(settingsProblem({ webSearch: null }), "web_search");
    assert.deepEqual(cleanSettingsPatch({ webSearch: false }), { webSearch: false });
  });
});
