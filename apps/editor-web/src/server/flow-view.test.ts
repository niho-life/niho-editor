import { describe, expect, it } from "vitest";
import type { FlowView, TabLocation } from "@niho/editor-store";
import { DEFAULT_RECIPES, findRecipeIn } from "../steps/recipes";
import { flowRows } from "./flow-view";
import type { RunView } from "./steps-api";

const RECIPE = findRecipeIn(DEFAULT_RECIPES, "tpl-1")!;
const [S0, S1, S2] = RECIPE.steps.map((step) => step.id) as [string, string, string];
const FOLDER = "00000000-0000-4000-8000-0000000000f0";

type Tab = FlowView["holders"][number]["tabs"][number];
function tab(id: string, over: Partial<Tab> = {}): Tab {
  return { id, kind: "note", title: "", tabName: null, tabPos: 1, revision: 1, stepStatus: "done", madeFrom: null, ...over };
}
const made = (input: string) => ({ kind: "step" as const, run: "run-1", input, inputRevision: 1 });

/** 録音 › 文字起こし修正（1 タブ）› 記事方針（2 タブ。どちらも文字起こし修正から）› 記事本文（方針 2 から）。 */
function flow(): FlowView {
  return {
    folder: { id: FOLDER, title: "取材", recipe: null },
    holders: [
      { id: "h-rec", title: "合成の録音", role: null, tabs: [tab("rec", { kind: "rec", title: "合成の録音" })] },
      { id: "h0", title: "文字起こし修正", role: { kind: "step", recipe: "tpl-1", stepId: S0 }, tabs: [tab("t0", { madeFrom: made("rec") })] },
      { id: "h1", title: "記事方針", role: { kind: "step", recipe: "tpl-1", stepId: S1 }, tabs: [tab("t1a", { madeFrom: made("t0") }), tab("t1b", { tabPos: 2, madeFrom: made("t0") })] },
      { id: "h2", title: "記事本文", role: { kind: "step", recipe: "tpl-1", stepId: S2 }, tabs: [tab("t2", { madeFrom: made("t1b"), stepStatus: "run" })] },
      { id: "h-col", title: "コラム", role: null, tabs: [tab("col")] },
    ],
    usedEngines: [{ recording: "rec", engine: "gemini" }],
  };
}

function at(id: string, kind: TabLocation["kind"] = "note", holder: string | null = "h", folder: string | null = FOLDER): TabLocation {
  return { id, kind, title: "x", holder, folder };
}

const running: RunView = {
  id: "run-1", recipe: "tpl-1", recipeName: "記事制作", hasGuide: true, recipeRevision: 1, currentRevision: 1, designChanges: [], state: "running", fromStep: 2,
  steps: [{ index: 2, id: S2, name: "記事本文", state: "running", pageId: "t2", stepStatus: "run", staleReasons: [], tries: 1, errorCode: null }],
};

describe("flowRows（流れの行。#309）", () => {
  it("録音のタブ: 文字起こしはエンジンのメニュー（使ったものは済み）、段階は全部「作成」（この録音から作ったものは済み）", () => {
    const rows = flowRows({ tab: at("rec", "rec", "h-rec"), flow: flow(), recipe: RECIPE, run: null, engines: ["deepgram", "gemini"] });
    expect(rows.map((row) => [row.kind, row.name, row.current, row.action])).toEqual([
      ["rec", "合成の録音", true, null],
      ["transcript", "文字起こし", false, "go"],
      ["step", "文字起こし修正", false, "done"],
      ["step", "記事方針", false, "done"],
      ["step", "記事本文", false, "done"],
    ]);
    expect(rows[1]?.engines).toEqual([{ id: "deepgram", used: false }, { id: "gemini", used: true }]);
    expect(rows[2]?.holder).toEqual({ id: "h0", title: "文字起こし修正" });
    expect(rows[3]?.tabs.map((item) => [item.id, item.label])).toEqual([["t1a", "1"], ["t1b", "2"]]);
  });

  it("段階の出力のタブ: 手前の段階と録音には何も出ず、後ろは系譜で済み／作成。今の行には「◯◯ から」", () => {
    const rows = flowRows({ tab: at("t1b", "note", "h1"), flow: flow(), recipe: RECIPE, run: running, engines: ["gemini"] });
    expect(rows.map((row) => [row.name, row.current, row.action])).toEqual([
      ["合成の録音", false, null],
      ["文字起こし", false, null],
      ["文字起こし修正", false, null],
      ["記事方針", true, null],
      ["記事本文", false, "done"],
    ]);
    expect(rows[1]?.engines).toBeUndefined();
    expect(rows[3]?.from).toBe("文字起こし修正");
    expect(rows[4]?.tabs).toEqual([{ id: "t2", kind: "note", label: "1", status: "run", running: true }]);
    // 記事方針 1 からは記事本文を作っていない → 作成。文字起こし修正からは記事方針（2 つ）も記事本文（方針 2 経由）も済み
    expect(flowRows({ tab: at("t1a", "note", "h1"), flow: flow(), recipe: RECIPE, run: null, engines: [] }).map((row) => row.action)).toEqual([null, null, null, null, "go"]);
    expect(flowRows({ tab: at("t0", "note", "h0"), flow: flow(), recipe: RECIPE, run: null, engines: [] }).map((row) => row.action)).toEqual([null, null, null, "done", "done"]);
  });

  it("役割の無いページのタブ: 文字起こしの位置に立ち、段階は全部「作成」。フォルダの外の録音は居場所から行を組む", () => {
    const column = flowRows({ tab: at("col", "note", "h-col"), flow: flow(), recipe: RECIPE, run: null, engines: ["gemini"] });
    expect(column.map((row) => [row.current, row.action])).toEqual([[false, null], [false, null], [false, "go"], [false, "go"], [false, "go"]]);
    expect(column[1]?.engines).toBeUndefined();
    const outside = flowRows({ tab: { id: "lone", kind: "rec", title: "外の録音", holder: "h-lone", folder: null }, flow: null, recipe: RECIPE, run: null, engines: ["gemini"] });
    expect(outside.map((row) => [row.name, row.current, row.action, row.holder?.id ?? null])).toEqual([
      ["外の録音", true, null, "h-lone"],
      ["文字起こし", false, "go", null],
      ["文字起こし修正", false, "go", null],
      ["記事方針", false, "go", null],
      ["記事本文", false, "go", null],
    ]);
    expect(outside[1]?.engines).toEqual([{ id: "gemini", used: false }]);
  });
});
