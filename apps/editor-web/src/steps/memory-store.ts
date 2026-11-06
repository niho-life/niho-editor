import { randomUUID } from "node:crypto";
import {
  DEFAULT_LEASE_SECONDS,
  MAX_TRIES,
  computeChunkBasis,
  computeStepBasis,
  parseStepBasis,
  stepStaleReasons,
  DEFAULT_EDITOR_SETTINGS,
  isPageId,
  stepPageIdForStep,
  type AttemptState,
  type Block,
  type PageKind,
  type RunState,
  type StepRunView,
  type StepStatus,
  type StepBasis,
  type StepStaleReason,
  type StepMaterials,
  type PageFields,
  type EditorSettings,
  snapshotOf,
  type RecipeSnapshot,
} from "@niho/editor-store";
import type { StepRunStore } from "./store";

type MemoryPage = {
  id: string;
  owner: string;
  kind: PageKind;
  title: string;
  blocks: Block[];
  parent: string | null;
  recipe: string | null;
  stepStatus: StepStatus | null;
  deleted: boolean;
};

type MemoryAttempt = {
  stepIndex: number;
  stepId: string;
  pageId: string;
  state: AttemptState;
  generation: number;
  tries: number;
  leaseUntil: number | null;
  errorCode: string | null;
  partialBlocks: Block[] | null;
  inputUsedChars: number | null;
  inputBasis: StepBasis | string | null;
  finishedAt: number | null;
  chunkCount: number | null;
  chunkIndex: number;
  chunkBlocks: Block[][];
  chunkBasis: string | null;
};

type MemoryRun = {
  id: string;
  owner: string;
  parent: string;
  recipe: string;
  recipeSnapshot: RecipeSnapshot;
  recipeRevision: number;
  fromStep: number;
  state: RunState;
  key: string | null;
  seq: number;
  attempts: MemoryAttempt[];
};

const ACTIVE: readonly RunState[] = ["queued", "running"];

/**
 * メモリの中の StepRunStore（テスト用。packages/editor-store の step-runs.ts と同じ約束の小さな写し）。
 * 1 つの呼び出しの中で await しないので、各操作はそのまま不可分になる。
 */
export class MemoryStepRunStore implements StepRunStore {
  readonly pages = new Map<string, MemoryPage>();
  readonly runs = new Map<string, MemoryRun>();
  readonly fields = new Map<string, PageFields>();
  readonly settings = new Map<string, EditorSettings>();
  #seq = 0;
  #clock = 0;

  /** 単調に進む時刻（finishedAt の並びに使う）。 */
  #now(): number {
    this.#clock = Math.max(this.#clock + 1, Date.now());
    return this.#clock;
  }

  addPage(owner: string, page: { kind?: PageKind; blocks?: Block[] } = {}): string {
    const id = randomUUID();
    this.pages.set(id, { id, owner, kind: page.kind ?? "note", title: "", blocks: page.blocks ?? [], parent: null, recipe: null, stepStatus: null, deleted: false });
    return id;
  }

  #page(owner: string, id: string | null): MemoryPage | null {
    if (id === null) return null;
    const page = this.pages.get(id);
    return page && page.owner === owner && !page.deleted ? page : null;
  }

  #setStatus(owner: string, pageId: string, status: StepStatus): void {
    const page = this.#page(owner, pageId);
    if (page) page.stepStatus = status;
  }

  #pageIds(owner: string, parentId: string, recipe: { id: string; steps: readonly { id: string }[] }, run?: MemoryRun): string[] {
    const latest = run ?? [...this.runs.values()]
      .filter((candidate) => candidate.owner === owner && candidate.parent === parentId && candidate.recipe === recipe.id)
      .sort((left, right) => right.seq - left.seq)[0];
    const prior = new Map((latest?.attempts ?? []).map((attempt) => [attempt.stepId, attempt.pageId] as const));
    return recipe.steps.map((step) => prior.get(step.id) ?? stepPageIdForStep(parentId, recipe.id, step.id));
  }

  #materials(owner: string, parentId: string, recipe: { id: string; steps: readonly { id: string }[] }, index: number, pageIds = this.#pageIds(owner, parentId, recipe), upstreamPageIds?: readonly { id: string; pageId: string }[]): StepMaterials | null {
    const parent = this.#page(owner, parentId);
    if (!parent) return null;
    const upstream = upstreamPageIds ?? recipe.steps.slice(0, index).map((step, prior) => ({ id: step.id, pageId: pageIds[prior]! }));
    return {
      parentBlocks: parent.blocks,
      // 背景・登場人物・固有名詞は録音ページ自身の欄（editor-store の readStepInput と同じ）
      background: this.fields.get(parentId)?.background ?? "",
      upstream: upstream.map((item) => ({ id: item.id, blocks: this.#page(owner, item.pageId)?.blocks ?? [] })),
      refs: [...this.pages.values()].filter((page) => page.owner === owner && !page.deleted && parent.parent !== null && page.parent === parent.parent && page.id !== parentId).map((page) => ({ id: page.id, blocks: page.blocks })),
      fields: { entities: this.fields.get(parentId)?.entities ?? [], terms: this.fields.get(parentId)?.terms ?? [] },
      settings: this.settings.get(owner) ?? DEFAULT_EDITOR_SETTINGS,
    };
  }

  #view(run: MemoryRun): StepRunView {
    return {
      id: run.id,
      recipe: run.recipe,
      recipeSnapshot: run.recipeSnapshot,
      recipeRevision: run.recipeRevision,
      state: run.state,
      fromStep: run.fromStep,
      steps: run.attempts.map((attempt) => ({
        index: attempt.stepIndex,
        stepId: attempt.stepId,
        state: attempt.state,
        pageId: attempt.pageId,
        stepStatus: this.#page(run.owner, attempt.pageId)?.stepStatus ?? null,
        tries: attempt.tries,
        errorCode: attempt.errorCode,
        ...(run.state === "failed" && attempt.state === "failed" && attempt.partialBlocks && attempt.partialBlocks.length > 0 && this.#page(run.owner, attempt.pageId)
          ? { hasPartialOutput: true }
          : {}),
        ...(attempt.state === "succeeded" && attempt.inputUsedChars !== null ? { inputUsedChars: attempt.inputUsedChars } : {}),
        ...((attempt.state === "queued" || attempt.state === "running" || attempt.state === "failed") && attempt.chunkCount !== null
          ? { chunk: { index: attempt.chunkIndex, count: attempt.chunkCount } }
          : {}),
      })),
    };
  }

  /** test 用: その段階に残った「書けたところまでの本文」（無ければ null）。 */
  partialOf(runId: string, stepIndex: number): Block[] | null {
    return this.#attempt(runId, stepIndex)?.attempt.partialBlocks ?? null;
  }

  readPartialOutput: StepRunStore["readPartialOutput"] = async (owner, parentId, runId, stepIndex) => {
    const run = this.runs.get(runId);
    const parent = this.#page(owner, parentId);
    if (!run || !parent || run.owner !== owner || run.parent !== parentId || run.state !== "failed") return null;
    const latest = [...this.runs.values()]
      .filter((candidate) => candidate.owner === owner && candidate.parent === parentId)
      .sort((left, right) => right.seq - left.seq)[0];
    if (latest?.id !== runId) return null;
    const attempt = run.attempts[stepIndex];
    if (!attempt || attempt.state !== "failed" || !attempt.partialBlocks || attempt.partialBlocks.length === 0) return null;
    if (!this.#page(owner, attempt.pageId)) return null;
    return [...attempt.partialBlocks];
  };

  #attempt(runId: string, stepIndex: number): { run: MemoryRun; attempt: MemoryAttempt } | null {
    const run = this.runs.get(runId);
    const attempt = run?.attempts[stepIndex];
    return run && attempt ? { run, attempt } : null;
  }

  #failRunFrom(run: MemoryRun, stepIndex: number): void {
    const now = this.#now();
    for (const later of run.attempts.slice(stepIndex + 1)) {
      if (later.state === "pending" || later.state === "queued") {
        later.state = "canceled";
        later.finishedAt = now;
        this.#setStatus(run.owner, later.pageId, "wait");
      }
    }
    run.state = "failed";
  }

  createRun: StepRunStore["createRun"] = async (owner, parentId, input) => {
    const { recipe } = input;
    const fromStep = input.fromStep ?? 0;
    if (!Number.isInteger(fromStep) || fromStep < 0) throw new RangeError("fromStep is out of range");
    if (!isPageId(parentId)) return { status: "not_found" };
    const parent = this.#page(owner, parentId);
    if (!parent || parent.kind !== "rec") return { status: "not_found" };
    const key = input.idempotencyKey ?? null;
    const replay = key === null ? undefined : [...this.runs.values()].find((run) => run.owner === owner && run.key === key);
    if (replay) return { status: "existing", run: this.#view(replay) };
    if ([...this.runs.values()].some((run) => run.owner === owner && run.parent === parentId && ACTIVE.includes(run.state))) {
      return { status: "run_in_progress" };
    }
    const prior = [...this.runs.values()].filter((run) => run.owner === owner && run.parent === parentId && run.recipe === recipe.id).sort((a, b) => b.seq - a.seq)[0];
    const recipeSnapshot = prior?.recipeSnapshot ?? snapshotOf({
      id: recipe.id, name: recipe.name ?? recipe.id, guide: recipe.guide ?? "",
      steps: recipe.steps.map((step) => ({ id: step.id, name: step.name, instruction: step.instruction, profile: step.profile ?? "standard", ...(step.chunked === true ? { chunked: true } : {}) })),
      terms: recipe.terms ?? [], samples: recipe.samples ?? [],
    });
    if (fromStep >= recipeSnapshot.steps.length) return { status: "invalid_from_step" };
    const previousPageByStep = new Map((prior?.attempts ?? []).map((attempt) => [attempt.stepId, attempt.pageId] as const));
    const pageIds = recipeSnapshot.steps.map((step) => previousPageByStep.get(step.id) ?? stepPageIdForStep(parentId, recipe.id, step.id));
    if (pageIds.slice(0, fromStep).some((id) => this.#page(owner, id)?.stepStatus !== "done")) return { status: "invalid_from_step" };
    for (const [index, step] of recipeSnapshot.steps.entries()) {
      if (index < fromStep) continue;
      const id = pageIds[index]!;
      const existing = this.pages.get(id);
      if (existing) {
        existing.deleted = false;
        existing.stepStatus = "wait";
      } else {
        this.pages.set(id, { id, owner, kind: "step", title: step.name, blocks: [], parent: parentId, recipe: recipe.id, stepStatus: "wait", deleted: false });
      }
    }
    const run: MemoryRun = {
      id: randomUUID(),
      owner,
      parent: parentId,
      recipe: recipe.id,
      recipeSnapshot,
      recipeRevision: prior?.recipeRevision ?? recipe.revision ?? 1,
      fromStep,
      state: "queued",
      key,
      seq: ++this.#seq,
      attempts: recipeSnapshot.steps.map((step, index) => ({
        stepIndex: index,
        stepId: step.id,
        pageId: pageIds[index]!,
        state: index < fromStep ? "reused" : index === fromStep ? "queued" : "pending",
        generation: 0,
        tries: 0,
        leaseUntil: null,
        errorCode: null,
        partialBlocks: null,
        inputUsedChars: null,
        inputBasis: null,
        finishedAt: index < fromStep ? this.#now() : null,
        chunkCount: null,
        chunkIndex: 0,
        chunkBlocks: [],
        chunkBasis: null,
      })),
    };
    this.runs.set(run.id, run);
    return { status: "created", run: this.#view(run) };
  };

  updateRunRecipeSnapshot: StepRunStore["updateRunRecipeSnapshot"] = async (owner, parentId, runId, recipe, expectedRevision) => {
    const latest = [...this.runs.values()].filter((run) => run.owner === owner && run.parent === parentId && run.recipe === recipe.id).sort((a, b) => b.seq - a.seq)[0];
    if (!latest || latest.id !== runId) return { status: "not_found" };
    if (ACTIVE.includes(latest.state) || latest.recipeRevision !== expectedRevision) return { status: "conflict" };
    latest.recipeSnapshot = snapshotOf({
      id: recipe.id, name: recipe.name ?? recipe.id, guide: recipe.guide ?? "",
      steps: recipe.steps.map((step) => ({ id: step.id, name: step.name, instruction: step.instruction, profile: step.profile ?? "standard", ...(step.chunked === true ? { chunked: true } : {}) })),
      terms: recipe.terms ?? [], samples: recipe.samples ?? [],
    });
    latest.recipeRevision = recipe.revision ?? 1;
    return { status: "updated", run: this.#view(latest) };
  };

  listRun: StepRunStore["listRun"] = async (owner, parentId) => {
    if (!isPageId(parentId) || !this.#page(owner, parentId)) return null;
    const latest = [...this.runs.values()].filter((run) => run.owner === owner && run.parent === parentId).sort((a, b) => b.seq - a.seq)[0];
    return { run: latest ? this.#view(latest) : null };
  };

  cancelRun: StepRunStore["cancelRun"] = async (owner, parentId, runId) => {
    const run = this.runs.get(runId);
    if (!run || run.owner !== owner || run.parent !== parentId) return null;
    if (ACTIVE.includes(run.state)) {
      run.state = "canceled";
      for (const attempt of run.attempts) {
        if (attempt.state === "queued" || attempt.state === "pending" || attempt.state === "running") {
          if (attempt.state === "running") attempt.generation += 1;
          attempt.state = "canceled";
          attempt.leaseUntil = null;
          attempt.finishedAt = this.#now();
          this.#setStatus(owner, attempt.pageId, "wait");
        }
      }
    }
    return this.#view(run);
  };

  refreshStale: StepRunStore["refreshStale"] = async (owner, parentId, recipe) => {
    const parent = isPageId(parentId) ? this.#page(owner, parentId) : null;
    if (!parent) return 0;
    const latest = [...this.runs.values()]
      .filter((run) => run.owner === owner && run.parent === parentId && run.recipe === recipe.id)
      .sort((a, b) => b.seq - a.seq)[0];
    const latestAttempts = [...(latest?.attempts ?? [])].sort((a, b) => a.stepIndex - b.stepIndex);
    const latestStepIds = latestAttempts.map((attempt) => attempt.stepId);
    const structuralMismatch = latestStepIds.length !== recipe.steps.length ||
      latestStepIds.some((stepId, index) => stepId !== recipe.steps[index]?.id);
    const pageIds = this.#pageIds(owner, parentId, recipe, latest);
    const recorded = new Map<string, { basis: StepBasis | string; at: number }>();
    for (const run of this.runs.values()) {
      if (run.owner !== owner || run.parent !== parentId || run.recipe !== recipe.id) continue;
      for (const attempt of run.attempts) {
        const previous = recorded.get(attempt.stepId);
        if (attempt.state === "succeeded" && attempt.inputBasis && (!previous || (attempt.finishedAt ?? 0) > previous.at)) {
          recorded.set(attempt.stepId, { basis: attempt.inputBasis, at: attempt.finishedAt ?? 0 });
        }
      }
    }
    let changed = 0;
    let upstreamFresh = true;
    for (const [index] of recipe.steps.entries()) {
      const page = this.#page(owner, pageIds[index]!);
      if (!page || (page.stepStatus !== "done" && page.stepStatus !== "stale")) {
        upstreamFresh = false;
        continue;
      }
      const upstreamPageIds = recipe.steps.slice(0, index).map((step, prior) => ({ id: step.id, pageId: pageIds[prior]! }));
      const materials = this.#materials(owner, parentId, recipe, index, pageIds, upstreamPageIds);
      const reasons = materials ? stepStaleReasons(parseStepBasis(recorded.get(recipe.steps[index]!.id)?.basis), computeStepBasis(recipe, index, materials)) : [];
      const fresh: boolean = !structuralMismatch && upstreamFresh && reasons.length === 0;
      upstreamFresh = fresh;
      const want: StepStatus = fresh ? "done" : "stale";
      if (page.stepStatus !== want) {
        page.stepStatus = want;
        changed += 1;
      }
    }
    return changed;
  };

  readStaleReasons: NonNullable<StepRunStore["readStaleReasons"]> = async (owner, parentId, recipe) => {
    const recorded = new Map<string, { basis: StepBasis | string; at: number }>();
    for (const run of this.runs.values()) {
      if (run.owner !== owner || run.parent !== parentId || run.recipe !== recipe.id) continue;
      for (const attempt of run.attempts) {
        const previous = recorded.get(attempt.stepId);
        if (attempt.state === "succeeded" && attempt.inputBasis && (!previous || (attempt.finishedAt ?? 0) > previous.at)) {
          recorded.set(attempt.stepId, { basis: attempt.inputBasis, at: attempt.finishedAt ?? 0 });
        }
      }
    }
    const result: Record<number, StepStaleReason[]> = {};
    const pageIds = this.#pageIds(owner, parentId, recipe);
    let inherited: StepStaleReason[] = [];
    for (const [index] of recipe.steps.entries()) {
      const upstreamPageIds = recipe.steps.slice(0, index).map((step, prior) => ({ id: step.id, pageId: pageIds[prior]! }));
      const materials = this.#materials(owner, parentId, recipe, index, pageIds, upstreamPageIds);
      const own = materials ? stepStaleReasons(parseStepBasis(recorded.get(recipe.steps[index]!.id)?.basis), computeStepBasis(recipe, index, materials)) : [];
      inherited = [...new Set([...inherited, ...own])];
      result[index] = inherited;
    }
    return result;
  };

  claimAttempt: StepRunStore["claimAttempt"] = async (runId, stepIndex, options = {}) => {
    const run = this.runs.get(runId);
    if (!run || !ACTIVE.includes(run.state)) return { ok: false, reason: "run_inactive" };
    const attempt = run.attempts[stepIndex];
    if (!attempt || attempt.state !== "queued") return { ok: false, reason: "not_queued" };
    const previous = stepIndex === 0 ? null : run.attempts[stepIndex - 1]!;
    if (previous && previous.state !== "succeeded" && previous.state !== "reused") return { ok: false, reason: "superseded" };
    attempt.state = "running";
    attempt.generation += 1;
    attempt.tries += 1;
    attempt.leaseUntil = Date.now() + (options.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000;
    attempt.errorCode = null;
    attempt.partialBlocks = null;
    attempt.inputUsedChars = null;
    run.state = "running";
    this.#setStatus(run.owner, attempt.pageId, "run");
    return {
      ok: true,
      claim: {
        runId,
        stepIndex,
        generation: attempt.generation,
        tries: attempt.tries,
        owner: run.owner,
        parentId: run.parent,
        recipe: run.recipe,
        recipeSnapshot: run.recipeSnapshot,
        stepId: attempt.stepId,
        pageId: attempt.pageId,
        previousPageId: previous?.pageId ?? null,
        upstreamPageIds: run.attempts.slice(0, stepIndex).map((prior) => ({ id: prior.stepId, pageId: prior.pageId })),
        chunk: { count: attempt.chunkCount, index: attempt.chunkIndex, basis: attempt.chunkBasis, blocks: attempt.chunkBlocks.map((blocks) => [...blocks]) },
      },
    };
  };

  heartbeatAttempt: StepRunStore["heartbeatAttempt"] = async (ref, options = {}) => {
    const found = this.#attempt(ref.runId, ref.stepIndex);
    if (!found || found.attempt.state !== "running" || found.attempt.generation !== ref.generation) return false;
    found.attempt.leaseUntil = Date.now() + (options.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000;
    return true;
  };

  readStepInput: StepRunStore["readStepInput"] = async (claim) => {
    if (!claim.recipeSnapshot) return null;
    const materials = this.#materials(claim.owner, claim.parentId, claim.recipeSnapshot, claim.stepIndex, undefined, claim.upstreamPageIds);
    if (!materials) return null;
    return { ...materials, previousBlocks: claim.previousPageId === null ? null : this.#page(claim.owner, claim.previousPageId)?.blocks ?? [] };
  };

  commitAttempt: StepRunStore["commitAttempt"] = async (input) => {
    const found = this.#attempt(input.runId, input.stepIndex);
    if (!found || found.run.state !== "running" || found.attempt.state !== "running" || found.attempt.generation !== input.generation) {
      return { ok: false, reason: "stale_generation" };
    }
    const { run, attempt } = found;
    const page = this.#page(run.owner, attempt.pageId);
    if (!page) return { ok: false, reason: "page_missing" };
    page.blocks = [...input.blocks];
    page.stepStatus = "done";
    attempt.state = "succeeded";
    attempt.inputBasis = input.inputBasis;
    attempt.inputUsedChars = input.inputUsedChars ?? null;
    attempt.leaseUntil = null;
    attempt.finishedAt = this.#now();
    const next = run.attempts[input.stepIndex + 1];
    if (next && next.state === "pending") {
      next.state = "queued";
      return { ok: true, next: next.stepIndex };
    }
    run.state = "succeeded";
    return { ok: true, next: null };
  };

  failAttempt: StepRunStore["failAttempt"] = async (input) => {
    const found = this.#attempt(input.runId, input.stepIndex);
    if (!found || found.run.state !== "running" || found.attempt.state !== "running" || found.attempt.generation !== input.generation) {
      return { ok: false, reason: "stale_generation" };
    }
    const { run, attempt } = found;
    attempt.errorCode = input.code;
    attempt.leaseUntil = null;
    if (input.retryable && attempt.tries < MAX_TRIES) {
      attempt.state = "queued";
      this.#setStatus(run.owner, attempt.pageId, "wait");
      return { ok: true, outcome: "retry", generation: attempt.generation, tries: attempt.tries };
    }
    attempt.state = "failed";
    // 区切りを始めていれば、終えた区切りの出力をつなぎ、今の区切りの書けたところまでを後ろに足す（editor-store と同じ）
    attempt.partialBlocks = attempt.chunkBlocks.length > 0
      ? [...attempt.chunkBlocks.flat(), ...(input.partial ?? [])]
      : input.partial === undefined ? null : [...input.partial];
    attempt.finishedAt = this.#now();
    this.#setStatus(run.owner, attempt.pageId, "failed");
    this.#failRunFrom(run, input.stepIndex);
    return { ok: true, outcome: "failed" };
  };

  startChunks: StepRunStore["startChunks"] = async (input) => {
    const found = this.#attempt(input.runId, input.stepIndex);
    if (!found || found.attempt.state !== "running" || found.attempt.generation !== input.generation || found.attempt.chunkCount !== null) return false;
    found.attempt.chunkCount = input.count;
    found.attempt.chunkBasis = input.basis;
    found.attempt.chunkIndex = 0;
    found.attempt.chunkBlocks = [];
    return true;
  };

  commitChunk: StepRunStore["commitChunk"] = async (input) => {
    const found = this.#attempt(input.runId, input.stepIndex);
    const attempt = found?.attempt;
    if (!found || found.run.state !== "running" || !attempt || attempt.state !== "running" || attempt.generation !== input.generation ||
        attempt.chunkCount === null || attempt.chunkIndex !== input.chunkIndex || attempt.chunkIndex + 1 >= attempt.chunkCount ||
        attempt.chunkBlocks.length !== attempt.chunkIndex) {
      return { ok: false, reason: "stale_generation" };
    }
    attempt.chunkBlocks.push([...input.blocks]);
    attempt.chunkIndex += 1;
    attempt.state = "queued";
    attempt.leaseUntil = null;
    attempt.tries = 0;
    attempt.errorCode = null;
    return { ok: true, generation: attempt.generation };
  };

  resumeRun: StepRunStore["resumeRun"] = async (owner, parentId, runId) => {
    const run = this.runs.get(runId);
    if (!isPageId(parentId) || !this.#page(owner, parentId) || !run || run.owner !== owner || run.parent !== parentId) return { status: "not_found" };
    if ([...this.runs.values()].some((other) => other.owner === owner && other.parent === parentId && ACTIVE.includes(other.state))) return { status: "run_in_progress" };
    const latest = [...this.runs.values()].filter((other) => other.owner === owner && other.parent === parentId).sort((a, b) => b.seq - a.seq)[0];
    if (latest?.id !== runId || run.state !== "failed") return { status: "not_resumable" };
    const failed = run.attempts.find((attempt) => attempt.state === "failed");
    const step = failed ? run.recipeSnapshot.steps[failed.stepIndex] : undefined;
    if (!failed || !step || step.chunked !== true || failed.chunkCount === null || failed.chunkBasis === null || !this.#page(owner, failed.pageId)) {
      return { status: "not_resumable" };
    }
    const upstream = run.attempts.slice(0, failed.stepIndex).map((prior) => ({ id: prior.stepId, pageId: prior.pageId }));
    const materials = this.#materials(owner, parentId, run.recipeSnapshot, failed.stepIndex, undefined, upstream);
    if (!materials) return { status: "not_resumable" };
    if (computeChunkBasis(computeStepBasis(run.recipeSnapshot, failed.stepIndex, materials)) !== failed.chunkBasis) return { status: "input_changed" };
    failed.state = "queued";
    failed.tries = 0;
    failed.generation += 1;
    failed.errorCode = null;
    failed.partialBlocks = null;
    failed.finishedAt = null;
    for (const later of run.attempts.slice(failed.stepIndex + 1)) {
      if (later.state === "canceled") {
        later.state = "pending";
        later.finishedAt = null;
      }
    }
    run.state = "queued";
    this.#setStatus(owner, failed.pageId, "wait");
    return { status: "resumed", run: this.#view(run), stepIndex: failed.stepIndex, generation: failed.generation };
  };
}
