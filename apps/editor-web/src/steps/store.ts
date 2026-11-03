import {
  cancelRun,
  claimAttempt,
  commitAttempt,
  createRun,
  updateRunRecipeSnapshot,
  failAttempt,
  heartbeatAttempt,
  listQueuedAttempts,
  listRun,
  readPartialOutput,
  readStepInput,
  readStepStaleReasons,
  refreshStale,
  requeueAttempt,
  sweepExpiredLeases,
  type AttemptRef,
  type ClaimResult,
  type CommitInput,
  type CommitResult,
  type CreateRunInput,
  type CreateRunResult,
  type FailInput,
  type FailResult,
  type Block,
  type OwnerId,
  type StepClaim,
  type StepInput,
  type StepRecipe,
  type StepRunView,
  type StepStaleReason,
  type StepRunsDb,
} from "@niho/editor-store";

/**
 * 手順の層が使う store の操作。実体は packages/editor-store の step-runs.ts に Pool を渡したもの（`pgStepRunStore`）。
 * テストではメモリの実装（memory-store.ts）に差し替える。
 */
export type StepRunStore = {
  createRun(owner: OwnerId, parentId: string, input: CreateRunInput): Promise<CreateRunResult>;
  updateRunRecipeSnapshot(owner: OwnerId, parentId: string, runId: string, recipe: StepRecipe, expectedRevision: number): ReturnType<typeof updateRunRecipeSnapshot>;
  listRun(owner: OwnerId, parentId: string): Promise<{ run: StepRunView | null } | null>;
  readPartialOutput(owner: OwnerId, parentId: string, runId: string, stepIndex: number): Promise<Block[] | null>;
  cancelRun(owner: OwnerId, parentId: string, runId: string): Promise<StepRunView | null>;
  refreshStale(owner: OwnerId, parentId: string, recipe: StepRecipe): Promise<number>;
  readStaleReasons?(owner: OwnerId, parentId: string, recipe: StepRecipe): Promise<Record<number, StepStaleReason[]>>;
  claimAttempt(runId: string, stepIndex: number, options?: { leaseSeconds?: number }): Promise<ClaimResult>;
  heartbeatAttempt(ref: AttemptRef, options?: { leaseSeconds?: number }): Promise<boolean>;
  readStepInput(claim: StepClaim): Promise<StepInput | null>;
  commitAttempt(input: CommitInput): Promise<CommitResult>;
  failAttempt(input: FailInput): Promise<FailResult>;
};

export function pgStepRunStore(db: StepRunsDb): StepRunStore {
  return {
    createRun: (owner, parentId, input) => createRun(db, owner, parentId, input),
    updateRunRecipeSnapshot: (owner, parentId, runId, recipe, expectedRevision) => updateRunRecipeSnapshot(db, owner, parentId, runId, recipe, expectedRevision),
    listRun: (owner, parentId) => listRun(db, owner, parentId),
    readPartialOutput: (owner, parentId, runId, stepIndex) => readPartialOutput(db, owner, parentId, runId, stepIndex),
    cancelRun: (owner, parentId, runId) => cancelRun(db, owner, parentId, runId),
    refreshStale: (owner, parentId, recipe) => refreshStale(db, owner, parentId, recipe),
    readStaleReasons: (owner, parentId, recipe) => readStepStaleReasons(db, owner, parentId, recipe),
    claimAttempt: (runId, stepIndex, options) => claimAttempt(db, runId, stepIndex, options),
    heartbeatAttempt: (ref, options) => heartbeatAttempt(db, ref, options),
    readStepInput: (claim) => readStepInput(db, claim),
    commitAttempt: (input) => commitAttempt(db, input),
    failAttempt: (input) => failAttempt(db, input),
  };
}

/**
 * 定期の掃除（worker の sweep の route）が使う操作。期限切れの lease を queued に戻し、queued の一覧を読み、
 * 積み直す前に世代を進める。
 */
export type StepSweepStore = {
  sweepExpiredLeases(options?: { limit?: number }): Promise<AttemptRef[]>;
  listQueuedAttempts(options?: { limit?: number; after?: Pick<AttemptRef, "runId" | "stepIndex"> }): Promise<AttemptRef[]>;
  /** 積み直す前に世代を 1 つ進める（新しい世代。queued でなくなっていれば null）。 */
  requeueAttempt(ref: AttemptRef): Promise<number | null>;
};

export function pgStepSweepStore(db: StepRunsDb): StepSweepStore {
  return {
    sweepExpiredLeases: (options) => sweepExpiredLeases(db, options),
    listQueuedAttempts: (options) => listQueuedAttempts(db, options),
    requeueAttempt: (ref) => requeueAttempt(db, ref),
  };
}
