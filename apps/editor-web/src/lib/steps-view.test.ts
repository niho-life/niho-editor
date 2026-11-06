import { describe, expect, it } from "vitest";
import { DEFAULT_RECIPES } from "@/steps/recipes";
import type { StepRecipeChoice, StepRun, StepRunStep } from "./steps-client";
import {
  UNKNOWN_FAILURE,
  isStepRunActive,
  stepBandNote,
  stepChunkNotice,
  stepDoneMessage,
  stepFailure,
  stepInputCutNotice,
  stepRecipeName,
  stepRunActions,
  stepStateOf,
} from "./steps-view";

const NAMES = ["文字起こし修正", "記事方針", "記事本文"];

function step(index: number, over: Partial<StepRunStep> = {}): StepRunStep {
  return { index, id: `s${index}`, name: NAMES[index] ?? `段階 ${index}`, state: "pending", pageId: `page-${index}`, stepStatus: "wait", tries: 0, errorCode: null, ...over };
}

function run(over: Partial<StepRun> = {}): StepRun {
  return { id: "run-1", recipe: "tpl-1", state: "running", fromStep: 0, steps: [step(0), step(1), step(2)], ...over };
}

/** サーバーが答える、その人の手順（既定の 4 つに手を入れていないとき）。 */
const DEFAULTS: StepRecipeChoice[] = DEFAULT_RECIPES.map((recipe) => ({ id: recipe.id, name: recipe.name, defaultName: recipe.name }));

describe("steps-view（流れの run の見た目。#309）", () => {
  it("手順の名前は一覧から。設定から消えた手順の run でも id のまま出す", () => {
    expect(stepRecipeName(DEFAULTS, "tpl-2")).toBe("議事録");
    expect(stepRecipeName([{ id: "r-1", name: "対談", defaultName: null }], "tpl-3")).toBe("tpl-3");
  });

  it("段階の状態は、実行中・失敗が先で、そのあとに前提変更", () => {
    expect(stepStateOf(step(0, { state: "running", stepStatus: "stale" }))).toBe("run");
    expect(stepStateOf(step(0, { state: "failed", stepStatus: "failed" }))).toBe("failed");
    expect(stepStateOf(step(0, { state: "succeeded", stepStatus: "stale" }))).toBe("stale");
    expect(stepStateOf(step(0, { state: "reused", stepStatus: "done" }))).toBe("done");
    expect(stepStateOf(step(0, { state: "succeeded", stepStatus: "done" }))).toBe("done");
    // 出力のタブを削除した（stepStatus が null）段階は、結果が無いので前提変更と同じ
    expect(stepStateOf(step(0, { state: "succeeded", stepStatus: null }))).toBe("stale");
    expect(stepStateOf(step(0, { state: "queued" }))).toBe("wait");
    expect(stepStateOf(step(0, { state: "canceled" }))).toBe("wait");
  });

  it("区切りの一言（#277）: 作成中は「作成中 3/5」（合間の queued も作成中）、失敗は「区切り 3 で失敗」、済みは出さない", () => {
    expect(stepChunkNotice(step(0, { state: "running", chunk: { index: 2, count: 5 } }))).toBe("作成中 3/5");
    expect(stepChunkNotice(step(0, { state: "queued", chunk: { index: 2, count: 5 } }))).toBe("作成中 3/5");
    expect(stepStateOf(step(0, { state: "queued", chunk: { index: 1, count: 5 } }))).toBe("run");
    expect(stepStateOf(step(0, { state: "queued", chunk: { index: 0, count: 5 } }))).toBe("wait");
    expect(stepChunkNotice(step(0, { state: "failed", chunk: { index: 2, count: 5 } }))).toBe("区切り 3 で失敗");
    expect(stepChunkNotice(step(0, { state: "succeeded", stepStatus: "done" }))).toBeNull();
  });

  it("資料を上限で切って作った段階には、使った字数の一言（切っていない・古い run は出さない）", () => {
    expect(stepInputCutNotice(step(0, { state: "succeeded", stepStatus: "done", inputUsedChars: 120000 }))).toBe("入力が長いので先頭 120,000 字だけ使いました");
    expect(stepInputCutNotice(step(0, { state: "succeeded", stepStatus: "done" }))).toBeNull();
  });

  it("動いているかどうかで、読み直すかを決める", () => {
    expect(isStepRunActive(run({ state: "queued" }))).toBe(true);
    expect(isStepRunActive(run({ state: "running" }))).toBe(true);
    expect(isStepRunActive(run({ state: "succeeded" }))).toBe(false);
    expect(isStepRunActive(null)).toBe(false);
  });

  it("流れの下の一言が、いま何が起きているかを言う", () => {
    expect(stepBandNote(run({ steps: [step(0, { state: "running" }), step(1), step(2)] }))).toBe("「文字起こし修正」を作成中です。画面を閉じても進みます。");
    expect(stepBandNote(run({ steps: [step(0, { state: "running", chunk: { index: 1, count: 4 } }), step(1), step(2)] }))).toBe("「文字起こし修正」を作成中です（区切り 2/4）。画面を閉じても進みます。");
    expect(stepBandNote(run({ state: "queued", steps: [step(0, { state: "queued" }), step(1), step(2)] }))).toBe("順番を待っています。画面を閉じても進みます。");
    expect(stepBandNote(run({ state: "canceled" }))).toBe("手順を取消しました。もう一度始められます。");
    expect(stepBandNote(run({ state: "failed", steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { state: "failed", stepStatus: "failed", errorCode: "ai_timeout" }), step(2, { state: "canceled" })] })))
      .toBe("「記事方針」が失敗しました。AI の答えを待てる時間を過ぎました。少し待ってもう一度お試しください。");
    expect(stepBandNote(run({ state: "failed", steps: [step(0, { state: "failed", stepStatus: "failed", errorCode: "invalid_output", chunk: { index: 2, count: 5 } }), step(1, { state: "canceled" }), step(2, { state: "canceled" })] })))
      .toContain("「文字起こし修正」が区切り 3 で失敗しました。");
    expect(stepBandNote(run({ state: "succeeded", steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { state: "succeeded", stepStatus: "stale", staleReasons: ["source"] }), step(2, { state: "succeeded", stepStatus: "stale" })] })))
      .toContain("「記事方針」のタブを作り直すと印が消えます。");
    expect(stepBandNote(run({ state: "succeeded", steps: [step(0, { state: "succeeded", stepStatus: "done" })] }))).toBe("すべての段階が済みました。");
  });

  it("失敗の code ごとに、次に何をすればいいかの文を出す（code は画面に出さない）", () => {
    expect(stepFailure("quota_exceeded")).toMatchObject({ retryable: false, rerun: false, settings: "usage" });
    expect(stepFailure("ai_unavailable")).toMatchObject({ retryable: false, rerun: false, settings: null });
    expect(stepFailure("invalid_output")).toMatchObject({ retryable: false, rerun: true, settings: "steps" });
    expect(stepFailure("ai_timeout")).toMatchObject({ retryable: true, rerun: true, settings: null });
    expect(stepFailure("input_changed").message).toContain("最初から作り直してください");
    for (const code of ["quota_exceeded", "invalid_output", "ai_timeout", "lease_expired"]) expect(stepFailure(code).message).not.toContain(code);
    expect(stepFailure("something_new")).toBe(UNKNOWN_FAILURE);
    expect(stepFailure(null)).toBe(UNKNOWN_FAILURE);
  });

  it("動いている間は「やめる」だけ。済み・前提変更の run には run の操作は無い（作り直しは流れの「作成」とタブの ▾）", () => {
    expect(stepRunActions(run())).toEqual([{ id: "cancel", label: "やめる", tone: "quiet", cancel: true }]);
    expect(stepRunActions(run({ state: "succeeded", steps: [step(0, { state: "succeeded", stepStatus: "stale" })] }))).toEqual([]);
    expect(stepRunActions(run({ state: "canceled", steps: [step(0, { state: "canceled" })] }))).toEqual([]);
  });

  it("失敗した段階は、そのタブを同じ入力で作り直す（主ボタン）。設定への案内はその後ろ", () => {
    const failed = run({ state: "failed", steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { state: "failed", stepStatus: "failed", errorCode: "invalid_output" }), step(2, { state: "canceled" })] });
    expect(stepRunActions(failed)).toEqual([
      { id: "retry", label: "「記事方針」を作り直す", tone: "primary", regenerate: "page-1" },
      { id: "steps", label: "手順を見る", tone: "quiet", settings: "steps" },
    ]);
  });

  it("やり直しても同じ結果になる失敗では、やり直しのボタンを出さない（設定への案内だけ）", () => {
    const quota = run({ state: "failed", steps: [step(0, { state: "failed", stepStatus: "failed", errorCode: "quota_exceeded" }), step(1, { state: "canceled" }), step(2, { state: "canceled" })] });
    expect(stepRunActions(quota)).toEqual([{ id: "usage", label: "使用量を見る", tone: "primary", settings: "usage" }]);
    const unavailable = run({ state: "failed", steps: [step(0, { state: "failed", stepStatus: "failed", errorCode: "ai_unavailable" }), step(1, { state: "canceled" }), step(2, { state: "canceled" })] });
    expect(stepRunActions(unavailable)).toEqual([]);
  });

  it("区切りの途中の失敗は「区切り 3 からやり直す」が主で、作り直しは「最初から」と言う（#277）。入力が変わったら続きからは出さない", () => {
    const chunked = run({ state: "failed", steps: [step(0, { state: "failed", stepStatus: "failed", errorCode: "invalid_output", chunk: { index: 2, count: 5 } }), step(1, { state: "canceled" }), step(2, { state: "canceled" })] });
    expect(stepRunActions(chunked)).toEqual([
      { id: "resume", label: "区切り 3 からやり直す", tone: "primary", resume: true },
      { id: "retry", label: "「文字起こし修正」を最初から作り直す", tone: "outline", regenerate: "page-0" },
      { id: "steps", label: "手順を見る", tone: "quiet", settings: "steps" },
    ]);
    const changed = run({ state: "failed", steps: [step(0, { state: "failed", stepStatus: "failed", errorCode: "input_changed", chunk: { index: 2, count: 5 } }), step(1, { state: "canceled" }), step(2, { state: "canceled" })] });
    expect(stepRunActions(changed).map((action) => action.id)).toEqual(["retry"]);
    // 今月の上限で区切りの途中に止まったら、使用量の案内と続きからの再開
    const quota = run({ state: "failed", steps: [step(0, { state: "failed", stepStatus: "failed", errorCode: "quota_exceeded", chunk: { index: 1, count: 3 } }), step(1, { state: "canceled" }), step(2, { state: "canceled" })] });
    expect(stepRunActions(quota).map((action) => [action.id, action.tone])).toEqual([["usage", "primary"], ["resume", "outline"]]);
  });

  it("終わったときの通知の一言", () => {
    expect(stepDoneMessage(DEFAULTS, run({ state: "succeeded" }))).toBe("記事制作の手順が終わりました。");
    expect(stepDoneMessage(DEFAULTS, run({ recipeName: "座談会", state: "failed", steps: [step(0, { state: "failed" })] }))).toBe("座談会の手順が「文字起こし修正」で失敗しました。");
    expect(stepDoneMessage(DEFAULTS, run({ state: "canceled" }))).toBeNull();
    expect(stepDoneMessage(DEFAULTS, run())).toBeNull();
  });
});
