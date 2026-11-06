import {
  EditorStore,
  cancelRun,
  claimAttempt,
  commitAttempt,
  commitChunk,
  createRun,
  updateRunRecipeSnapshot,
  failAttempt,
  heartbeatAttempt,
  listQueuedAttempts,
  listRun,
  readFlow,
  readPartialOutput,
  readStepInput,
  readStepStaleReasons,
  readTabLocation,
  refreshStale,
  requeueAttempt,
  resumeRun,
  setFolderRecipe,
  startChunks,
  sweepExpiredLeases,
  type AttemptRef,
  type ClaimResult,
  type CommitChunkInput,
  type CommitChunkResult,
  type CommitInput,
  type CommitResult,
  type CreateRunInput,
  type CreateRunResult,
  type Database,
  type FailInput,
  type FailResult,
  type FlowView,
  type Block,
  type OwnerId,
  type ResumeRunResult,
  type StartChunksInput,
  type StepClaim,
  type StepInput,
  type StepRecipe,
  type StepRunView,
  type StepStaleReason,
  type TabLocation,
} from "@niho/editor-store";

/**
 * 手順の層が使う store の操作。実体は packages/editor-store の step-runs.ts に Pool を渡したもの（`pgStepRunStore`）。
 * テストではメモリの実装（memory-store.ts）に差し替える。
 *
 * #309: run の親は**フォルダ**。`createRun` は入力のタブ（`inputTab`）から段階 `toStep` まで、または作り直し（`regenerate`）・
 * 同じ入力でもう 1 つ（`sibling`）。流れ（`readFlow`）はフォルダの入れ物とタブ、`locateTab` は押されたタブの居場所、
 * `wrapInFolder` はフォルダの外の入れ物をその題名のフォルダに入れる。
 */
export type StepRunStore = {
  createRun(owner: OwnerId, folderId: string, input: CreateRunInput): Promise<CreateRunResult>;
  updateRunRecipeSnapshot(owner: OwnerId, folderId: string, runId: string, recipe: StepRecipe, expectedRevision: number): ReturnType<typeof updateRunRecipeSnapshot>;
  listRun(owner: OwnerId, folderId: string): Promise<{ run: StepRunView | null } | null>;
  readPartialOutput(owner: OwnerId, folderId: string, runId: string, stepIndex: number): Promise<Block[] | null>;
  cancelRun(owner: OwnerId, folderId: string, runId: string): Promise<StepRunView | null>;
  refreshStale(owner: OwnerId, folderId: string, recipe: StepRecipe): Promise<number>;
  readStaleReasons?(owner: OwnerId, folderId: string, recipe: StepRecipe): Promise<Record<number, StepStaleReason[]>>;
  claimAttempt(runId: string, stepIndex: number, options?: { leaseSeconds?: number }): Promise<ClaimResult>;
  heartbeatAttempt(ref: AttemptRef, options?: { leaseSeconds?: number }): Promise<boolean>;
  readStepInput(claim: StepClaim): Promise<StepInput | null>;
  commitAttempt(input: CommitInput): Promise<CommitResult>;
  failAttempt(input: FailInput): Promise<FailResult>;
  /** 区切りを始める（#277。最初の区切りの前に 1 回だけ。世代で fence）。 */
  startChunks(input: StartChunksInput): Promise<boolean>;
  /** 途中の区切りを確定して attempt を queued に戻す（#277。最後の区切りは commitAttempt）。 */
  commitChunk(input: CommitChunkInput): Promise<CommitChunkResult>;
  /** 失敗した run を失敗した区切りからやり直す（#277。入力が変わっていなければ）。 */
  resumeRun(owner: OwnerId, folderId: string, runId: string): Promise<ResumeRunResult>;
  /** フォルダの流れ（入れ物とタブ・録音で済んだ文字起こしのエンジン。#309）。フォルダでなければ null。 */
  readFlow(owner: OwnerId, folderId: string): Promise<FlowView | null>;
  /** タブ（本文のページ）の居場所。本人の生きている本文のページでなければ null。 */
  locateTab(owner: OwnerId, tabId: string): Promise<TabLocation | null>;
  /** フォルダの外の入れ物を、その題名のフォルダを作って入れる（#309）。入れたフォルダの id。できなければ null。 */
  wrapInFolder(owner: OwnerId, holderId: string): Promise<string | null>;
  /** フォルダの手順を替える（null で既定）。本人の生きているフォルダでなければ false。 */
  setFolderRecipe(owner: OwnerId, folderId: string, recipe: string | null): Promise<boolean>;
};

export function pgStepRunStore(db: Database): StepRunStore {
  const pages = new EditorStore(db);
  return {
    createRun: (owner, folderId, input) => createRun(db, owner, folderId, input),
    updateRunRecipeSnapshot: (owner, folderId, runId, recipe, expectedRevision) => updateRunRecipeSnapshot(db, owner, folderId, runId, recipe, expectedRevision),
    listRun: (owner, folderId) => listRun(db, owner, folderId),
    readPartialOutput: (owner, folderId, runId, stepIndex) => readPartialOutput(db, owner, folderId, runId, stepIndex),
    cancelRun: (owner, folderId, runId) => cancelRun(db, owner, folderId, runId),
    refreshStale: (owner, folderId, recipe) => refreshStale(db, owner, folderId, recipe),
    readStaleReasons: (owner, folderId, recipe) => readStepStaleReasons(db, owner, folderId, recipe),
    claimAttempt: (runId, stepIndex, options) => claimAttempt(db, runId, stepIndex, options),
    heartbeatAttempt: (ref, options) => heartbeatAttempt(db, ref, options),
    readStepInput: (claim) => readStepInput(db, claim),
    commitAttempt: (input) => commitAttempt(db, input),
    failAttempt: (input) => failAttempt(db, input),
    startChunks: (input) => startChunks(db, input),
    commitChunk: (input) => commitChunk(db, input),
    resumeRun: (owner, folderId, runId) => resumeRun(db, owner, folderId, runId),
    readFlow: (owner, folderId) => readFlow(db, owner, folderId),
    locateTab: (owner, tabId) => readTabLocation(db, owner, tabId),
    wrapInFolder: async (owner, holderId) => {
      const holder = await pages.getPage(owner, holderId);
      if (!holder || holder.kind !== "page" || holder.parent !== null) return null;
      const folder = await pages.createPage(owner, { kind: "folder", title: holder.title });
      const moved = await pages.movePage(owner, holderId, folder.id);
      return moved === "moved" ? folder.id : null;
    },
    setFolderRecipe: (owner, folderId, recipe) => setFolderRecipe(db, owner, folderId, recipe),
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

export function pgStepSweepStore(db: Database): StepSweepStore {
  return {
    sweepExpiredLeases: (options) => sweepExpiredLeases(db, options),
    listQueuedAttempts: (options) => listQueuedAttempts(db, options),
    requeueAttempt: (ref) => requeueAttempt(db, ref),
  };
}
