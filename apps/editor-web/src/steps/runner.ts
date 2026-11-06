import { DEFAULT_LEASE_SECONDS, computeChunkBasis, computeStepBasis, isStepErrorCode, stepBlocksText, type AttemptRef, type StepClaim, type StepInput } from "@niho/editor-store";
import { parseBlocks } from "../server/page-input";
import { chunkTail, planChunks } from "./chunks";
import { StepError, type StepChunkInput, type StepExecutor } from "./executor";
import { taskName, type TaskQueue } from "./queue";
import type { RecipeReader } from "./recipes";
import type { StepRunStore } from "./store";

export type RunnerDeps = {
  store: Pick<StepRunStore, "claimAttempt" | "heartbeatAttempt" | "readStepInput" | "commitAttempt" | "failAttempt" | "startChunks" | "commitChunk">;
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
   * `chunk`: 途中の区切りを確定して、同じ段階の次の区切りを積んだ（#277）。
   */
  status: "completed" | "retry" | "failed" | "stale" | "skipped" | "chunk";
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

type ChunkPrep =
  | { ok: true; chunk: StepChunkInput | null }
  | { ok: false; outcome: Promise<AttemptOutcome> | AttemptOutcome };

/**
 * 区切りの準備（#277）。段階が `chunked` で、書き直す対象（段階 0 は録音ページの本文、段階 1 以降は直前の段階の結果）が
 * 閾値を超えたときだけ区切る。最初の区切りの前に区切りの数と入力の基準を記録し、2 つ目からは今の入力の基準が
 * 記録と同じことを確かめる（違えば次の区切りの前に止める。非再試行の `input_changed`）。
 */
async function prepareChunk(deps: RunnerDeps, ref: AttemptRef, claim: StepClaim, recipe: NonNullable<StepClaim["recipeSnapshot"]>, input: StepInput): Promise<ChunkPrep> {
  const step = recipe.steps[claim.stepIndex];
  if (step?.chunked !== true) return { ok: true, chunk: null };
  const target = claim.stepIndex === 0 ? input.parentBlocks : (input.previousBlocks ?? []);
  const basis = computeChunkBasis(computeStepBasis(recipe, claim.stepIndex, input));
  const started = claim.chunk.count !== null;
  if (started && claim.chunk.basis !== basis) return { ok: false, outcome: recordFailure(deps, ref, new StepError("input_changed", false)) };
  const plan = planChunks(target);
  if (!plan.ok) return { ok: false, outcome: recordFailure(deps, ref, new StepError("input_too_long", false)) };
  if (!started) {
    if (plan.chunks === null) return { ok: true, chunk: null };
    if (!(await deps.store.startChunks({ ...ref, count: plan.chunks.length, basis }))) return { ok: false, outcome: { status: "stale" } };
  } else if (plan.chunks === null || plan.chunks.length !== claim.chunk.count || claim.chunk.blocks.length !== claim.chunk.index) {
    // 基準が同じなら区切りも同じになる（決定的）。合わないのは記録が壊れたときだけなので、作り直してもらう
    return { ok: false, outcome: recordFailure(deps, ref, new StepError("input_changed", false)) };
  }
  const chunks = plan.chunks;
  const index = started ? claim.chunk.index : 0;
  const previous = index > 0 ? claim.chunk.blocks[index - 1] : undefined;
  return { ok: true, chunk: { index, count: chunks.length, text: chunks[index]!, previousTail: previous ? chunkTail(stepBlocksText(previous)) : "" } };
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
  const prepared = await prepareChunk(deps, ref, claim, recipe, input);
  if (!prepared.ok) return prepared.outcome;
  const { chunk } = prepared;

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
        background: input.background,
        previousBlocks: input.previousBlocks,
        materials: input,
        signal: controller.signal,
        ...(chunk ? { chunk } : {}),
      });
      blocks = parseBlocks(output.blocks);
      // 区切ったときは、区切った対象を除くほかの資料が切られた字数（区切りが違っても同じ資料なので最後の区切りのものを使う）
      inputUsedChars = output.inputUsedChars;
    } catch (error) {
      return await recordFailure(deps, ref, asStepError(error));
    }
    if (!blocks.ok) return await recordFailure(deps, ref, new StepError("invalid_output", false));

    if (chunk && chunk.index + 1 < chunk.count) {
      // 途中の区切り: 出力を貯めて attempt を queued に戻し、同じ段階の次の区切りを積む（ページには書かない）
      const saved = await deps.store.commitChunk({ ...ref, chunkIndex: chunk.index, blocks: blocks.value });
      if (!saved.ok) return { status: "stale" };
      await deps.queue.enqueue({ name: taskName(ref.runId, ref.stepIndex, saved.generation), runId: ref.runId, stepIndex: ref.stepIndex });
      return { status: "chunk" };
    }
    if (chunk) {
      // 最後の区切り: 終えた区切りの出力と順につないで 1 版にする
      blocks = parseBlocks([...claim.chunk.blocks.flat(), ...blocks.value]);
      if (!blocks.ok) return await recordFailure(deps, ref, new StepError("invalid_output", false));
    }

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
