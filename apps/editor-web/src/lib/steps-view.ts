/**
 * 流れ（#309）の run の見た目を、サーバーの run（./steps-client.ts）から組む純粋な部分。通信・React は持たない。
 * 段階の状態（済み・作成中・待機・失敗・前提変更）と、その状態で run にできること（やめる・やり直す・設定を見る）を決める。
 *
 * 状態の正はサーバー（step_attempts の state と出力のタブの step_status）で、ここでは測り直さない。
 * 段階の名前も run が持ってくる値をそのまま使う（設定で手順を変えてもそれに従う）。
 */

import { staleNoticeText } from "@niho/docs-core";
import type { StepRecipeChoice, StepRun, StepRunStep } from "./steps-client";

export type StepViewState = "done" | "run" | "wait" | "failed" | "stale";

/** 手順の名前（一覧に無い id は id のまま出す。設定から消えた手順の run でも出る）。 */
export function stepRecipeName(recipes: readonly StepRecipeChoice[], recipeId: string): string {
  return recipes.find((recipe) => recipe.id === recipeId)?.name ?? recipeId;
}

/** まだ動いているか（これが true の間だけ状態を読み直す）。 */
export function isStepRunActive(run: StepRun | null): boolean {
  return run !== null && (run.state === "queued" || run.state === "running");
}

/**
 * 1 つの段階の状態。実行中・失敗が先で、そのあとに前提変更（出力のタブは出来ているが、上流が変わった）。
 * 出力のタブを削除すると `stepStatus` が null になる。結果が無いので「前提変更」と同じ扱いにする。
 */
export function stepStateOf(step: StepRunStep): StepViewState {
  if (step.state === "running" || isBetweenChunks(step)) return "run";
  if (step.state === "failed") return "failed";
  const done = step.state === "succeeded" || step.state === "reused";
  if (step.stepStatus === "stale" || (done && step.stepStatus === null)) return "stale";
  if (done) return "done";
  return "wait";
}

/** 区切りの合間（終えた区切りがあり、次の区切りを待っている）。作成中として出す（#277）。 */
function isBetweenChunks(step: StepRunStep): boolean {
  return step.state === "queued" && step.chunk !== undefined && step.chunk.index > 0;
}

/**
 * 区切って処理している段階の一言（#277）。作成中は「作成中 3/5」（分子は今処理中の区切りの番号）、
 * 失敗は「区切り 3 で失敗」。区切っていない段階・済みの段階では null。
 */
export function stepChunkNotice(step: StepRunStep): string | null {
  if (!step.chunk) return null;
  const current = step.chunk.index + 1;
  if (step.state === "failed") return `区切り ${current} で失敗`;
  if (step.state === "running" || isBetweenChunks(step)) return `作成中 ${current}/${step.chunk.count}`;
  return null;
}

/**
 * 資料を上限で切って作った段階の一言（#277。黙って欠けさせない）。N は実際に使った字数（code point）。
 * 切っていない段階・古い run（字数を持たない）では null。
 */
export function stepInputCutNotice(step: StepRunStep): string | null {
  if (step.inputUsedChars === undefined) return null;
  return `入力が長いので先頭 ${step.inputUsedChars.toLocaleString("en-US")} 字だけ使いました`;
}

/**
 * 失敗したときに画面へ出すこと。**code は画面に出さない**（内部の名前なので、利用者が次に何をすればいいかの言葉にする）。
 *
 * - `retryable`: 少し待てば直る見込み（サーバーの自動の再試行でも直る種類）。文は「少し待ってもう一度」。
 * - `rerun`: やり直しのボタンを出すか。**利用者には直せないもの・待つしかないものでは出さない**
 *   （AI が設定されていない・鍵が使えない・今月の上限に達した）。押しても同じ結果になるボタンを出さない。
 * - `settings`: 設定のどこへ案内するか（`usage` は今月の使用量、`steps` は手順の指示とお手本）。
 *
 * 知らない code は `UNKNOWN_FAILURE`（待てば直るものとして扱い、やり直せる）。code が増えても壊れないよう、
 * 画面は個々の code ではなくこの 3 つの印だけを見る。
 */
export type StepFailure = {
  retryable: boolean;
  rerun: boolean;
  settings: "usage" | "steps" | null;
  message: string;
};

const RETRY = (message: string): StepFailure => ({ retryable: true, rerun: true, settings: null, message });
const FIX = (message: string, settings: StepFailure["settings"] = null): StepFailure => ({ retryable: false, rerun: true, settings, message });
/** 利用者には直せない・待つしかない（やり直しのボタンを出さない）。 */
const WAIT = (message: string, settings: StepFailure["settings"] = null): StepFailure => ({ retryable: false, rerun: false, settings, message });

const LATER = "少し待ってもう一度お試しください。";

const FAILURES: Readonly<Record<string, StepFailure>> = {
  // AI の設定・使用量（本物の実行器。#38・T5）
  ai_unavailable: WAIT("AI がまだ設定されていないので、この段階を作れません。設定が済むまでお待ちください。"),
  ai_auth: WAIT("AI の鍵が使えませんでした。設定が直るまでこの段階を作れません。"),
  quota_exceeded: WAIT("今月の AI の使用量が上限に達しました。来月まで手順を実行できません。", "usage"),
  invalid_output: FIX("AI の答えを本文にできませんでした。手順の指示やお手本を見直すと直ることがあります。", "steps"),
  ai_bad_request: FIX("AI がこの指示を受け付けませんでした。手順の指示やお手本を短くすると直ることがあります。", "steps"),
  // 続きを使い切っても終わらなかった（T5 の続きは 8 回まで）。もう一度頼んでも同じ長さで切れるので、待っても直らない
  output_too_long: FIX("長すぎて書き切れませんでした。この段階の指示で扱う範囲を分けて頼むと通ることがあります。", "steps"),
  step_time_limit: FIX("安全に保存できる時間を超えたため途中で止めました。書けた部分を確認して、段階を分けてもう一度お試しください。", "steps"),
  usage_unavailable: RETRY(`使用量を数えられませんでした。${LATER}`),
  ai_rate_limit: RETRY(`AI への問い合わせが混み合っています。${LATER}`),
  ai_overloaded: RETRY(`AI が混み合っています。${LATER}`),
  ai_server: RETRY(`AI の側で失敗しました。${LATER}`),
  ai_timeout: RETRY(`AI の答えを待てる時間を過ぎました。${LATER}`),
  ai_network: RETRY(`AI に届きませんでした。${LATER}`),
  // 手順・入力・実行の枠組み
  unknown_recipe: FIX("この手順の定義が見つかりませんでした。設定の「手順」を確かめてください。", "steps"),
  invalid_snapshot: WAIT("保存された手順の記録を読めませんでした。サポートにご連絡ください。"),
  unknown_step: FIX("手順の段階が変わりました。はじめから作り直してください。", "steps"),
  input_missing: FIX("もとになる本文が空でした。前の段階のページを書いてからやり直してください。"),
  invalid_input: FIX("もとになる本文を読めませんでした。前の段階のページを確かめてください。"),
  page_missing: FIX("結果を書くページが見つかりませんでした。はじめから作り直してください。"),
  // 長い入力を区切って処理する段階（#277）
  input_too_long: FIX("入力が長すぎて区切りきれませんでした（60 区切りまで）。録音を分けてから作り直してください。"),
  input_changed: FIX("入力が変わったので止めました。この段階を最初から作り直してください。"),
  lease_expired: RETRY(`時間がかかりすぎて止まりました。${LATER}`),
  aborted: RETRY(`途中で止まりました。${LATER}`),
  internal: RETRY(`思わぬ失敗で止まりました。${LATER}`),
};

/** 知らない code・code の無い失敗の既定（待てば直るものとして扱う）。 */
export const UNKNOWN_FAILURE: StepFailure = RETRY(`この段階を作れませんでした。${LATER}`);

/** その code の扱い（知らない code は既定）。 */
export function stepFailure(errorCode: string | null): StepFailure {
  if (errorCode === null) return UNKNOWN_FAILURE;
  return FAILURES[errorCode] ?? UNKNOWN_FAILURE;
}

const quoted = (name: string) => `「${name}」`;

/**
 * 流れの下の一言。いま何が起きているか、何ができるかを 1 文で。変わると読み上げる（PageFlow の role="status"）。
 * 「画面を閉じても進みます」は受入の約束（閉じても実行は続く）を利用者に伝える一言。
 */
export function stepBandNote(run: StepRun): string {
  const running = run.steps.find((step) => step.state === "running" || isBetweenChunks(step));
  const failed = run.steps.find((step) => step.state === "failed");
  const stale = run.steps.find((step) => stepStateOf(step) === "stale");
  if (run.state === "queued" || run.state === "running") {
    if (running) {
      const progress = running.chunk ? `（区切り ${running.chunk.index + 1}/${running.chunk.count}）` : "";
      return `${quoted(running.name)}を作成中です${progress}。画面を閉じても進みます。`;
    }
    return "順番を待っています。画面を閉じても進みます。";
  }
  if (run.state === "canceled") return "手順を取消しました。もう一度始められます。";
  if (run.state === "failed" && failed) {
    // 何が起きたかと、次にできることは、code ごとの文が持つ（code そのものは出さない）
    const where = failed.chunk ? `区切り ${failed.chunk.index + 1} で` : "";
    return `${quoted(failed.name)}が${where}失敗しました。${stepFailure(failed.errorCode).message}`;
  }
  if (stale) return `${staleNoticeText(stale.staleReasons ?? []) ?? "元にした内容が変わりました。"}${quoted(stale.name)}のタブを作り直すと印が消えます。`;
  if (run.state === "succeeded") return "すべての段階が済みました。";
  return "";
}

/**
 * 流れの下のボタン。`regenerate` を持つものはそのタブ（失敗した段階の出力）を同じ入力で作り直す、`cancel` は取消、
 * `settings` は設定の画面への案内、`resume` は失敗した区切りからのやり直し（同じ run。#277）。
 */
export type StepRunAction = {
  id: string;
  label: string;
  tone: "primary" | "outline" | "quiet";
  regenerate?: string;
  cancel?: boolean;
  settings?: "usage" | "steps";
  resume?: boolean;
};

/** 区切りの続きからやり直せない失敗（入力が変わった・長すぎる）。最初から作り直すしかない。 */
const NOT_RESUMABLE = new Set(["input_changed", "input_too_long"]);

/** 失敗した区切りからのやり直し（区切って処理していた段階の失敗だけ）。 */
function resumeAction(step: StepRunStep | undefined, tone: "primary" | "outline"): StepRunAction | null {
  if (!step || step.state !== "failed" || !step.chunk || (step.errorCode !== null && NOT_RESUMABLE.has(step.errorCode))) return null;
  return { id: "resume", label: `区切り ${step.chunk.index + 1} からやり直す`, tone, resume: true };
}

/** 設定の画面への案内（使用量・手順）。移るのは画面の側（../components/FlowWatcher.tsx）。 */
function settingsAction(settings: "usage" | "steps", tone: "primary" | "quiet"): StepRunAction {
  return settings === "usage"
    ? { id: "usage", label: "使用量を見る", tone, settings }
    : { id: "steps", label: "手順を見る", tone, settings };
}

/**
 * その状態で run にできること。動いている間は「やめる」だけ。失敗していれば、失敗した段階の出力のタブを同じ入力で
 * 作り直す（`regenerate`）。区切りの途中で失敗した段階は、続きからのやり直しを主にし、作り直しは「最初から」と言う。
 *
 * やり直しても同じ結果になる失敗（`stepFailure(...).rerun` が false。AI が設定されていない・鍵が使えない・
 * 今月の上限に達した）では、**やり直しのボタンを出さない**。代わりに設定への案内だけを出す。
 * 前提変更・済みの段階の作り直しは、流れの行の「作成」とタブの ▾「作り直す」が持つ（ここでは出さない）。
 */
export function stepRunActions(run: StepRun): StepRunAction[] {
  if (isStepRunActive(run)) return [{ id: "cancel", label: "やめる", tone: "quiet", cancel: true }];
  const failed = run.steps.find((step) => step.state === "failed");
  if (!failed) return [];
  const actions: StepRunAction[] = [];
  const failure = stepFailure(failed.errorCode);
  if (!failure.rerun) {
    if (failure.settings) actions.push(settingsAction(failure.settings, "primary"));
    // 今月の上限など待つしかない失敗でも、区切りの途中なら、直ったあとに続きから再開できる
    const resume = resumeAction(failed, failure.settings ? "outline" : "primary");
    if (resume) actions.push(resume);
    return actions;
  }
  const resume = resumeAction(failed, "primary");
  if (resume) actions.push(resume);
  const chunked = failed.chunk !== undefined;
  actions.push({
    id: "retry",
    label: chunked ? `${quoted(failed.name)}を最初から作り直す` : `${quoted(failed.name)}を作り直す`,
    tone: resume ? "outline" : "primary",
    regenerate: failed.pageId,
  });
  if (failure.settings) actions.push(settingsAction(failure.settings, "quiet"));
  return actions;
}

/** 終わったときの通知の一言（画面を閉じていた人に出す。本文は入れない）。 */
export function stepDoneMessage(recipes: readonly StepRecipeChoice[], run: StepRun): string | null {
  const name = run.recipeName ?? stepRecipeName(recipes, run.recipe);
  if (run.state === "succeeded") return `${name}の手順が終わりました。`;
  if (run.state === "failed") {
    const failed = run.steps.find((step) => step.state === "failed");
    return `${name}の手順が${failed ? quoted(failed.name) + "で" : ""}失敗しました。`;
  }
  return null;
}
