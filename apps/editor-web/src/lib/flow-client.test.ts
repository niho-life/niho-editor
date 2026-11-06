import { describe, expect, it, vi } from "vitest";
import { getFlow, setFlowRecipe, startFlowRun } from "./flow-client";
import { StepsRequestError } from "./steps-client";

const TAB = "00000000-0000-4000-8000-0000000000b1";
const FOLDER = "00000000-0000-4000-8000-0000000000f0";
const RUN = {
  id: "00000000-0000-4000-8000-0000000000e1", recipe: "tpl-1", state: "queued", fromStep: 0,
  steps: [{ index: 0, id: "s0", name: "文字起こし修正", state: "queued", pageId: "00000000-0000-4000-8000-0000000000a0", stepStatus: "wait", tries: 0, errorCode: null }],
};
const STATE = {
  tab: { id: TAB, kind: "rec", holder: "00000000-0000-4000-8000-0000000000aa", folder: { id: FOLDER, title: "取材" } },
  recipe: { id: "tpl-1", name: "記事制作", steps: [{ id: "s0", name: "文字起こし修正" }] },
  recipes: [{ id: "tpl-1", name: "記事制作", defaultName: "記事制作", unusableReason: null }],
  rows: [
    { kind: "rec", name: "録音", holder: { id: "h", title: "録音" }, tabs: [{ id: TAB, kind: "rec", label: "", status: null, running: false }], current: true, from: null, action: null },
    { kind: "transcript", name: "文字起こし", holder: null, tabs: [], current: false, from: null, action: "go", engines: [{ id: "gemini", used: true }] },
    { kind: "step", stepId: "s0", stepIndex: 0, name: "文字起こし修正", holder: null, tabs: [], current: false, from: null, action: "go" },
  ],
  run: null,
};

function fetchOnce(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("flow-client（流れの API。#309）", () => {
  it("流れはタブの id で読み、行・手順・候補・run をそのまま返す", async () => {
    const fetchImpl = fetchOnce(200, STATE);
    const state = await getFlow(TAB, fetchImpl);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`/api/pages/${TAB}/flow`);
    expect(fetchImpl.mock.calls[0]![1]).toEqual({ method: "GET", credentials: "same-origin", cache: "no-store" });
    expect(state.tab.folder).toEqual({ id: FOLDER, title: "取材" });
    expect(state.rows.map((row) => row.kind)).toEqual(["rec", "transcript", "step"]);
    expect(state.rows[1]?.engines).toEqual([{ id: "gemini", used: true }]);
    expect(state.run).toBeNull();
    const withRun = await getFlow(TAB, fetchOnce(200, { ...STATE, run: RUN }));
    expect(withRun.run?.id).toBe(RUN.id);
  });

  it("形の違う応答は受けない（行の種類・タブの状態・run の形）", async () => {
    for (const bad of [
      { ...STATE, rows: [{ ...STATE.rows[0], kind: "x" }] },
      { ...STATE, rows: [{ ...STATE.rows[0], tabs: [{ id: TAB, kind: "rec", label: "", status: "odd", running: false }] }] },
      { ...STATE, run: { ...RUN, steps: [] } },
      { ...STATE, recipe: { id: "tpl-1" } },
      { tab: STATE.tab },
    ]) {
      await expect(getFlow(TAB, fetchOnce(200, bad))).rejects.toMatchObject({ name: "StepsRequestError", status: 500 });
    }
  });

  it("作成は本文をそのまま送り、Idempotency-Key は渡されたときだけ。202 以外は失敗", async () => {
    const fetchImpl = fetchOnce(202, { run: RUN, folder: FOLDER, opened: RUN.steps[0]!.pageId });
    const result = await startFlowRun(TAB, { inputTab: TAB, toStep: 0 }, {}, fetchImpl);
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe(`/api/pages/${TAB}/flow/runs`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ inputTab: TAB, toStep: 0 });
    expect(new Headers(init!.headers).has("idempotency-key")).toBe(false);
    expect(result).toEqual({ run: expect.objectContaining({ id: RUN.id }), folder: FOLDER, opened: RUN.steps[0]!.pageId });

    const again = fetchOnce(202, { run: RUN, folder: FOLDER, opened: null });
    await startFlowRun(TAB, { regenerate: TAB }, { idempotencyKey: "abc-1" }, again);
    expect(JSON.parse(again.mock.calls[0]![1]!.body as string)).toEqual({ regenerate: TAB });
    expect(new Headers(again.mock.calls[0]![1]!.headers).get("idempotency-key")).toBe("abc-1");

    await expect(startFlowRun(TAB, { sibling: TAB }, {}, fetchOnce(409, { error: "run_in_progress" }))).rejects.toMatchObject({ status: 409, error: "run_in_progress" });
    await expect(startFlowRun(TAB, { sibling: TAB }, {}, fetchOnce(200, { run: RUN, folder: FOLDER, opened: null }))).rejects.toBeInstanceOf(StepsRequestError);
  });

  it("フォルダの手順は PATCH で替え、入れたフォルダの id を返す", async () => {
    const fetchImpl = fetchOnce(200, { folder: FOLDER, recipe: "tpl-2" });
    expect(await setFlowRecipe(TAB, "tpl-2", fetchImpl)).toBe(FOLDER);
    const [path, init] = fetchImpl.mock.calls[0]!;
    expect(path).toBe(`/api/pages/${TAB}/flow`);
    expect(init!.method).toBe("PATCH");
    expect(JSON.parse(init!.body as string)).toEqual({ recipe: "tpl-2" });
    await expect(setFlowRecipe(TAB, null, fetchOnce(400, { error: "bad_request" }))).rejects.toMatchObject({ status: 400, error: "bad_request" });
  });
});
