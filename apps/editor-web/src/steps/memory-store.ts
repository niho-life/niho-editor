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
  type AttemptState,
  type Block,
  type FlowHolder,
  type FlowView,
  type MadeFrom,
  type PageKind,
  type PageRole,
  type RunState,
  type StepRunView,
  type StepStatus,
  type StepBasis,
  type StepStaleReason,
  type StepInput,
  type StepMaterials,
  type StepRecipe,
  type PageFields,
  type EditorSettings,
  type TabLocation,
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
  /** 親（タブ・入れ物ならフォルダ）。 */
  parent: string | null;
  /** 入れ物（タブだけ。#307）。 */
  page: string | null;
  /** 入れ物の役割（入れ物だけ）。 */
  role: PageRole | null;
  recipe: string | null;
  stepStatus: StepStatus | null;
  madeFrom: MadeFrom | null;
  revision: number;
  tabName: string | null;
  sortOrder: number;
  createdAt: number;
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
  /** フォルダ（#309）。 */
  parent: string;
  recipe: string;
  recipeSnapshot: RecipeSnapshot;
  recipeRevision: number;
  fromStep: number;
  inputTab: string;
  inputRevision: number;
  state: RunState;
  key: string | null;
  seq: number;
  attempts: MemoryAttempt[];
};

const ACTIVE: readonly RunState[] = ["queued", "running"];
const TAB_KINDS: readonly PageKind[] = ["note", "rec", "article"];

function snapshotFromRecipe(recipe: StepRecipe): RecipeSnapshot {
  return snapshotOf({
    id: recipe.id, name: recipe.name ?? recipe.id, guide: recipe.guide ?? "",
    steps: recipe.steps.map((step) => ({ id: step.id, name: step.name, instruction: step.instruction, profile: step.profile ?? "standard", ...(step.chunked === true ? { chunked: true } : {}) })),
    terms: recipe.terms ?? [], samples: recipe.samples ?? [],
  });
}

/** 段階の始まり: 役割 k の入れ物のタブ → k+1、それ以外（録音・役割なし）→ 0（editor-store の startStepOf と同じ）。 */
function startStepOf(role: PageRole | null, recipeId: string, steps: readonly { id: string }[]): number {
  if (!role || role.kind !== "step" || role.recipe !== recipeId) return 0;
  const index = steps.findIndex((step) => step.id === role.stepId);
  return index < 0 ? 0 : index + 1;
}

/** 上流の成果物: 途中の段階から始めた run では、入力のタブが直前の段階の成果物（editor-store の upstreamOf と同じ）。 */
function upstreamOf(snapshot: RecipeSnapshot | null, fromStep: number, inputTab: string, attempts: readonly { id: string; pageId: string }[]): { id: string; pageId: string }[] {
  const before = snapshot?.steps[fromStep - 1];
  const input = fromStep > 0 && before ? [{ id: before.id, pageId: inputTab }] : [];
  return [...input, ...attempts];
}

/**
 * メモリの中の StepRunStore（テスト用。packages/editor-store の step-runs.ts と同じ約束の小さな写し。#309 のフォルダ・タブの形）。
 * 1 つの呼び出しの中で await しないので、各操作はそのまま不可分になる。
 */
export class MemoryStepRunStore implements StepRunStore {
  readonly pages = new Map<string, MemoryPage>();
  readonly runs = new Map<string, MemoryRun>();
  readonly fields = new Map<string, PageFields>();
  readonly settings = new Map<string, EditorSettings>();
  /** 録音のタブで済んだ文字起こしのエンジン（test 用。流れの「済み」）。 */
  readonly usedEngines = new Map<string, string[]>();
  #seq = 0;
  #clock = 0;

  /** 単調に進む時刻（finishedAt の並びに使う）。 */
  #now(): number {
    this.#clock = Math.max(this.#clock + 1, Date.now());
    return this.#clock;
  }

  #insert(page: Omit<MemoryPage, "id" | "createdAt" | "deleted" | "revision" | "sortOrder" | "tabName"> & Partial<Pick<MemoryPage, "id" | "revision" | "sortOrder" | "tabName">>): MemoryPage {
    const row: MemoryPage = { id: randomUUID(), revision: 1, sortOrder: 0, tabName: null, ...page, createdAt: this.#now(), deleted: false };
    this.pages.set(row.id, row);
    return row;
  }

  /** フォルダ。 */
  addFolder(owner: string, title = "合成のフォルダ"): string {
    return this.#insert({ owner, kind: "folder", title, blocks: [], parent: null, page: null, role: null, recipe: null, stepStatus: null, madeFrom: null }).id;
  }

  /**
   * 本文のページ（既定は note）。入れ物を一緒に作り、タブの id を返す（editor-store の createPage と同じ）。
   * `parent` はフォルダ。`role` は入れ物の役割。
   */
  addPage(owner: string, page: { kind?: PageKind; blocks?: Block[]; title?: string; parent?: string | null; role?: PageRole | null } = {}): string {
    const kind = page.kind ?? "note";
    const title = page.title ?? "";
    const parent = page.parent ?? null;
    if (!TAB_KINDS.includes(kind)) {
      return this.#insert({ owner, kind, title, blocks: page.blocks ?? [], parent, page: null, role: null, recipe: null, stepStatus: null, madeFrom: null }).id;
    }
    const holder = this.#insert({ owner, kind: "page", title, blocks: [], parent, page: null, role: page.role ?? null, recipe: null, stepStatus: null, madeFrom: null });
    return this.#insert({ owner, kind, title, blocks: page.blocks ?? [], parent, page: holder.id, role: null, recipe: null, stepStatus: null, madeFrom: null, sortOrder: 1 }).id;
  }

  /** test 用: タブの入れ物。 */
  holderOf(tabId: string): MemoryPage | null {
    const tab = this.pages.get(tabId);
    return tab?.page ? this.pages.get(tab.page) ?? null : null;
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

  #tabsOf(owner: string, holderId: string): MemoryPage[] {
    return [...this.pages.values()]
      .filter((page) => page.owner === owner && !page.deleted && page.page === holderId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  #latestRun(owner: string, folderId: string, recipeId?: string): MemoryRun | undefined {
    return [...this.runs.values()]
      .filter((run) => run.owner === owner && run.parent === folderId && (recipeId === undefined || run.recipe === recipeId))
      .sort((a, b) => b.seq - a.seq)[0];
  }

  /** 系譜の根（`made_from.input` を最大 8 段たどる）。途中が消えていれば null。 */
  #root(owner: string, tabId: string): MemoryPage | null {
    let current = this.#page(owner, tabId);
    for (let hops = 0; current && hops < 8; hops++) {
      const made = current.madeFrom;
      if (!made || made.kind !== "step") break;
      const next = this.#page(owner, made.input);
      if (!next) break;
      current = next;
    }
    return current;
  }

  #chainIds(owner: string, tabId: string): Set<string> {
    const ids = new Set<string>();
    let current = this.#page(owner, tabId);
    for (let hops = 0; current && hops <= 8; hops++) {
      ids.add(current.id);
      const made = current.madeFrom;
      if (!made || made.kind !== "step") break;
      current = this.#page(owner, made.input);
    }
    return ids;
  }

  #materials(owner: string, folderId: string, inputTabId: string, previousPageId: string | null, upstreamPageIds: readonly { id: string; pageId: string }[]): StepMaterials | null {
    const root = this.#root(owner, inputTabId);
    if (!root || !this.#page(owner, folderId)) return null;
    const chain = this.#chainIds(owner, inputTabId);
    const upstreamIds = new Set(upstreamPageIds.map((item) => item.pageId));
    return {
      parentBlocks: root.blocks,
      // 「この録音について」は系譜の根（録音）の欄（editor-store の readStepInput と同じ）
      background: this.fields.get(root.id)?.background ?? "",
      upstream: upstreamPageIds.map((item) => ({ id: item.id, blocks: this.#page(owner, item.pageId)?.blocks ?? [] })),
      // 参考は同じフォルダの役割の無い入れ物のタブ（段階の出力・系譜・前の段階・上流は入れない）
      refs: [...this.pages.values()]
        .filter((page) => page.owner === owner && !page.deleted && page.parent === folderId && (page.kind === "note" || page.kind === "article")
          && (page.page === null || (this.#page(owner, page.page)?.role ?? null) === null) && page.madeFrom?.kind !== "step"
          && !chain.has(page.id) && page.id !== previousPageId && !upstreamIds.has(page.id))
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
        .map((page) => ({ id: page.id, blocks: page.blocks })),
      fields: { entities: this.fields.get(root.id)?.entities ?? [], terms: this.fields.get(root.id)?.terms ?? [] },
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
      inputTab: run.inputTab,
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

  readPartialOutput: StepRunStore["readPartialOutput"] = async (owner, folderId, runId, stepIndex) => {
    const run = this.runs.get(runId);
    const folder = this.#page(owner, folderId);
    if (!run || !folder || run.owner !== owner || run.parent !== folderId || run.state !== "failed") return null;
    if (this.#latestRun(owner, folderId)?.id !== runId) return null;
    const attempt = run.attempts.find((item) => item.stepIndex === stepIndex);
    if (!attempt || attempt.state !== "failed" || !attempt.partialBlocks || attempt.partialBlocks.length === 0) return null;
    if (!this.#page(owner, attempt.pageId)) return null;
    return [...attempt.partialBlocks];
  };

  #attempt(runId: string, stepIndex: number): { run: MemoryRun; attempt: MemoryAttempt } | null {
    const run = this.runs.get(runId);
    const attempt = run?.attempts.find((item) => item.stepIndex === stepIndex);
    return run && attempt ? { run, attempt } : null;
  }

  #failRunFrom(run: MemoryRun, stepIndex: number): void {
    const now = this.#now();
    for (const later of run.attempts) {
      if (later.stepIndex > stepIndex && (later.state === "pending" || later.state === "queued")) {
        later.state = "canceled";
        later.finishedAt = now;
        this.#setStatus(run.owner, later.pageId, "wait");
      }
    }
    run.state = "failed";
  }

  /** 段階の役割ページ（フォルダ直下の `role = { kind: 'step', recipe, stepId }` の入れ物）。無ければ作る。 */
  #stepHolder(owner: string, folderId: string, recipeId: string, step: { id: string; name: string }): MemoryPage {
    const found = [...this.pages.values()]
      .filter((page) => page.owner === owner && !page.deleted && page.parent === folderId && page.kind === "page" && page.role?.kind === "step" && page.role.recipe === recipeId && page.role.stepId === step.id)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))[0];
    return found ?? this.#insert({ owner, kind: "page", title: step.name, blocks: [], parent: folderId, page: null, role: { kind: "step", recipe: recipeId, stepId: step.id }, recipe: null, stepStatus: null, madeFrom: null });
  }

  createRun: StepRunStore["createRun"] = async (owner, folderId, input) => {
    const { recipe } = input;
    if (recipe.steps.length === 0) throw new TypeError("recipe has no steps");
    const target = "inputTab" in input ? input.inputTab : "regenerate" in input ? input.regenerate : input.sibling;
    if ("inputTab" in input && (!Number.isInteger(input.toStep) || input.toStep < 0)) throw new RangeError("toStep is out of range");
    if (!isPageId(folderId) || !isPageId(target)) return { status: "not_found" };
    const folder = this.#page(owner, folderId);
    if (!folder || folder.kind !== "folder") return { status: "not_found" };
    const tab = this.#page(owner, target);
    if (!tab || tab.parent !== folderId || !TAB_KINDS.includes(tab.kind)) return { status: "not_found" };
    const key = input.idempotencyKey ?? null;
    const replay = key === null ? undefined : [...this.runs.values()].find((run) => run.owner === owner && run.key === key);
    if (replay) return { status: "existing", run: this.#view(replay) };
    const prior = this.#latestRun(owner, folderId, recipe.id);
    const recipeSnapshot = prior?.recipeSnapshot ?? snapshotFromRecipe(recipe);
    const role = tab.page ? this.#page(owner, tab.page)?.role ?? null : null;

    let fromStep: number;
    let toStep: number;
    let inputTab: string;
    let inputRevision: number;
    let regenerateTab: string | null = null;
    let siblingHolder: string | null = null;
    if ("inputTab" in input) {
      fromStep = startStepOf(role, recipe.id, recipeSnapshot.steps);
      toStep = input.toStep;
      inputTab = tab.id;
      inputRevision = tab.revision;
      const unfinished = tab.madeFrom?.kind === "step" && (tab.stepStatus === "wait" || tab.stepStatus === "run" || tab.stepStatus === "failed");
      if (toStep < fromStep || toStep >= recipeSnapshot.steps.length || unfinished) return { status: "invalid_from_step" };
    } else {
      const made = tab.madeFrom;
      const stepIndex = role && role.kind === "step" && role.recipe === recipe.id ? recipeSnapshot.steps.findIndex((step) => step.id === role.stepId) : -1;
      if (!made || made.kind !== "step" || stepIndex < 0 || !isPageId(made.input)) return { status: "invalid_from_step" };
      const source = this.#page(owner, made.input);
      if (!source) return { status: "invalid_from_step" };
      inputTab = source.id;
      inputRevision = source.revision;
      fromStep = toStep = stepIndex;
      if ("regenerate" in input) regenerateTab = tab.id;
      else siblingHolder = tab.page;
    }
    if ([...this.runs.values()].some((run) => run.owner === owner && run.parent === folderId && ACTIVE.includes(run.state))) {
      return { status: "run_in_progress" };
    }
    const runId = randomUUID();
    const outputs: string[] = [];
    let previousTab = inputTab;
    for (let index = fromStep; index <= toStep; index++) {
      const step = recipeSnapshot.steps[index]!;
      const madeFrom: MadeFrom = { kind: "step", run: runId, input: previousTab, inputRevision: index === fromStep ? inputRevision : 0 };
      let outputTab: string;
      if (regenerateTab !== null) {
        const page = this.#page(owner, regenerateTab)!;
        page.stepStatus = "wait";
        page.madeFrom = madeFrom;
        outputTab = regenerateTab;
      } else {
        const holder = siblingHolder !== null && index === fromStep ? this.#page(owner, siblingHolder)! : this.#stepHolder(owner, folderId, recipe.id, step);
        const sortOrder = Math.max(0, ...this.#tabsOf(owner, holder.id).map((item) => item.sortOrder)) + 1;
        outputTab = this.#insert({ owner, kind: "note", title: holder.title, blocks: [], parent: folderId, page: holder.id, role: null, recipe: recipe.id, stepStatus: "wait", madeFrom, sortOrder }).id;
      }
      outputs.push(outputTab);
      previousTab = outputTab;
    }
    const run: MemoryRun = {
      id: runId,
      owner,
      parent: folderId,
      recipe: recipe.id,
      recipeSnapshot,
      recipeRevision: prior?.recipeRevision ?? recipe.revision ?? 1,
      fromStep,
      inputTab,
      inputRevision,
      state: "queued",
      key,
      seq: ++this.#seq,
      attempts: outputs.map((pageId, offset) => ({
        stepIndex: fromStep + offset,
        stepId: recipeSnapshot.steps[fromStep + offset]!.id,
        pageId,
        state: offset === 0 ? "queued" : "pending",
        generation: 0,
        tries: 0,
        leaseUntil: null,
        errorCode: null,
        partialBlocks: null,
        inputUsedChars: null,
        inputBasis: null,
        finishedAt: null,
        chunkCount: null,
        chunkIndex: 0,
        chunkBlocks: [],
        chunkBasis: null,
      })),
    };
    this.runs.set(run.id, run);
    return { status: "created", run: this.#view(run) };
  };

  updateRunRecipeSnapshot: StepRunStore["updateRunRecipeSnapshot"] = async (owner, folderId, runId, recipe, expectedRevision) => {
    const latest = this.#latestRun(owner, folderId, recipe.id);
    if (!latest || latest.id !== runId || !this.#page(owner, folderId)) return { status: "not_found" };
    if (ACTIVE.includes(latest.state) || latest.recipeRevision !== expectedRevision) return { status: "conflict" };
    const snapshot = snapshotFromRecipe(recipe);
    const newIndex = new Map(snapshot.steps.map((step, index) => [step.id, index] as const));
    const targets = latest.attempts.map((attempt) => newIndex.get(attempt.stepId));
    if (targets.some((index) => index === undefined) || latest.recipeSnapshot.steps.length !== snapshot.steps.length) return { status: "conflict" };
    const sorted = [...(targets as number[])].sort((a, b) => a - b);
    if (sorted.some((index, at) => at > 0 && index !== sorted[at - 1]! + 1)) return { status: "conflict" };
    for (const attempt of latest.attempts) attempt.stepIndex = newIndex.get(attempt.stepId)!;
    latest.attempts.sort((a, b) => a.stepIndex - b.stepIndex);
    latest.recipeSnapshot = snapshot;
    latest.recipeRevision = recipe.revision ?? 1;
    latest.fromStep = sorted[0] ?? 0;
    return { status: "updated", run: this.#view(latest) };
  };

  listRun: StepRunStore["listRun"] = async (owner, folderId) => {
    if (!isPageId(folderId)) return null;
    const folder = this.#page(owner, folderId);
    if (!folder || folder.kind !== "folder") return null;
    const latest = this.#latestRun(owner, folderId);
    return { run: latest ? this.#view(latest) : null };
  };

  cancelRun: StepRunStore["cancelRun"] = async (owner, folderId, runId) => {
    const run = this.runs.get(runId);
    if (!run || run.owner !== owner || run.parent !== folderId) return null;
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

  /** 最新 run の attempt と、その出力のタブの記録した基準・今の基準（editor-store の readStaleSnapshot と同じ）。 */
  #staleSnapshot(owner: string, folderId: string, recipe: StepRecipe) {
    if (!isPageId(folderId) || !this.#page(owner, folderId)) return null;
    const latest = this.#latestRun(owner, folderId, recipe.id);
    if (!latest) return null;
    const attempts = [...latest.attempts].sort((a, b) => a.stepIndex - b.stepIndex);
    const structuralMismatch = attempts.length === 0 || attempts.some((attempt) => attempt.stepId !== recipe.steps[attempt.stepIndex]?.id);
    const recorded = new Map<string, { basis: StepBasis | string; at: number }>();
    for (const run of this.runs.values()) {
      if (run.owner !== owner || run.parent !== folderId || run.recipe !== recipe.id) continue;
      for (const attempt of run.attempts) {
        const previous = recorded.get(attempt.pageId);
        if (attempt.state === "succeeded" && attempt.inputBasis && (!previous || (attempt.finishedAt ?? 0) > previous.at)) {
          recorded.set(attempt.pageId, { basis: attempt.inputBasis, at: attempt.finishedAt ?? 0 });
        }
      }
    }
    const current = new Map<string, StepBasis>();
    for (const [at, attempt] of attempts.entries()) {
      const index = attempt.stepIndex;
      if (index >= recipe.steps.length) continue;
      const upstreamPageIds = upstreamOf(latest.recipeSnapshot, latest.fromStep, latest.inputTab, attempts.slice(0, at).map((row) => ({ id: row.stepId, pageId: row.pageId })));
      const previousPageId = index === 0 ? null : (upstreamPageIds.at(-1)?.pageId ?? null);
      const materials = this.#materials(owner, folderId, latest.inputTab, previousPageId, upstreamPageIds);
      if (!materials) continue;
      const input: StepInput = { ...materials, previousBlocks: previousPageId === null ? null : this.#page(owner, previousPageId)?.blocks ?? [] };
      current.set(attempt.pageId, computeStepBasis(recipe, index, input));
    }
    return { attempts, recorded, current, structuralMismatch };
  }

  refreshStale: StepRunStore["refreshStale"] = async (owner, folderId, recipe) => {
    const read = this.#staleSnapshot(owner, folderId, recipe);
    if (!read) return 0;
    let changed = 0;
    let upstreamFresh = true;
    for (const attempt of read.attempts) {
      const page = this.#page(owner, attempt.pageId);
      const status = page?.stepStatus ?? null;
      if (!page || (status !== "done" && status !== "stale")) {
        upstreamFresh = false;
        continue;
      }
      const basis = read.current.get(attempt.pageId);
      const reasons = basis ? stepStaleReasons(parseStepBasis(read.recorded.get(attempt.pageId)?.basis), basis) : [];
      const fresh: boolean = !read.structuralMismatch && upstreamFresh && basis !== undefined && reasons.length === 0;
      upstreamFresh = fresh;
      const want: StepStatus = fresh ? "done" : "stale";
      if (page.stepStatus !== want) {
        page.stepStatus = want;
        changed += 1;
      }
    }
    return changed;
  };

  readStaleReasons: NonNullable<StepRunStore["readStaleReasons"]> = async (owner, folderId, recipe) => {
    const read = this.#staleSnapshot(owner, folderId, recipe);
    const result: Record<number, StepStaleReason[]> = {};
    if (!read) return result;
    let inherited: StepStaleReason[] = [];
    for (const attempt of read.attempts) {
      const basis = read.current.get(attempt.pageId);
      const own = basis ? stepStaleReasons(parseStepBasis(read.recorded.get(attempt.pageId)?.basis), basis) : [];
      inherited = [...new Set([...inherited, ...own])];
      result[attempt.stepIndex] = inherited;
    }
    return result;
  };

  claimAttempt: StepRunStore["claimAttempt"] = async (runId, stepIndex, options = {}) => {
    const run = this.runs.get(runId);
    if (!run || !ACTIVE.includes(run.state)) return { ok: false, reason: "run_inactive" };
    const attempt = run.attempts.find((item) => item.stepIndex === stepIndex);
    if (!attempt || attempt.state !== "queued") return { ok: false, reason: "not_queued" };
    const previous = stepIndex === run.fromStep ? null : run.attempts.find((item) => item.stepIndex === stepIndex - 1);
    if (stepIndex !== run.fromStep && (!previous || (previous.state !== "succeeded" && previous.state !== "reused"))) return { ok: false, reason: "superseded" };
    attempt.state = "running";
    attempt.generation += 1;
    attempt.tries += 1;
    attempt.leaseUntil = Date.now() + (options.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000;
    attempt.errorCode = null;
    attempt.partialBlocks = null;
    attempt.inputUsedChars = null;
    run.state = "running";
    this.#setStatus(run.owner, attempt.pageId, "run");
    const upstream = upstreamOf(run.recipeSnapshot, run.fromStep, run.inputTab, run.attempts.filter((prior) => prior.stepIndex < stepIndex).sort((a, b) => a.stepIndex - b.stepIndex).map((prior) => ({ id: prior.stepId, pageId: prior.pageId })));
    return {
      ok: true,
      claim: {
        runId,
        stepIndex,
        generation: attempt.generation,
        tries: attempt.tries,
        owner: run.owner,
        parentId: run.parent,
        inputTabId: run.inputTab,
        recipe: run.recipe,
        recipeSnapshot: run.recipeSnapshot,
        stepId: attempt.stepId,
        pageId: attempt.pageId,
        previousPageId: stepIndex === 0 ? null : (upstream.at(-1)?.pageId ?? null),
        upstreamPageIds: upstream,
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
    if (claim.inputTabId === null) return null;
    const materials = this.#materials(claim.owner, claim.parentId, claim.inputTabId, claim.previousPageId, claim.upstreamPageIds);
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
    page.revision += 1;
    page.stepStatus = "done";
    attempt.state = "succeeded";
    attempt.inputBasis = input.inputBasis;
    attempt.inputUsedChars = input.inputUsedChars ?? null;
    attempt.leaseUntil = null;
    attempt.finishedAt = this.#now();
    const next = run.attempts.find((item) => item.stepIndex === input.stepIndex + 1);
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

  resumeRun: StepRunStore["resumeRun"] = async (owner, folderId, runId) => {
    const run = this.runs.get(runId);
    if (!isPageId(folderId) || !this.#page(owner, folderId) || !run || run.owner !== owner || run.parent !== folderId) return { status: "not_found" };
    if ([...this.runs.values()].some((other) => other.owner === owner && other.parent === folderId && ACTIVE.includes(other.state))) return { status: "run_in_progress" };
    if (this.#latestRun(owner, folderId)?.id !== runId || run.state !== "failed") return { status: "not_resumable" };
    const failed = run.attempts.find((attempt) => attempt.state === "failed");
    const step = failed ? run.recipeSnapshot.steps[failed.stepIndex] : undefined;
    if (!failed || !step || step.chunked !== true || failed.chunkCount === null || failed.chunkBasis === null || !this.#page(owner, failed.pageId)) {
      return { status: "not_resumable" };
    }
    const upstream = upstreamOf(run.recipeSnapshot, run.fromStep, run.inputTab, run.attempts.filter((prior) => prior.stepIndex < failed.stepIndex).sort((a, b) => a.stepIndex - b.stepIndex).map((prior) => ({ id: prior.stepId, pageId: prior.pageId })));
    const previousPageId = failed.stepIndex === 0 ? null : (upstream.at(-1)?.pageId ?? null);
    const materials = this.#materials(owner, folderId, run.inputTab, previousPageId, upstream);
    if (!materials) return { status: "not_resumable" };
    const input = { ...materials, previousBlocks: previousPageId === null ? null : this.#page(owner, previousPageId)?.blocks ?? [] };
    if (computeChunkBasis(computeStepBasis(run.recipeSnapshot, failed.stepIndex, input)) !== failed.chunkBasis) return { status: "input_changed" };
    failed.state = "queued";
    failed.tries = 0;
    failed.generation += 1;
    failed.errorCode = null;
    failed.partialBlocks = null;
    failed.finishedAt = null;
    for (const later of run.attempts) {
      if (later.stepIndex > failed.stepIndex && later.state === "canceled") {
        later.state = "pending";
        later.finishedAt = null;
      }
    }
    run.state = "queued";
    this.#setStatus(owner, failed.pageId, "wait");
    return { status: "resumed", run: this.#view(run), stepIndex: failed.stepIndex, generation: failed.generation };
  };

  readFlow: StepRunStore["readFlow"] = async (owner, folderId) => {
    if (!isPageId(folderId)) return null;
    const folder = this.#page(owner, folderId);
    if (!folder || folder.kind !== "folder") return null;
    const holders: FlowHolder[] = [...this.pages.values()]
      .filter((page) => page.owner === owner && !page.deleted && page.parent === folderId && page.kind === "page")
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map((holder) => ({
        id: holder.id,
        title: holder.title,
        role: holder.role,
        tabs: this.#tabsOf(owner, holder.id).map((tab, at) => ({ id: tab.id, kind: tab.kind, title: tab.title, tabName: tab.tabName, tabPos: at + 1, revision: tab.revision, stepStatus: tab.stepStatus, madeFrom: tab.madeFrom })),
      }))
      // 入れ物だけでタブの無いものは流れに出ない（editor-store の readFlow は JOIN で落とす）
      .filter((holder) => holder.tabs.length > 0);
    const usedEngines = holders.flatMap((holder) => holder.tabs.filter((tab) => tab.kind === "rec").flatMap((tab) => (this.usedEngines.get(tab.id) ?? []).map((engine) => ({ recording: tab.id, engine }))));
    const view: FlowView = { folder: { id: folder.id, title: folder.title, recipe: folder.recipe }, holders, usedEngines };
    return view;
  };

  locateTab: StepRunStore["locateTab"] = async (owner, tabId) => {
    if (!isPageId(tabId)) return null;
    const tab = this.#page(owner, tabId);
    if (!tab || !TAB_KINDS.includes(tab.kind)) return null;
    const holder = tab.page ? this.#page(owner, tab.page) : null;
    const folder = tab.parent ? this.#page(owner, tab.parent) : null;
    const location: TabLocation = { id: tab.id, kind: tab.kind, title: tab.title, holder: holder?.kind === "page" ? holder.id : null, folder: folder?.kind === "folder" ? folder.id : null };
    return location;
  };

  wrapInFolder: StepRunStore["wrapInFolder"] = async (owner, holderId) => {
    const holder = this.#page(owner, holderId);
    if (!holder || holder.kind !== "page" || holder.parent !== null) return null;
    const folder = this.addFolder(owner, holder.title);
    holder.parent = folder;
    for (const tab of this.#tabsOf(owner, holder.id)) tab.parent = folder;
    return folder;
  };

  setFolderRecipe: StepRunStore["setFolderRecipe"] = async (owner, folderId, recipe) => {
    const folder = isPageId(folderId) ? this.#page(owner, folderId) : null;
    if (!folder || folder.kind !== "folder") return false;
    folder.recipe = recipe;
    return true;
  };
}
