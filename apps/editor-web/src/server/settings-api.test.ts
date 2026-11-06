import {
  DEFAULT_EDITOR_SETTINGS,
  SETTINGS_LIMITS,
  cleanSettingsPatch,
  recipesProblem,
  settingsProblem,
  type EditorSettings,
  type EditorSettingsPatch,
} from "@niho/editor-store";
import { describe, expect, it } from "vitest";
import type { AuthProvider } from "../auth/types";
import { DEFAULT_RECIPES, toRecipeInputs, type RecipeDef } from "../steps/recipes";
import { duplicateSettingsRecipe, getSettings, patchSettings, type SettingsApiDeps, type SettingsDto, type SettingsRecipeInput } from "./settings-api";

const ORIGIN = "http://editor.test";
// 合成の値だけを使う
const OWNER = "synthetic-owner-a";

/** 設定の API が呼ぶのは getSession だけ。 */
const notUsed = async (): Promise<Response> => {
  throw new Error("the settings API never calls the login routes");
};

function authAs(userId: string | null): AuthProvider {
  return {
    mode: "stub",
    getSession: async () => (userId ? { userId, mode: "stub" } : null),
    beginLogin: notUsed,
    completeLogin: notUsed,
    logout: notUsed,
  };
}

/**
 * 本物と同じ決まりの、覚えておくだけの store（渡した項目を入れ替える・検証を通らない値は投げる）。
 * 手順は表と同じで、行が無い人の最初の読み出しで既定の 4 つを入れる（recipe-source.ts と同じ決まり）。
 */
function memoryStore() {
  const rows = new Map<string, EditorSettings>();
  const recipeRows = new Map<string, RecipeDef[]>();
  return {
    rows,
    recipeRows,
    get: async (owner: string) => structuredClone(rows.get(owner) ?? DEFAULT_EDITOR_SETTINGS),
    save: async (owner: string, patch: EditorSettingsPatch) => {
      if (settingsProblem(patch)) throw new TypeError("not storable");
      const next = { ...(rows.get(owner) ?? DEFAULT_EDITOR_SETTINGS), ...structuredClone(cleanSettingsPatch(patch)) };
      rows.set(owner, next);
      return structuredClone(next);
    },
    recipes: async (owner: string) => {
      const seeded = recipeRows.get(owner) ?? structuredClone(DEFAULT_RECIPES as readonly RecipeDef[]);
      recipeRows.set(owner, seeded as RecipeDef[]);
      return structuredClone(seeded) as RecipeDef[];
    },
    saveRecipes: async (owner: string, list: readonly RecipeDef[]) => {
      if (recipesProblem(toRecipeInputs(list))) throw new TypeError("not storable");
      const next = structuredClone(list) as RecipeDef[];
      recipeRows.set(owner, next);
      return structuredClone(next);
    },
  };
}

function deps(userId: string | null, store: ReturnType<typeof memoryStore> | null, duplicateRecipe?: SettingsApiDeps["duplicateRecipe"]): SettingsApiDeps {
  return { auth: () => authAs(userId), settings: () => store, ...(duplicateRecipe ? { duplicateRecipe } : {}) };
}

function request(method: string, body?: unknown, headers: Record<string, string> = {}, path = "/api/settings"): Request {
  const init: RequestInit = {
    method,
    headers: { host: "editor.test", ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }), ...headers },
  };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

const read = (d: SettingsApiDeps) => getSettings(request("GET"), d);
const write = (body: unknown, d: SettingsApiDeps, headers?: Record<string, string>) => patchSettings(request("PATCH", body, headers), d);
const duplicate = (recipeId: string, d: SettingsApiDeps, headers: Record<string, string> = {}) =>
  duplicateSettingsRecipe(request("POST", undefined, headers, `/api/settings/recipes/${recipeId}/duplicate`), recipeId, d);

async function settingsOf(response: Response): Promise<SettingsDto> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { settings: SettingsDto }).settings;
}

/** 効いている手順の並び（PATCH はこの形の全部を送る）。 */
function effective(dto: SettingsDto): SettingsRecipeInput[] {
  return dto.recipes.map(({ id, name, guide, steps, terms, samples }) => ({ id, name, guide, steps, terms, samples }));
}

describe("GET /api/settings", () => {
  it("answers 401 without a session and 503 without a database, before reading anything", async () => {
    expect((await read(deps(null, memoryStore()))).status).toBe(401);
    expect((await read(deps(OWNER, null))).status).toBe(503);
  });

  it("answers the defaults for someone who never saved, with every default 手順", async () => {
    const dto = await settingsOf(await read(deps(OWNER, memoryStore())));
    expect(dto.aiLang).toBe("same");
    expect(dto.glossary).toEqual([]);
    expect(dto.aboutName).toBe("");
    expect(dto.webSearch).toBe(true);
    expect(dto.recipes.map((recipe) => [recipe.id, recipe.isDefault, recipe.modified])).toEqual([
      ["tpl-1", true, false],
      ["tpl-2", true, false],
      ["tpl-3", true, false],
      ["tpl-4", true, false],
    ]);
    expect(dto.recipes[0]?.steps.map((step) => step.name)).toEqual(DEFAULT_RECIPES[0]?.steps.map((step) => step.name));
    expect(dto.limits).toEqual(SETTINGS_LIMITS);
  });

  it("saves the Web search switch and answers it back, refusing anything but a boolean (#283)", async () => {
    const store = memoryStore();
    expect((await settingsOf(await write({ webSearch: false }, deps(OWNER, store)))).webSearch).toBe(false);
    expect((await settingsOf(await read(deps(OWNER, store)))).webSearch).toBe(false);
    expect((await write({ webSearch: "off" }, deps(OWNER, store))).status).toBe(400);
    expect((await settingsOf(await write({ webSearch: true }, deps(OWNER, store)))).webSearch).toBe(true);
  });

  it("does not answer with another person's settings", async () => {
    const store = memoryStore();
    await write({ aiLang: "en" }, deps(OWNER, store));
    expect((await settingsOf(await read(deps("synthetic-owner-b", store)))).aiLang).toBe("same");
  });
});

describe("POST /api/settings/recipes/{id}/duplicate", () => {
  it("requires the owner and same origin, then returns the atomically duplicated recipe list", async () => {
    const store = memoryStore();
    const recipes = await store.recipes(OWNER);
    const d = deps(OWNER, store, async (owner, recipeId) => {
      const current = await store.recipes(owner);
      const source = current.find((recipe) => recipe.id === recipeId);
      if (!source) return { status: "not_found" };
      const copy: RecipeDef = {
        ...source,
        id: "r-copy",
        name: "記事制作のコピー",
        steps: source.steps.map((step) => ({ ...step, id: `copy-${step.id}` })),
        terms: source.terms.map((term) => ({ ...term, variants: [...term.variants] })),
        samples: source.samples.map((sample) => ({ ...sample, id: `copy-${sample.id}` })),
      };
      const next = [...current, copy];
      store.recipeRows.set(owner, next);
      return { status: "created", recipes: next };
    });

    expect((await duplicate("tpl-1", deps(null, store, d.duplicateRecipe))).status).toBe(401);
    expect((await duplicate("tpl-1", d, { origin: "https://other.example" })).status).toBe(403);
    const response = await duplicate("tpl-1", d);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { settings: SettingsDto };
    expect(body.settings.recipes).toHaveLength(recipes.length + 1);
    expect(body.settings.recipes.at(-1)).toMatchObject({ id: "r-copy", name: "記事制作のコピー", isDefault: false });
  });

  it("returns 404 for a missing source and 409 when a limit prevents copying", async () => {
    const store = memoryStore();
    const missing = deps(OWNER, store, async () => ({ status: "not_found" }));
    expect((await duplicate("tpl-404", missing)).status).toBe(404);
    const limited = deps(OWNER, store, async () => ({ status: "limit" }));
    expect(await (await duplicate("tpl-1", limited)).json()).toEqual({ error: "recipe_limit" });
  });
});

describe("PATCH /api/settings", () => {
  it("answers 401 without a session, 403 from another origin, and 503 without a database", async () => {
    expect((await write({ aiLang: "ja" }, deps(null, memoryStore()))).status).toBe(401);
    expect((await write({ aiLang: "ja" }, deps(OWNER, memoryStore()), { origin: "http://evil.test" })).status).toBe(403);
    expect((await write({ aiLang: "ja" }, deps(OWNER, memoryStore()), { origin: "null" })).status).toBe(403);
    expect((await write({ aiLang: "ja" }, deps(OWNER, null))).status).toBe(503);
  });

  it("saves the AI 提案の言語 and the 固有名詞, and the next read answers them", async () => {
    const store = memoryStore();
    const d = deps(OWNER, store);
    const saved = await settingsOf(await write({ aiLang: "en", glossary: [{ term: " 北鎌倉 ", reading: "きたかまくら", variants: ["北鎌", " "], note: "" }] }, d));
    expect(saved.aiLang).toBe("en");
    // 前後の空白は落ち、空の誤りやすい表記は消える
    expect(saved.glossary).toEqual([{ term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌"], note: "" }]);
    expect(await settingsOf(await read(d))).toEqual(saved);
  });

  it("saves 呼び名 without replacing the existing 自己紹介", async () => {
    const store = memoryStore();
    const d = deps(OWNER, store);
    await write({ about: "既存の自己紹介を残す" }, d);
    const saved = await settingsOf(await write({ aboutName: "  合成\n呼び名  " }, d));
    expect(saved.aboutName).toBe("合成 呼び名");
    expect(saved.about).toBe("既存の自己紹介を残す");
    expect(await settingsOf(await read(d))).toEqual(saved);
  });

  it("refuses an unknown key, an unknown language and a glossary over the limits with 400, writing nothing", async () => {
    const store = memoryStore();
    const d = deps(OWNER, store);
    for (const body of [
      { nope: 1 },
      { aiLang: "fr" },
      { aboutName: "あ".repeat(SETTINGS_LIMITS.aboutNameChars + 1) },
      { aboutName: "改行以外の制御\u0000" },
      { glossary: [{ term: "" }] },
      { glossary: Array.from({ length: SETTINGS_LIMITS.glossary + 1 }, (_, i) => ({ term: `t${i}`, reading: "", variants: [], note: "" })) },
      "not json at all",
    ]) {
      expect((await write(body, d)).status, JSON.stringify(body)).toBe(400);
    }
    expect(store.rows.size).toBe(0);
  });

  it("hands the screen the default definition of every default 手順, so that 既定に戻す can send it back", async () => {
    const store = memoryStore();
    const d = deps(OWNER, store);
    const before = await settingsOf(await read(d));
    for (const recipe of before.recipes) {
      expect(recipe.defaults, recipe.id).toEqual({ name: recipe.name, guide: recipe.guide, steps: recipe.steps, terms: recipe.terms, samples: recipe.samples });
    }

    // 1 つに手を入れてから、応答の `defaults` で置き換えて送ると、保存した写しが消えて既定に戻る
    const edited = effective(before).map((recipe) => (recipe.id === "tpl-2" ? { ...recipe, name: "議事録（短め）" } : recipe));
    const saved = await settingsOf(await write({ recipes: edited }, d));
    // 既定の 4 つも行として保存される（手を入れた分だけではない）
    expect(store.recipeRows.get(OWNER)?.map((recipe) => [recipe.id, recipe.name])).toEqual([
      ["tpl-1", "記事制作"],
      ["tpl-2", "議事録（短め）"],
      ["tpl-3", DEFAULT_RECIPES[2]!.name],
      ["tpl-4", DEFAULT_RECIPES[3]!.name],
    ]);
    const reset = effective(saved).map((recipe) => (recipe.id === "tpl-2" ? { id: recipe.id, ...saved.recipes[1]!.defaults! } : recipe));
    const back = await settingsOf(await write({ recipes: reset }, d));
    expect(back.recipes.map((recipe) => recipe.modified)).toEqual([false, false, false, false]);
    expect(back.recipes[1]?.name).toBe("議事録");
    expect(store.recipeRows.get(OWNER)).toEqual(DEFAULT_RECIPES);
  });

  it("keeps an edited 手順 and reports it as modified; sending the default values back clears the saved copy", async () => {
    const store = memoryStore();
    const d = deps(OWNER, store);
    const before = await settingsOf(await read(d));
    const edited = effective(before).map((recipe) =>
      recipe.id === "tpl-2" ? { ...recipe, name: "議事録（短め）", guide: "短く", steps: recipe.steps.map((step, i) => (i === 0 ? { ...step, instruction: "要点だけ。" } : step)) } : recipe,
    );
    const saved = await settingsOf(await write({ recipes: edited }, d));
    expect(saved.recipes.map((recipe) => [recipe.id, recipe.modified])).toEqual([
      ["tpl-1", false],
      ["tpl-2", true],
      ["tpl-3", false],
      ["tpl-4", false],
    ]);
    expect(saved.recipes[1]?.name).toBe("議事録（短め）");
    expect(store.recipeRows.get(OWNER)?.[1]?.steps.map((step) => step.profile)).toEqual(DEFAULT_RECIPES[1]!.steps.map((step) => step.profile));

    const back = await settingsOf(await write({ recipes: effective(before) }, d));
    expect(back.recipes.map((recipe) => recipe.modified)).toEqual([false, false, false, false]);
    expect(store.recipeRows.get(OWNER)).toEqual(DEFAULT_RECIPES);
  });

  it("adds and duplicates 手順 after the defaults, and removes one by leaving it out", async () => {
    const store = memoryStore();
    const d = deps(OWNER, store);
    const base = effective(await settingsOf(await read(d)));
    const copy: SettingsRecipeInput = { ...base[0]!, id: "r-copy", name: "記事制作のコピー" };
    const added: SettingsRecipeInput = { id: "r-talk", name: "対談", guide: "", steps: [{ id: "s-1", name: "まとめ", instruction: "まとめる。" }], terms: [], samples: [] };
    const saved = await settingsOf(await write({ recipes: [...base, copy, added] }, d));
    expect(saved.recipes.map((recipe) => [recipe.id, recipe.isDefault])).toEqual([
      ["tpl-1", true],
      ["tpl-2", true],
      ["tpl-3", true],
      ["tpl-4", true],
      ["r-copy", false],
      ["r-talk", false],
    ]);
    // 足したものは段階の id を自由に持てる（既定の写しは既定と同じ id を保つ）
    expect(saved.recipes.find((recipe) => recipe.id === "r-copy")?.steps.map((step) => step.id)).toEqual(DEFAULT_RECIPES[0]!.steps.map((step) => step.id));

    const removed = await settingsOf(await write({ recipes: [...base, added] }, d));
    expect(removed.recipes.map((recipe) => recipe.id)).toEqual(["tpl-1", "tpl-2", "tpl-3", "tpl-4", "r-talk"]);
  });

  it("refuses a 手順 list that drops a default, repeats one, removes or renumbers a default 段階, but accepts reordering", async () => {
    const store = memoryStore();
    const d = deps(OWNER, store);
    const base = effective(await settingsOf(await read(d)));
    const bodies: unknown[] = [
      { recipes: base.filter((recipe) => recipe.id !== "tpl-2") },
      { recipes: [...base, base[0]!] },
      { recipes: base.map((recipe) => (recipe.id === "tpl-1" ? { ...recipe, steps: recipe.steps.slice(1) } : recipe)) },
      { recipes: base.map((recipe) => (recipe.id === "tpl-1" ? { ...recipe, steps: recipe.steps.map((step) => ({ ...step, id: "s-new" })) } : recipe)) },
      { recipes: base.map((recipe) => (recipe.id === "tpl-3" ? { ...recipe, steps: [] } : recipe)) },
    ];
    for (const body of bodies) expect((await write(body, d)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    expect(store.rows.size).toBe(0);
    const reordered = base.map((recipe) => recipe.id === "tpl-1" ? { ...recipe, steps: [...recipe.steps].reverse() } : recipe);
    const accepted = await settingsOf(await write({ recipes: reordered }, d));
    expect(accepted.recipes[0]?.steps.map((step) => step.id)).toEqual([...DEFAULT_RECIPES[0]!.steps].reverse().map((step) => step.id));
  });

  it("preserves profile, terms and sample metadata when an older screen omits them", async () => {
    const store = memoryStore();
    const d = deps(OWNER, store);
    const current = effective(await settingsOf(await read(d)));
    const enriched = current.map((recipe) => recipe.id === "tpl-1" ? {
      ...recipe,
      terms: [{ term: "合成語", reading: "ごうせいご", variants: ["合成語句"], note: "保持する" }],
      samples: [{ id: "sample-1", name: "合成のお手本", chars: 123, sourceUrl: "https://example.test/sample" }],
      steps: recipe.steps.map((step) => ({ ...step, profile: "light" })),
    } : recipe);
    await write({ recipes: enriched }, d);
    const oldPayload = enriched.map(({ id, name, guide, steps }) => ({
      id, name, guide,
      steps: steps.map(({ id: stepId, name: stepName, instruction }) => ({ id: stepId, name: stepName, instruction })),
    }));
    const saved = await settingsOf(await write({ recipes: oldPayload }, d));
    expect(saved.recipes[0]?.terms).toEqual(enriched[0]?.terms);
    expect(saved.recipes[0]?.samples).toEqual(enriched[0]?.samples);
    expect(saved.recipes[0]?.steps[0]?.profile).toBe("light");
  });

  it("changes only what was passed", async () => {
    const store = memoryStore();
    const d = deps(OWNER, store);
    await write({ glossary: [{ term: "円覚寺", reading: "えんがくじ", variants: [], note: "" }] }, d);
    const after = await settingsOf(await write({ aiLang: "ja" }, d));
    expect(after.aiLang).toBe("ja");
    expect(after.glossary).toHaveLength(1);
  });

  it("never hands the response a key the screen does not need", async () => {
    const dto = await settingsOf(await read(deps(OWNER, memoryStore())));
    expect(Object.keys(dto).sort()).toEqual(["about", "aboutName", "aiLang", "glossary", "limits", "recipes", "webSearch"]);
    expect(Object.keys(dto.recipes[0]!).sort()).toEqual(["defaults", "guide", "id", "isDefault", "modified", "name", "samples", "steps", "terms", "unusableReason"]);
  });
});
