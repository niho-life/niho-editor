import { DEFAULT_LEASE_SECONDS, computeStepBasis, isStepErrorCode, type AttemptRef } from "@niho/editor-store";
import { parseBlocks } from "../server/page-input";
import { StepError, type StepExecutor } from "./executor";
import { taskName, type TaskQueue } from "./queue";
import type { RecipeReader } from "./recipes";
import type { StepRunStore } from "./store";

export type RunnerDeps = {
  store: Pick<StepRunStore, "claimAttempt" | "heartbeatAttempt" | "readStepInput" | "commitAttempt" | "failAttempt">;
  /** Older callers may pass a reader; execution deliberately never calls it. */
  recipes?: RecipeReader;
  executor: StepExecutor;
  queue: TaskQueue;
  /** lease の長さ（秒）。生存確認はその 1/3 おき。 */
  leaseSeconds?: number;
  /** tries 回目の失敗の後、積み直すまでの秒数。 */
  retryDelaySeconds?: (tries: number) => number;
};

export type AttemptOutcome = {
  /**
   * `completed`: 確定した（`next` があれば次を積んだ）。`retry`: 失敗して積み直した。`failed`: 失敗で終わった。
   * `stale`: 世代が古くなっていた（取消・掃除の後。何も書いていない）。`skipped`: claim できなかった（重複した task など）。
   */
  status: "completed" | "retry" | "failed" | "stale" | "skipped";
  next?: number;
};

/** 再試行の間隔（指数的に空ける: 10 秒・20 秒…）。 */
export function defaultRetryDelaySeconds(tries: number): number {
  return 10 * 2 ** Math.max(0, tries - 1);
}

function asStepError(error: unknown): StepError {
  if (error instanceof StepError && isStepErrorCode(error.code)) return error;
  // 想定外の例外は一時的な失敗として扱う（code は固定。例外の本文は記録しない）
  return new StepError("internal", true);
}

async function recordFailure(deps: RunnerDeps, ref: AttemptRef, error: StepError): Promise<AttemptOutcome> {
  const result = await deps.store.failAttempt({ ...ref, code: error.code, retryable: error.retryable, partial: error.partial });
  if (!result.ok) return { status: "stale" };
  if (result.outcome === "failed") return { status: "failed" };
  await deps.queue.enqueue({
    name: taskName(ref.runId, ref.stepIndex, result.generation),
    runId: ref.runId,
    stepIndex: ref.stepIndex,
    delaySeconds: (deps.retryDelaySeconds ?? defaultRetryDelaySeconds)(result.tries),
  });
  return { status: "retry" };
}

/** lease の 1/3 おきに生存確認する。世代が変わっていたら（取消・掃除）実行を止める。 */
function startHeartbeat(deps: RunnerDeps, ref: AttemptRef, leaseSeconds: number, controller: AbortController): () => void {
  const timer = setInterval(() => {
    deps.store.heartbeatAttempt(ref, { leaseSeconds }).then(
      (alive) => {
        if (!alive) controller.abort();
      },
      // 一時的な DB の失敗は次の回で確かめる（lease が切れれば掃除が拾う）
      () => undefined,
    );
  }, (leaseSeconds * 1000) / 3);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * 段階を 1 回実行する: claim → 入力を読む → 生存確認のタイマー → 実行器 → 確定 → 次の段階を積む。
 * 確定・失敗とも claim で得た世代で fence する（遅れて返った結果で上書きしない）。ログに本文・秘密を出さない。
 */
export async function runAttempt(deps: RunnerDeps, task: { runId: string; stepIndex: number }): Promise<AttemptOutcome> {
  const leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const claimed = await deps.store.claimAttempt(task.runId, task.stepIndex, { leaseSeconds });
  if (!claimed.ok) return { status: "skipped" };
  const { claim } = claimed;
  const ref: AttemptRef = { runId: claim.runId, stepIndex: claim.stepIndex, generation: claim.generation };

  const recipe = claim.recipeSnapshot;
  const step = recipe?.steps[claim.stepIndex];
  if (!recipe || recipe.id !== claim.recipe || !step || step.id !== claim.stepId) {
    return recordFailure(deps, ref, new StepError("invalid_snapshot", false));
  }
  const input = await deps.store.readStepInput(claim);
  if (!input) return recordFailure(deps, ref, new StepError("input_missing", false));

  const controller = new AbortController();
  const stopHeartbeat = startHeartbeat(deps, ref, leaseSeconds, controller);
  try {
    let blocks;
    let inputUsedChars: number | undefined;
    try {
      const output = await deps.executor.run({
        recipe,
        stepIndex: claim.stepIndex,
        owner: claim.owner,
        parentPageId: claim.parentId,
        parentBlocks: input.parentBlocks,
        backgroundBlocks: input.backgroundBlocks,
        previousBlocks: input.previousBlocks,
        materials: input,
        signal: controller.signal,
      });
      blocks = parseBlocks(output.blocks);
      inputUsedChars = output.inputUsedChars;
    } catch (error) {
      return await recordFailure(deps, ref, asStepError(error));
    }
    if (!blocks.ok) return await recordFailure(deps, ref, new StepError("invalid_output", false));

    // 基準は実行器に渡した入力から作る（実行中に上流が直されていれば、あとの再計算で前提変更になる）
    const committed = await deps.store.commitAttempt({
      ...ref,
      blocks: blocks.value,
      inputBasis: computeStepBasis(recipe, claim.stepIndex, input),
      ...(inputUsedChars === undefined ? {} : { inputUsedChars }),
    });
    if (!committed.ok) {
      return committed.reason === "page_missing" ? await recordFailure(deps, ref, new StepError("page_missing", false)) : { status: "stale" };
    }
    if (committed.next === null) return { status: "completed" };
    // 次の段階はこの run でまだ一度も claim されていない（世代 0）
    await deps.queue.enqueue({ name: taskName(ref.runId, committed.next, 0), runId: ref.runId, stepIndex: committed.next });
    return { status: "completed", next: committed.next };
  } finally {
    stopHeartbeat();
  }
}
