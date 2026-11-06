import { describe, expect, it } from "vitest";
import { DEFAULT_RECIPES } from "@/steps/recipes";
import type { StepRecipeChoice, StepRun, StepRunStep } from "./steps-client";
import {
  isStepRunActive,
  stepBandActions,
  stepBandNote,
  stepBandSteps,
  stepDoneMessage,
  stepPagesOf,
  stepRecipeName,
  stepFailure,
  stepStartChoices,
  stepStartLabel,
  stepStateOf,
  maxStepFrom,
  UNKNOWN_FAILURE,
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

describe("steps-view（手順の帯の見た目）", () => {
  it("入口はサーバーが答えた手順の順で、既定の名前のままなら決まった言い方", () => {
    expect(DEFAULT_RECIPES.map((recipe) => recipe.name)).toEqual(["記事制作", "議事録", "インサイト整理", "コーチング"]);
    expect(stepStartChoices(DEFAULTS)).toEqual([
      { id: "tpl-1", label: "記事にする" },
      { id: "tpl-2", label: "議事録にする" },
      { id: "tpl-3", label: "インサイトを整理する" },
      // コーチングは決まった言い方を持たず、既定の `{名前}にする` で出す（オーナー 2026-11-01）
      { id: "tpl-4", label: "コーチングにする" },
    ]);
    expect(stepRecipeName(DEFAULTS, "tpl-2")).toBe("議事録");
  });

  it("設定（#108）で名前を変えた・足した手順は、その名前から入口の文字を作る", () => {
    const mine: StepRecipeChoice[] = [
      // 既定の手順の名前を変えた
      { id: "tpl-2", name: "座談会メモ", defaultName: "議事録" },
      // 設定で足した手順
      { id: "r-1", name: "対談", defaultName: null },
    ];
    expect(stepStartChoices(mine)).toEqual([
      { id: "tpl-2", label: "座談会メモにする" },
      { id: "r-1", label: "対談にする" },
    ]);
    expect(stepStartLabel({ id: "tpl-1", name: "記事制作", defaultName: "記事制作" })).toBe("記事にする");
    expect(stepRecipeName(mine, "r-1")).toBe("対談");
    // 設定から消えた手順の run でも帯は出す（名前は id のまま）
    expect(stepRecipeName(mine, "tpl-3")).toBe("tpl-3");
  });

  it("段階の状態は、実行中・失敗が先で、そのあとに前提変更", () => {
    expect(stepStateOf(step(0, { state: "running", stepStatus: "run" }))).toBe("run");
    // 実行中なら、前の前提変更の印は出さない（やり直しが走っている）
    expect(stepStateOf(step(0, { state: "running", stepStatus: "stale" }))).toBe("run");
    expect(stepStateOf(step(0, { state: "failed", stepStatus: "failed", errorCode: "invalid_output" }))).toBe("failed");
    expect(stepStateOf(step(0, { state: "succeeded", stepStatus: "done" }))).toBe("done");
    expect(stepStateOf(step(0, { state: "reused", stepStatus: "done" }))).toBe("done");
    expect(stepStateOf(step(0, { state: "succeeded", stepStatus: "stale" }))).toBe("stale");
    // サブページをゴミ箱へ入れた（結果が無い）ので、その段階から作り直せる扱いにする
    expect(stepStateOf(step(0, { state: "succeeded", stepStatus: null }))).toBe("stale");
    expect(stepStateOf(step(0, { state: "queued" }))).toBe("wait");
    expect(stepStateOf(step(0, { state: "pending" }))).toBe("wait");
    expect(stepStateOf(step(0, { state: "canceled", stepStatus: "wait" }))).toBe("wait");
  });

  it("帯の段階は、サブページの id・段階の名前・状態（段階の名前はサーバーが返す値のまま）", () => {
    const view = run({ steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { state: "running" }), step(2)] });
    expect(stepBandSteps(view)).toEqual([
      { id: "page-0", label: "文字起こし修正", state: "done" },
      { id: "page-1", label: "記事方針", state: "run" },
      { id: "page-2", label: "記事本文", state: "wait" },
    ]);
  });

  it("資料を上限で切って作った段階には、使った字数を済みの言葉に続けて出す（#277。切っていない・古い run は出さない）", () => {
    const view = run({
      state: "succeeded",
      steps: [
        step(0, { state: "succeeded", stepStatus: "done", inputUsedChars: 100_000 }),
        step(1, { state: "succeeded", stepStatus: "done" }),
        step(2, { state: "succeeded", stepStatus: "stale", inputUsedChars: 100_000 }),
      ],
    });
    expect(stepBandSteps(view)).toEqual([
      { id: "page-0", label: "文字起こし修正", state: "done", notice: "済み · 入力が長いので先頭 100,000 字だけ使いました" },
      { id: "page-1", label: "記事方針", state: "done" },
      // 前提変更の印が先（作り直せば字数も測り直す）
      { id: "page-2", label: "記事本文", state: "stale" },
    ]);
  });

  it("動いているかどうかで、読み直すかを決める", () => {
    expect(isStepRunActive(null)).toBe(false);
    expect(isStepRunActive(run({ state: "queued" }))).toBe(true);
    expect(isStepRunActive(run({ state: "running" }))).toBe(true);
    for (const state of ["succeeded", "failed", "canceled"] as const) expect(isStepRunActive(run({ state }))).toBe(false);
  });

  it("帯の下の一言が、いま何が起きているかを言う", () => {
    expect(stepBandNote(run({ state: "queued" }))).toBe("順番を待っています。画面を閉じても進みます。");
    expect(stepBandNote(run({ steps: [step(0, { state: "running" }), step(1), step(2)] }))).toBe("「文字起こし修正」を作成中です。画面を閉じても進みます。");
    expect(stepBandNote(run({ state: "canceled" }))).toBe("手順を取消しました。もう一度始められます。");
    // 失敗の文は code ごと（下の「失敗の code ごとに…」で全部を見る）
    expect(
      stepBandNote(
        run({
          state: "failed",
          steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { state: "failed", errorCode: "invalid_output" }), step(2)],
        }),
      ),
    ).toBe("「記事方針」が失敗しました。AI の答えを本文にできませんでした。手順の指示やお手本を見直すと直ることがあります。");
    const stale = run({
      state: "succeeded",
      steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { state: "succeeded", stepStatus: "stale" }), step(2, { state: "succeeded", stepStatus: "stale" })],
    });
    expect(stepBandNote(stale)).toBe("元にした内容が変わりました。「記事方針」から作り直すと印が消えます。");
    expect(stepBandNote({ ...stale, steps: stale.steps.map((item, index) => index === 1 ? { ...item, staleReasons: ["refs"] } : item) })).toContain("参考のページが変わりました。");
    expect(stepBandSteps({ ...stale, steps: stale.steps.map((item, index) => index === 1 ? { ...item, staleReasons: ["refs"] } : item) })[1]?.notice).toBe("参考のページが変わりました。");
    expect(stepBandNote(run({ state: "succeeded", steps: [step(0, { state: "succeeded", stepStatus: "done" })] }))).toBe("すべての段階が済みました。");
  });

  it("失敗の code ごとに、次に何をすればいいかの文を出す（code は画面に出さない）", () => {
    const codes: [string, string][] = [
      ["ai_unavailable", "AI がまだ設定されていないので、この段階を作れません。設定が済むまでお待ちください。"],
      ["ai_auth", "AI の鍵が使えませんでした。設定が直るまでこの段階を作れません。"],
      ["quota_exceeded", "今月の AI の使用量が上限に達しました。来月まで手順を実行できません。"],
      ["invalid_output", "AI の答えを本文にできませんでした。手順の指示やお手本を見直すと直ることがあります。"],
      ["ai_bad_request", "AI がこの指示を受け付けませんでした。手順の指示やお手本を短くすると直ることがあります。"],
      ["usage_unavailable", "使用量を数えられませんでした。少し待ってもう一度お試しください。"],
      ["ai_rate_limit", "AI への問い合わせが混み合っています。少し待ってもう一度お試しください。"],
      ["ai_overloaded", "AI が混み合っています。少し待ってもう一度お試しください。"],
      ["ai_server", "AI の側で失敗しました。少し待ってもう一度お試しください。"],
      ["ai_timeout", "AI の答えを待てる時間を過ぎました。少し待ってもう一度お試しください。"],
      ["ai_network", "AI に届きませんでした。少し待ってもう一度お試しください。"],
      ["output_too_long", "長すぎて書き切れませんでした。この段階の指示で扱う範囲を分けて頼むと通ることがあります。"],
      ["step_time_limit", "安全に保存できる時間を超えたため途中で止めました。書けた部分を確認して、段階を分けてもう一度お試しください。"],
      ["unknown_recipe", "この手順の定義が見つかりませんでした。設定の「手順」を確かめてください。"],
      ["unknown_step", "手順の段階が変わりました。はじめから作り直してください。"],
      ["input_missing", "もとになる本文が空でした。前の段階のページを書いてからやり直してください。"],
      ["invalid_input", "もとになる本文を読めませんでした。前の段階のページを確かめてください。"],
      ["page_missing", "結果を書くページが見つかりませんでした。はじめから作り直してください。"],
      ["lease_expired", "時間がかかりすぎて止まりました。少し待ってもう一度お試しください。"],
      ["aborted", "途中で止まりました。少し待ってもう一度お試しください。"],
      ["internal", "思わぬ失敗で止まりました。少し待ってもう一度お試しください。"],
    ];
    for (const [code, message] of codes) {
      expect(stepFailure(code).message, code).toBe(message);
      // 帯の一言は「どの段階が失敗したか」＋その文（code そのものは出さない）
      const note = stepBandNote(run({ state: "failed", steps: [step(0, { state: "failed", errorCode: code })] }));
      expect(note, code).toBe(`「文字起こし修正」が失敗しました。${message}`);
      expect(note, code).not.toContain(code);
    }
  });

  it("知らない code・code の無い失敗は既定（待てば直るものとして扱う）", () => {
    expect(stepFailure("something_new")).toEqual(UNKNOWN_FAILURE);
    expect(stepFailure(null)).toEqual(UNKNOWN_FAILURE);
    expect(UNKNOWN_FAILURE).toEqual({ retryable: true, rerun: true, settings: null, message: "この段階を作れませんでした。少し待ってもう一度お試しください。" });
    expect(stepBandNote(run({ state: "failed", steps: [step(0, { state: "failed", errorCode: "something_new" })] }))).toBe(
      "「文字起こし修正」が失敗しました。この段階を作れませんでした。少し待ってもう一度お試しください。",
    );
  });

  it("待てば直るものと、原因を直すものを分けている", () => {
    const retryable = ["usage_unavailable", "ai_rate_limit", "ai_overloaded", "ai_server", "ai_timeout", "ai_network", "lease_expired", "aborted", "internal"];
    const notRetryable = ["ai_unavailable", "quota_exceeded", "invalid_output", "ai_auth", "ai_bad_request", "output_too_long", "step_time_limit"];
    for (const code of retryable) expect(stepFailure(code).retryable, code).toBe(true);
    for (const code of notRetryable) expect(stepFailure(code).retryable, code).toBe(false);
    // 待てば直るものは「少し待って」と言う
    for (const code of retryable) expect(stepFailure(code).message, code).toContain("少し待ってもう一度");
  });

  it("やり直しても同じ結果になる失敗では、やり直しのボタンを出さない（設定への案内だけ）", () => {
    const failedWith = (code: string) =>
      run({ state: "failed", steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { state: "failed", errorCode: code, stepStatus: "failed" })] });

    // AI がまだ設定されていない・鍵が使えない: 利用者には直せないので、どのやり直しも出さない
    for (const code of ["ai_unavailable", "ai_auth"]) {
      expect(stepBandActions(failedWith(code), "page-1"), code).toEqual([]);
      expect(stepBandActions(failedWith(code), "rec"), code).toEqual([]);
    }

    // 今月の上限: やり直しは出さず、使用量への案内だけ
    expect(stepBandActions(failedWith("quota_exceeded"), "page-1")).toEqual([{ id: "usage", label: "使用量を見る", tone: "primary", settings: "usage" }]);

    // 原因を直せるものは、やり直しも出す（手順への案内を添える）
    expect(stepBandActions(failedWith("invalid_output"), "rec")).toEqual([
      { id: "retry", label: "「記事方針」からやり直す", tone: "primary", fromStep: 1 },
      { id: "restart", label: "はじめから作り直す", tone: "outline", fromStep: 0 },
      { id: "steps", label: "手順を見る", tone: "quiet", settings: "steps" },
    ]);

    // 待てば直るものは、今までどおりやり直しだけ
    expect(stepBandActions(failedWith("ai_timeout"), "rec").map((action) => action.id)).toEqual(["retry", "restart"]);
    expect(stepBandActions(failedWith("something_new"), "rec").map((action) => action.id)).toEqual(["retry", "restart"]);
  });

  it("前提変更（失敗ではない）のときは、失敗の扱いでボタンを消さない", () => {
    // 段階 1 が前提変更・段階 2 が ai_unavailable で失敗。作り直すのは手前の段階 1 なので、やり直しは出す
    const mixed = run({
      state: "failed",
      steps: [
        step(0, { state: "succeeded", stepStatus: "done" }),
        step(1, { state: "succeeded", stepStatus: "stale" }),
        step(2, { state: "failed", errorCode: "ai_unavailable", stepStatus: "failed" }),
      ],
    });
    expect(stepBandActions(mixed, "rec").map((action) => action.id)).toEqual(["retry", "restart"]);
  });

  it("動いている間は「やめる」だけ", () => {
    expect(stepBandActions(run({ state: "running" }), "page-1")).toEqual([{ id: "cancel", label: "やめる", tone: "quiet", cancel: true }]);
  });

  it("失敗した段階・前提が変わった段階からやり直せる（その段階だけを指す）", () => {
    const failed = run({
      state: "failed",
      steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { state: "failed", errorCode: "internal" }), step(2)],
    });
    // 録音ページ（どの段階でもない）を開いているとき
    expect(stepBandActions(failed, "rec")).toEqual([
      { id: "retry", label: "「記事方針」からやり直す", tone: "primary", fromStep: 1 },
      { id: "restart", label: "はじめから作り直す", tone: "outline", fromStep: 0 },
    ]);
    // その失敗した段階のページを開いているときは、同じことを二度出さない
    expect(stepBandActions(failed, "page-1").map((action) => action.id)).toEqual(["retry", "restart"]);
    // 手前の段階 1 が済みでないので、段階 2 のページを開いていても「この手順を作り直す」は出さない（サーバーが断る）
    expect(stepBandActions(failed, "page-2")).toEqual([
      { id: "retry", label: "「記事方針」からやり直す", tone: "primary", fromStep: 1 },
      { id: "restart", label: "はじめから作り直す", tone: "outline", fromStep: 0 },
    ]);
  });

  it("手前が済みの段階のページを開いていれば、その段階からの作り直しも出す", () => {
    const failed = run({
      state: "failed",
      steps: [
        step(0, { state: "succeeded", stepStatus: "done" }),
        step(1, { state: "succeeded", stepStatus: "done" }),
        step(2, { state: "failed", errorCode: "internal", stepStatus: "failed" }),
      ],
    });
    expect(stepBandActions(failed, "page-1")).toEqual([
      { id: "retry", label: "「記事本文」からやり直す", tone: "primary", fromStep: 2 },
      { id: "redo-here", label: "この手順を作り直す", tone: "outline", fromStep: 1 },
      { id: "restart", label: "はじめから作り直す", tone: "outline", fromStep: 0 },
    ]);
  });

  it("段階 2 が失敗したあとに段階 0 を直したら、主ボタンは手前の段階 1 を送る（サーバーが断る始点を押させない）", () => {
    // refreshStale は、失敗した段階 2 の手前の済みの段階 1 を「前提変更」にする。createRun は手前が全部済みでないと断るので、
    // 段階 2 ではなく段階 1 から作り直す
    const run2 = run({
      state: "failed",
      steps: [
        step(0, { state: "succeeded", stepStatus: "done" }),
        step(1, { state: "succeeded", stepStatus: "stale" }),
        step(2, { state: "failed", errorCode: "internal", stepStatus: "failed" }),
      ],
    });
    expect(maxStepFrom(run2)).toBe(1);
    expect(stepBandActions(run2, "rec")).toEqual([
      { id: "retry", label: "「記事方針」からやり直す", tone: "primary", fromStep: 1 },
      { id: "restart", label: "はじめから作り直す", tone: "outline", fromStep: 0 },
    ]);
    // 段階 2 のページを開いていても、断られる始点（fromStep: 2）はボタンにしない
    expect(stepBandActions(run2, "page-2").map((action) => action.fromStep)).toEqual([1, 0]);
  });

  it("手前の段階が済みでなければ、そこまで手前へ丸める（ボタンの文字も送る段階の名前にする）", () => {
    // 取消のあと: 段階 0 は待機に戻り、済みだった段階 1 は前提変更。始められるのは段階 0 だけ
    const canceled = run({
      state: "canceled",
      steps: [step(0, { state: "canceled", stepStatus: "wait" }), step(1, { state: "succeeded", stepStatus: "stale" })],
    });
    expect(maxStepFrom(canceled)).toBe(0);
    expect(stepBandActions(canceled, "page-1")).toEqual([
      { id: "retry", label: "「文字起こし修正」からやり直す", tone: "primary", fromStep: 0 },
      { id: "restart", label: "はじめから作り直す", tone: "outline", fromStep: 0 },
    ]);
  });

  it("すべて済んでいる手順では、どの段階からでも始められる", () => {
    const done = run({ state: "succeeded", steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { state: "succeeded", stepStatus: "done" }), step(2, { state: "succeeded", stepStatus: "done" })] });
    expect(maxStepFrom(done)).toBe(2);
    expect(stepBandActions(done, "page-2").map((action) => action.fromStep)).toEqual([2, 0]);
  });

  it("すべて済んでいるサブページでは「この手順を作り直す」が主ボタン", () => {
    const done = run({ state: "succeeded", steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { state: "succeeded", stepStatus: "done" })] });
    expect(stepBandActions(done, "page-1")).toEqual([
      { id: "redo-here", label: "この手順を作り直す", tone: "primary", fromStep: 1 },
      { id: "restart", label: "はじめから作り直す", tone: "outline", fromStep: 0 },
    ]);
  });

  it("サイドバーへ渡す行と、終わったときの通知の一言", () => {
    const view = run({ steps: [step(0, { state: "succeeded", stepStatus: "done" }), step(1, { stepStatus: null })] });
    expect(stepPagesOf(view)).toEqual([
      { id: "page-0", title: "文字起こし修正", stepStatus: "done" },
      { id: "page-1", title: "記事方針", stepStatus: null },
    ]);
    expect(stepDoneMessage(DEFAULTS, run({ state: "succeeded" }))).toBe("記事制作の手順が終わりました。");
    expect(stepDoneMessage(DEFAULTS, run({ state: "failed", steps: [step(0, { state: "failed" })] }))).toBe("記事制作の手順が「文字起こし修正」で失敗しました。");
    expect(stepDoneMessage(DEFAULTS, run({ state: "running" }))).toBeNull();
    expect(stepDoneMessage(DEFAULTS, run({ state: "canceled" }))).toBeNull();
    // 名前を変えた手順は、通知の文もその名前で
    expect(stepDoneMessage([{ id: "tpl-1", name: "記事（長め）", defaultName: "記事制作" }], run({ state: "succeeded" }))).toBe("記事（長め）の手順が終わりました。");
  });
});
