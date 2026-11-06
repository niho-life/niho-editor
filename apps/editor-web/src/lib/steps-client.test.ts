import { describe, expect, it, vi } from "vitest";
import { StepsRequestError, cancelStepRun, getStepPartialOutput, getSteps, isStepRunDone, type StepRecipeChoice, type StepRun } from "./steps-client";

const PARENT = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

const RUN = {
  id: "run-1",
  recipe: "tpl-1",
  state: "queued",
  fromStep: 0,
  steps: [{ index: 0, id: "k7m2q9xa", name: "文字起こし修正", state: "queued", pageId: "page-0", stepStatus: "wait", tries: 0, errorCode: null }],
} satisfies StepRun;

const RECIPES = [
  { id: "tpl-1", name: "記事制作", defaultName: "記事制作" },
  { id: "r-1", name: "対談", defaultName: null },
] satisfies StepRecipeChoice[];

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fetchOnce = (status: number, body: unknown) => vi.fn<typeof fetch>(async () => respond(status, body));

describe("steps-client", () => {
  it("読み出しは同じ origin の GET で、cookie を送り、応答を蓄えない", async () => {
    const fetchImpl = fetchOnce(200, { run: RUN, recipes: RECIPES });
    expect(await getSteps(PARENT, fetchImpl)).toEqual({ run: RUN, recipes: RECIPES });
    expect(fetchImpl.mock.calls[0]![0]).toBe(`/api/pages/${PARENT}/steps`);
    expect(fetchImpl.mock.calls[0]![1]).toEqual({ method: "GET", credentials: "same-origin", cache: "no-store" });
  });

  it("手順が動いていなくても、その人の手順の一覧は受け取る（入口に出すもの）", async () => {
    expect(await getSteps(PARENT, fetchOnce(200, { run: null, recipes: RECIPES }))).toEqual({ run: null, recipes: RECIPES });
  });

  it("polling accepts only the partial-output availability flag, while explicit fetch reads blocks", async () => {
    const flagged = { ...RUN, state: "failed" as const, steps: [{ ...RUN.steps[0]!, state: "failed" as const, hasPartialOutput: true }] };
    expect((await getSteps(PARENT, fetchOnce(200, { run: flagged, recipes: RECIPES }))).run?.steps[0]?.hasPartialOutput).toBe(true);

    const runId = "a7c6b2a1-2e53-48a6-9c43-61c48824f82b";
    const fetchImpl = fetchOnce(200, { blocks: [{ type: "paragraph", content: [{ type: "text", text: "合成の途中" }] }] });
    expect(await getStepPartialOutput(PARENT, runId, 0, fetchImpl)).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "合成の途中" }] },
    ]);
    expect(fetchImpl.mock.calls[0]![0]).toBe("/api/pages/" + PARENT + "/steps/runs/" + runId + "/steps/0/partial");
    expect(fetchImpl.mock.calls[0]![1]).toEqual({ method: "GET", credentials: "same-origin", cache: "no-store" });
  });

  it("取消は run の id を path に入れる", async () => {
    const fetchImpl = fetchOnce(200, { run: { ...RUN, state: "canceled" } });
    expect((await cancelStepRun(PARENT, "run 1", fetchImpl)).state).toBe("canceled");
    expect(fetchImpl.mock.calls[0]![0]).toBe(`/api/pages/${PARENT}/steps/runs/run%201/cancel`);
  });

  it("失敗は status と短い code だけを持つ（本文は持たない）", async () => {
    await expect(cancelStepRun(PARENT, "run-1", fetchOnce(409, { error: "run_in_progress" }))).rejects.toMatchObject({
      name: "StepsRequestError",
      status: 409,
      error: "run_in_progress",
    });
    await expect(getSteps(PARENT, fetchOnce(401, { error: "unauthorized" }))).rejects.toMatchObject({ status: 401, error: "unauthorized" });
    // JSON でない応答でも、形の分からない失敗として扱う
    const broken = vi.fn<typeof fetch>(async () => new Response("<html>", { status: 503 }));
    await expect(getSteps(PARENT, broken)).rejects.toBeInstanceOf(StepsRequestError);
  });

  it("形の違う応答は受けない（知らない状態・段階の無い run・足りない欄・手順の一覧の形）", async () => {
    const bad: unknown[] = [
      { run: { ...RUN, state: "unknown" }, recipes: RECIPES },
      { run: { ...RUN, steps: [] }, recipes: RECIPES },
      { run: { ...RUN, fromStep: -1 }, recipes: RECIPES },
      { run: { ...RUN, steps: [{ ...RUN.steps[0], stepStatus: "weird" }] }, recipes: RECIPES },
      { run: { ...RUN, steps: [{ ...RUN.steps[0], state: "nope" }] }, recipes: RECIPES },
      { run: { ...RUN, steps: [{ ...RUN.steps[0], tries: 1.5 }] }, recipes: RECIPES },
      { run: { ...RUN, steps: [{ ...RUN.steps[0], hasPartialOutput: "yes" }] }, recipes: RECIPES },
      { run: {}, recipes: RECIPES },
      // 手順の一覧が無い・形が違う
      { run: null },
      { run: null, recipes: {} },
      { run: null, recipes: [{ id: "", name: "名無し", defaultName: null }] },
      { run: null, recipes: [{ id: "tpl-1", defaultName: null }] },
      { run: null, recipes: [{ id: "tpl-1", name: "記事制作", defaultName: 1 }] },
      {},
    ];
    for (const body of bad) {
      await expect(getSteps(PARENT, fetchOnce(200, body)), JSON.stringify(body)).rejects.toBeInstanceOf(StepsRequestError);
    }
  });

  it("終わった run は読み直さなくてよい", () => {
    expect(isStepRunDone(null)).toBe(false);
    expect(isStepRunDone({ ...RUN, state: "queued" })).toBe(false);
    expect(isStepRunDone({ ...RUN, state: "running" })).toBe(false);
    for (const state of ["succeeded", "failed", "canceled"] as const) expect(isStepRunDone({ ...RUN, state })).toBe(true);
  });
});
