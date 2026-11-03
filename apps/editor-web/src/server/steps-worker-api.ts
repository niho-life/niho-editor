import { isPageId, type AttemptRef } from "@niho/editor-store";
import type { CloudTasksConfig } from "../steps/cloud-tasks";
import type { StepExecutor } from "../steps/executor";
import { taskName, type TaskQueue } from "../steps/queue";
import { runAttempt, type RunnerDeps } from "../steps/runner";
import type { StepSweepStore } from "../steps/store";
import type { OidcVerifyResult } from "./google-oidc";
import { errorResponse, guarded, jsonResponse, notFoundResponse, readJsonBody } from "./http";

/**
 * 手順の worker の route（#37。`/api/internal/steps/run`・`/api/internal/steps/sweep`）。Cloud Tasks と Cloud Scheduler だけが呼ぶ。
 * サービスは誰でも呼べる設定なので、Google の ID トークン（OIDC）をここで検証する。順は
 * 方式（cloud-tasks でなければ 404）→ トークン（無い・通らないなら本文を読まずに 401）→ Origin つき（ブラウザ）なら 403 → DB → 本文。
 * 応答の本文は短い code だけ。ログにもトークン・本文・クレームの値を出さない。
 */
export type StepsWorkerDeps = {
  /** cloud-tasks の設定。方式が cloud-tasks でない・設定が揃わないときは null（404）。 */
  config: () => CloudTasksConfig | null;
  /** ID トークンの検証（route では verifyGoogleOidc）。 */
  verify: (token: string, expected: { audience: string; allowedEmail: string }) => Promise<OidcVerifyResult>;
  /** DB が使えないときは null（503。Cloud Tasks が再試行する）。 */
  steps: () => (RunnerDeps["store"] & StepSweepStore) | null;
  /** 次の段階・再試行・掃除の積み込み先。 */
  queue: (config: CloudTasksConfig) => TaskQueue;
  /** 段階の実行器（今は偽物。本物への差し替えは steps-deps.ts の 1 か所）。 */
  executor: () => StepExecutor;
};

const RUN_ROUTE = "POST /api/internal/steps/run";
const SWEEP_ROUTE = "POST /api/internal/steps/sweep";
/** run の本文の上限（`{ runId, stepIndex }` だけ）。 */
export const RUN_BODY_LIMIT = 1024;
/** 1 回の読み込みで拾う数（期限切れ・queued それぞれ）。 */
export const SWEEP_LIMIT = 100;
/** queued を続きから読む回数の上限（1 回の掃除で SWEEP_LIMIT × この数まで。attempt の期限 300 秒に収める）。届かない分は警告に出す。 */
export const SWEEP_MAX_PAGES = 10;
const MAX_STEP_INDEX = 2_147_483_647;
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9._-]{1,8192})$/i;

type Gate = { ok: true; config: CloudTasksConfig } | { ok: false; response: Response };

function refuse(route: string, code: string): Gate {
  // 理由は code だけをログに書き、応答には出さない
  console.warn("editor-web: worker request refused", { route, code });
  return { ok: false, response: errorResponse("unauthorized") };
}

/** 方式・トークン・Origin の検査。ここまでは本文を読まない。 */
async function gate(request: Request, deps: StepsWorkerDeps, route: string): Promise<Gate> {
  const config = deps.config();
  if (!config) return { ok: false, response: notFoundResponse() };
  const header = request.headers.get("authorization");
  const token = header ? BEARER_PATTERN.exec(header)?.[1] : undefined;
  if (!token) return refuse(route, "missing_token");
  const verified = await deps.verify(token, { audience: config.workerUrl, allowedEmail: config.invokerServiceAccount });
  if (!verified.ok) return refuse(route, verified.code);
  // サーバー同士の呼び出しには Origin が無い。付いていればブラウザからの要求なので受けない（CSRF の経路を作らない）
  if (request.headers.get("origin") !== null) return { ok: false, response: errorResponse("forbidden") };
  return { ok: true, config };
}

/** `{ runId, stepIndex }` だけを受ける（他の key・UUID でない runId・負や小数の stepIndex は null）。 */
function parseTask(body: unknown): { runId: string; stepIndex: number } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (!Object.keys(record).every((key) => key === "runId" || key === "stepIndex")) return null;
  const { runId, stepIndex } = record;
  if (typeof runId !== "string" || !isPageId(runId)) return null;
  if (typeof stepIndex !== "number" || !Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > MAX_STEP_INDEX) return null;
  return { runId, stepIndex };
}

/**
 * POST /api/internal/steps/run — Cloud Tasks の task で段階を 1 回実行する。
 * 結果（completed・retry・failed・stale・skipped）はどれも 200（retry は runner が自分で積み直しているので、Cloud Tasks には再試行させない）。
 * 例外（DB の障害など）は 500 で、Cloud Tasks が同じ task を再試行する。
 */
export function runStepTask(request: Request, deps: StepsWorkerDeps): Promise<Response> {
  return guarded(RUN_ROUTE, async () => {
    const checked = await gate(request, deps, RUN_ROUTE);
    if (!checked.ok) return checked.response;
    const steps = deps.steps();
    if (!steps) return errorResponse("unavailable");
    const body = await readJsonBody(request, RUN_BODY_LIMIT);
    if (!body.ok) return body.response;
    const task = parseTask(body.value);
    if (!task) return errorResponse("bad_request");
    const outcome = await runAttempt({ store: steps, executor: deps.executor(), queue: deps.queue(checked.config) }, task);
    return jsonResponse(200, { status: outcome.status });
  });
}

/** queued の attempt を、古い順に続きから読んで全て（SWEEP_MAX_PAGES まで）。古い分が queued のまま残っても、後ろの分に届く。 */
async function listAllQueued(steps: StepSweepStore): Promise<AttemptRef[]> {
  const all: AttemptRef[] = [];
  let after: Pick<AttemptRef, "runId" | "stepIndex"> | undefined;
  for (let page = 0; page < SWEEP_MAX_PAGES; page += 1) {
    const batch = await steps.listQueuedAttempts(after ? { limit: SWEEP_LIMIT, after } : { limit: SWEEP_LIMIT });
    all.push(...batch);
    const last = batch[batch.length - 1];
    if (batch.length < SWEEP_LIMIT || !last) return all;
    after = { runId: last.runId, stepIndex: last.stepIndex };
  }
  console.warn("editor-web: sweep read only the oldest queued steps", { route: SWEEP_ROUTE, read: all.length });
  return all;
}

/**
 * POST /api/internal/steps/sweep — Cloud Scheduler が 5 分おきに呼ぶ掃除。本文は読まない。
 * (a) lease の切れた実行中の段階を queued に戻し（sweepExpiredLeases）、その世代で積み直す。claim のときに世代が進んでいるので、
 *     落ちた task の名前（claim の前の世代）とは別の名前になる。
 * (b) 進行中の run の queued の段階を古い順に続きから読み（1 回の掃除で SWEEP_LIMIT × SWEEP_MAX_PAGES まで）、
 *     **積む前に世代を 1 つ進めて**（requeueAttempt）積み直す。一度も claim されていない段階は世代が動いていないので、
 *     そのまま積むと最初に積んだ task と同じ名前になる。**Cloud Tasks は消した task の名前を最大 24 時間使わせない**ため、
 *     再試行を使い切って task が消えた段階は ALREADY_EXISTS（＝積み済み）と読まれ、その間だまって止まってしまう。
 *     世代を進められなかったもの（その間に claim された・取り消された）は積まない。
 * 応答は新しく積んだ数。積み込みに失敗したものがあれば、残りを積んだうえで 500（次の回でまた拾う。世代は進んだままなので、
 * 次も新しい名前で積める）。
 */
export function sweepStepTasks(request: Request, deps: StepsWorkerDeps): Promise<Response> {
  return guarded(SWEEP_ROUTE, async () => {
    const checked = await gate(request, deps, SWEEP_ROUTE);
    if (!checked.ok) return checked.response;
    const steps = deps.steps();
    if (!steps) return errorResponse("unavailable");
    const queue = deps.queue(checked.config);
    const expired = await steps.sweepExpiredLeases({ limit: SWEEP_LIMIT });
    const queued = await listAllQueued(steps);
    let requeued = 0;
    let failed = 0;
    let failure: string | undefined;
    const enqueue = async (ref: AttemptRef): Promise<void> => {
      try {
        const result = await queue.enqueue({ name: taskName(ref.runId, ref.stepIndex, ref.generation), runId: ref.runId, stepIndex: ref.stepIndex });
        if (!result.deduplicated) requeued += 1;
      } catch (error) {
        failed += 1;
        failure ??= typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "unknown";
      }
    };
    // (a) 名前（世代を含む）で 1 つにする
    const fromLeases = new Map<string, AttemptRef>();
    for (const ref of expired) fromLeases.set(taskName(ref.runId, ref.stepIndex, ref.generation), ref);
    for (const ref of fromLeases.values()) await enqueue(ref);
    // (b) (a) で戻したものは listQueuedAttempts にも出る（同じ世代）。そちらで積んだものは飛ばす
    for (const ref of queued) {
      if (fromLeases.has(taskName(ref.runId, ref.stepIndex, ref.generation))) continue;
      const generation = await steps.requeueAttempt(ref);
      if (generation === null) continue;
      await enqueue({ ...ref, generation });
    }
    if (failed > 0) {
      console.error("editor-web: sweep could not requeue every step", { route: SWEEP_ROUTE, requeued, failed, code: failure });
      return errorResponse("internal");
    }
    return jsonResponse(200, { requeued });
  });
}
