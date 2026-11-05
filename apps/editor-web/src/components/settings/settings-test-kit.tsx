// テストだけが使う合成の値と、画面を描いて押すための小さな道具（*.test.tsx から読む）
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SettingsDto } from "@/lib/settings-client";
import { DEFAULT_RECIPES, DEFAULT_RECIPE_IDS } from "@/steps/recipes";

type RecipeDefaults = NonNullable<SettingsDto["recipes"][number]["defaults"]>;

/** 既定の工程定義をそのまま使う（既定変更がテスト用の写しに隠れないようにする）。 */
export const DEFAULTS = Object.fromEntries(DEFAULT_RECIPES.map((recipe) => [recipe.id, {
  name: recipe.name,
  guide: recipe.guide,
  steps: recipe.steps.map((step) => ({ ...step })),
  terms: recipe.terms.map((term) => ({ ...term, variants: [...term.variants] })),
  samples: recipe.samples.map((sample) => ({ ...sample })),
}])) as Record<string, RecipeDefaults>;

// 上限の値そのものは editor-store が決める（`settings-api.test.ts` が応答と突き合わせる）。ここは形だけを合わせる
export const LIMITS: SettingsDto["limits"] = {
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
  aboutNameChars: 80,
};

export { DEFAULT_RECIPE_IDS };

export function dto(patch: Partial<SettingsDto> = {}): SettingsDto {
  return {
    aiLang: "same",
    glossary: [],
    aboutName: "",
    about: "",
    recipes: DEFAULT_RECIPE_IDS.map((id) => ({
      id,
      ...structuredClone(DEFAULTS[id]!),
      isDefault: true,
      modified: false,
      unusableReason: null,
      defaults: structuredClone(DEFAULTS[id]!),
    })),
    limits: LIMITS,
    ...patch,
  };
}

/** 足した手順（既定でない）。 */
export function customRecipe(patch: Partial<SettingsDto["recipes"][number]> = {}): SettingsDto["recipes"][number] {
  return {
    id: "r-talk", name: "対談", guide: "", steps: [{ id: "s-1", name: "まとめ", instruction: "まとめる。", profile: "standard" }],
    terms: [], samples: [], isDefault: false, modified: false, unusableReason: null, defaults: null, ...patch,
  };
}

/** PATCH の答え: 送った手順の並びを、そのまま画面の形にして返す。 */
export function echoRecipes(recipes: { id: string; name: string; guide: string; steps: { id: string; name: string; instruction: string; profile?: string }[]; terms?: SettingsDto["glossary"]; samples?: SettingsDto["recipes"][number]["samples"] }[], patch: Partial<SettingsDto> = {}): SettingsDto {
  return dto({
    ...patch,
    recipes: recipes.map((recipe) => {
      const base = Object.hasOwn(DEFAULTS, recipe.id) ? structuredClone(DEFAULTS[recipe.id]!) : null;
      return { ...recipe, steps: recipe.steps.map((step) => ({ ...step, profile: step.profile ?? "standard" })), terms: recipe.terms ?? [], samples: recipe.samples ?? [], isDefault: base !== null, modified: false, unusableReason: null, defaults: base };
    }),
  });
}

let root: Root | null = null;
let container: HTMLElement | null = null;

export async function mount(element: ReactElement): Promise<HTMLElement> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
  return container;
}

export async function unmount(): Promise<void> {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
}

export const shown = () => container?.textContent ?? "";
export const buttons = () => [...(container?.querySelectorAll("button") ?? [])];
const nameOf = (item: Element) => (item.getAttribute("aria-label") ?? item.textContent ?? "").trim();
export const button = (label: string) => buttons().find((item) => nameOf(item) === label);
export const link = (label: string) => [...(container?.querySelectorAll("a") ?? [])].find((item) => nameOf(item).startsWith(label));

export async function click(label: string): Promise<void> {
  const target = button(label);
  if (!target) throw new Error(`no button named ${label}`);
  await act(async () => target.click());
}

export async function flush(): Promise<void> {
  await act(async () => undefined);
}

export const inputs = () => [...(container?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea") ?? [])];

export function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const byAria = inputs().find((item) => item.getAttribute("aria-label") === label);
  if (byAria) return byAria;
  const node = [...(container?.querySelectorAll("label") ?? [])].find((item) => item.textContent === label);
  const input = node ? inputs().find((item) => item.id === node.htmlFor) : undefined;
  if (!input) throw new Error(`no field named ${label}`);
  return input;
}

export const labelFor = (input: HTMLInputElement | HTMLTextAreaElement) => input.getAttribute("aria-label") ?? [...(container?.querySelectorAll("label") ?? [])].find((item) => item.htmlFor === input.id)?.textContent;

export async function type(label: string, value: string): Promise<void> {
  const input = field(label);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function blur(label: string): Promise<void> {
  const input = field(label);
  await act(async () => {
    input.focus();
    input.blur();
  });
}

export const status = () => container?.querySelector('[role="status"]')?.textContent;

/** 読み上げに名前がある（ボタンは名前、欄はラベル）。 */
export function unnamed(): string[] {
  return [
    ...buttons().filter((item) => nameOf(item) === "").map((item) => item.outerHTML.slice(0, 80)),
    ...inputs().filter((input) => !labelFor(input)).map((input) => input.outerHTML.slice(0, 80)),
  ];
}
