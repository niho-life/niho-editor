import assert from "node:assert/strict";
import { test } from "node:test";
import { computeStepBasis, parseStepBasis, stepStaleReasons, type StepMaterials, type StepRecipe } from "../src/index.ts";

const block = (text: string) => [{ type: "paragraph", content: [{ type: "text", text }] }];
const recipe: StepRecipe = {
  id: "recipe", guide: "文書ガイド", terms: [],
  steps: [
    { id: "one", name: "一", instruction: "一の指示" },
    { id: "two", name: "二", instruction: "二の指示" },
    { id: "three", name: "三", instruction: "三の指示" },
  ],
};
const materials: StepMaterials = {
  parentBlocks: block("原文"),
  backgroundBlocks: block("親フォルダの背景"),
  upstream: [{ id: "one", blocks: block("一の本文") }, { id: "two", blocks: block("二の本文") }],
  refs: [{ id: "ref-1", blocks: block(" 参考本文 ") }],
  fields: { entities: [], terms: [] },
  settings: { aiLang: "same", glossary: [], aboutName: "", about: "" },
};

test("step basis records six SHA-256 sections and every upstream step id", () => {
  const basis = computeStepBasis(recipe, 2, materials);
  assert.deepEqual(Object.keys(basis).sort(), ["artifacts", "guide", "info", "refs", "source", "step"]);
  assert.deepEqual(Object.keys(basis.artifacts), ["one", "two"]);
  assert.ok(parseStepBasis(basis));
  assert.equal(parseStepBasis("a".repeat(64)), undefined);
  assert.deepEqual(stepStaleReasons(undefined, basis), []);
  assert.deepEqual(stepStaleReasons(basis, computeStepBasis(recipe, 2, { ...materials, upstream: [{ id: "one", blocks: block("変更") }, materials.upstream[1]!] })), ["artifact"]);
  assert.deepEqual(stepStaleReasons(basis, computeStepBasis(recipe, 2, { ...materials, upstream: [materials.upstream[0]!] })), ["artifact"]);
});

test("source, refs, info, guide and step change independently; reference title is excluded", () => {
  const basis = computeStepBasis(recipe, 2, materials);
  assert.deepEqual(stepStaleReasons(basis, computeStepBasis(recipe, 2, { ...materials, parentBlocks: block("変更") })), ["source"]);
  assert.deepEqual(stepStaleReasons(basis, computeStepBasis(recipe, 2, { ...materials, backgroundBlocks: block("変更した背景") })), ["info"]);
  assert.deepEqual(stepStaleReasons(basis, computeStepBasis(recipe, 2, { ...materials, backgroundBlocks: [...materials.backgroundBlocks, block("長い本文の末尾")[0]!] })), ["info"]);
  assert.deepEqual(stepStaleReasons(basis, computeStepBasis(recipe, 2, { ...materials, refs: [{ id: "ref-1", blocks: block("別の本文") }] })), ["refs"]);
  assert.deepEqual(stepStaleReasons(basis, computeStepBasis(recipe, 2, { ...materials, refs: [{ ...materials.refs[0]!, title: "題名だけ変更" }] })), []);
  assert.deepEqual(stepStaleReasons(basis, computeStepBasis(recipe, 2, { ...materials, fields: { entities: [{ name: "合成", reading: "", role: "", note: "" }], terms: [] } })), ["info"]);
  assert.deepEqual(stepStaleReasons(basis, computeStepBasis(recipe, 2, { ...materials, settings: { ...materials.settings, about: "変更" } })), ["info"]);
  assert.deepEqual(stepStaleReasons(basis, computeStepBasis({ ...recipe, guide: "変更" }, 2, materials)), ["guide"]);
  assert.deepEqual(stepStaleReasons(basis, computeStepBasis({ ...recipe, steps: [...recipe.steps.slice(0, 2), { ...recipe.steps[2]!, instruction: "変更" }] }, 2, materials)), ["step"]);
});

test("the full normalized folder body is hashed even past the prompt's background limit", () => {
  const longBody = "あ".repeat(9_000);
  const recorded = computeStepBasis(recipe, 0, { ...materials, backgroundBlocks: block(longBody + "末尾A") });
  const current = computeStepBasis(recipe, 0, { ...materials, backgroundBlocks: block(longBody + "末尾B") });
  assert.deepEqual(stepStaleReasons(recorded, current), ["info"]);
});
