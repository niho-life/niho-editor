import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { AttemptRef } from "@niho/editor-store";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { CloudTasksQueue, METADATA_TOKEN_URL, type CloudTasksConfig } from "../steps/cloud-tasks";
import { StepError, createFakeExecutor, fakeExecutor, type StepExecutor } from "../steps/executor";
import { MemoryStepRunStore } from "../steps/memory-store";
import { MemoryTaskQueue, taskName, type TaskQueue } from "../steps/queue";
import { DEFAULT_RECIPES, findRecipeIn } from "../steps/recipes";
import { verifyGoogleOidc, type OidcVerifyResult } from "./google-oidc";
import { RUN_BODY_LIMIT, SWEEP_LIMIT, SWEEP_MAX_PAGES, runStepTask, sweepStepTasks, type StepsWorkerDeps } from "./steps-worker-api";

// 合成の値だけ（本物のプロジェクト・URL・メール・トークンを入れない）
const CONFIG: CloudTasksConfig = {
  queue: "projects/synthetic-project/locations/asia-northeast1/queues/synthetic-queue",
  workerUrl: "https://worker.example.test",
  invokerServiceAccount: "synthetic-tasks@synthetic-project.iam.gserviceaccount.com",
};
const OWNER = "synthetic-owner-a";
const transcript = [{ type: "paragraph", content: [{ type: "text", text: "合成の文字起こし" }] }];

/** 偽の検証器のトークン: 中身は `{ aud, email }` の JSON（検証器に渡る期待値と比べる）。 */
const tokenFor = (aud = CONFIG.workerUrl, email = CONFIG.invokerServiceAccount) => Buffer.from(JSON.stringify({ aud, email })).toString("base64url");
const GOOD = tokenFor();

function fakeVerifier() {
  return vi.fn(async (token: string, expected: { audience: string; allowedEmail: string }): Promise<OidcVerifyResult> => {
    try {
      const claims = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as { aud?: string; email?: string };
      if (claims.aud !== expected.audience) return { ok: false, code: "bad_audience" };
      if (claims.email !== expected.allowedEmail) return { ok: false, code: "bad_email" };
      return { ok: true };
    } catch {
      return { ok: false, code: "malformed" };
    }
  });
}

type SweepFake = { expired: AttemptRef[]; queued: AttemptRef[]; claimed: string[] };

function setup(options: { executor?: StepExecutor; queue?: TaskQueue; config?: CloudTasksConfig | null; store?: "none" } = {}) {
  const store = new MemoryStepRunStore();
  const sweep: SweepFake = { expired: [], queued: [], claimed: [] };
  const sweepExpiredLeases = vi.fn(async () => sweep.expired);
  // 古い順の一覧を、after（前の回の最後）の次から limit 件
  const listQueuedAttempts = vi.fn(async (options?: { limit?: number; after?: Pick<AttemptRef, "runId" | "stepIndex"> }) => {
    const after = options?.after;
    const start = after ? sweep.queued.findIndex((item) => item.runId === after.runId && item.stepIndex === after.stepIndex) + 1 : 0;
    return sweep.queued.slice(start, start + (options?.limit ?? 100));
  });
  // 本物と同じ約束: queued のままなら世代を 1 つ進めて返し、そうでなければ null
  const requeueAttempt = vi.fn(async (ref: AttemptRef) => (sweep.claimed.includes(ref.runId) ? null : ref.generation + 1));
  const workerStore = Object.assign(store, { sweepExpiredLeases, listQueuedAttempts, requeueAttempt });
  const queue = options.queue ?? new MemoryTaskQueue();
  const verify = fakeVerifier();
  const steps = vi.fn(() => (options.store === "none" ? null : workerStore));
  const deps: StepsWorkerDeps = {
    config: () => (options.config === undefined ? CONFIG : options.config),
    verify,
    steps,
    queue: () => queue,
    executor: () => options.executor ?? fakeExecutor,
  };
  return { store, sweep, sweepExpiredLeases, listQueuedAttempts, requeueAttempt, queue, verify, steps, deps };
}

async function startRun(store: MemoryStepRunStore, recipe: "tpl-1" | "tpl-2" = "tpl-1") {
  const parent = store.addPage(OWNER, { kind: "rec", blocks: transcript });
  const created = await store.createRun(OWNER, parent, { recipe: findRecipeIn(DEFAULT_RECIPES, recipe)! });
  if (created.status !== "created") throw new Error(created.status);
  return { parent, runId: created.run.id };
}

/** 本文を読まれたかどうかを数える要求（highWaterMark 0 なので、読まれるまで pull されない）。 */
function workerRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  const pulls = { count: 0 };
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls.count += 1;
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(`${CONFIG.workerUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: stream,
    duplex: "half",
  } as RequestInit);
  return { request, pulls };
}

const bearer = (token = GOOD) => ({ authorization: `Bearer ${token}` });
const run = (deps: StepsWorkerDeps, body: unknown, headers: Record<string, string> = bearer()) => {
  const { request, pulls } = workerRequest("/api/internal/steps/run", body, headers);
  return { response: runStepTask(request, deps), request, pulls };
};
const sweepCall = (deps: StepsWorkerDeps, body: unknown = "", headers: Record<string, string> = bearer()) => {
  const { request, pulls } = workerRequest("/api/internal/steps/sweep", body, headers);
  return { response: sweepStepTasks(request, deps), request, pulls };
};

function expectApiHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
}

async function expectJson(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expectApiHeaders(response);
  expect(await response.json()).toEqual(body);
}

let logs: MockInstance[] = [];
beforeEach(() => {
  logs = [vi.spyOn(console, "error").mockImplementation(() => undefined), vi.spyOn(console, "warn").mockImplementation(() => undefined)];
});
afterEach(() => {
  for (const spy of logs) spy.mockRestore();
});
const logged = () => JSON.stringify(logs.flatMap((spy) => spy.mock.calls));

describe("worker routes: the gate (mode → OIDC → Origin) before the body", () => {
  it("answers 404 when the steps mode is not cloud-tasks, without verifying or reading the body", async () => {
    for (const route of [run, sweepCall] as const) {
      const { deps, verify, steps } = setup({ config: null });
      const call = route(deps, { runId: randomUUID(), stepIndex: 0 });
      await expectJson(await call.response, 404, { error: "not_found" });
      expect(verify).not.toHaveBeenCalled();
      expect(steps).not.toHaveBeenCalled();
      expect(call.request.bodyUsed).toBe(false);
      expect(call.pulls.count).toBe(0);
    }
  });

  it("answers 401 with only {error: unauthorized} for a missing, malformed or refused token, without reading the body or touching the store", async () => {
    const headerCases: Record<string, string>[] = [
      {},
      { authorization: "" },
      { authorization: `Basic ${GOOD}` },
      { authorization: "Bearer" },
      { authorization: "Bearer " },
      { authorization: `Bearer ${GOOD} extra` },
      { authorization: `Bearer ${"a".repeat(9000)}` },
      bearer("not-json-at-all"),
      // 別の audience・別のサービスアカウントのトークン
      bearer(tokenFor("https://other.example.test")),
      bearer(tokenFor(`${CONFIG.workerUrl}/api/internal/steps/run`)),
      bearer(tokenFor(CONFIG.workerUrl, "other@synthetic-project.iam.gserviceaccount.com")),
    ];
    for (const route of [run, sweepCall] as const) {
      for (const headers of headerCases) {
        const { deps, steps, sweepExpiredLeases } = setup();
        const call = route(deps, { runId: randomUUID(), stepIndex: 0 }, headers);
        const response = await call.response;
        await expectJson(response, 401, { error: "unauthorized" });
        expect(call.request.bodyUsed).toBe(false);
        expect(call.pulls.count).toBe(0);
        expect(steps).not.toHaveBeenCalled();
        expect(sweepExpiredLeases).not.toHaveBeenCalled();
      }
    }
    // ログは理由の code だけ（トークンは出さない）
    expect(logged()).toContain("bad_audience");
    expect(logged()).toContain("bad_email");
    expect(logged()).toContain("missing_token");
    expect(logged()).not.toContain(tokenFor("https://other.example.test"));
    expect(logged()).not.toContain("other@synthetic-project");
  });

  it("passes the configured worker URL as the audience and the invoker service account as the only allowed email", async () => {
    const { deps, verify } = setup();
    const { runId } = await startRun(new MemoryStepRunStore());
    await (await run(deps, { runId, stepIndex: 0 }).response).text();
    expect(verify).toHaveBeenCalledWith(GOOD, { audience: CONFIG.workerUrl, allowedEmail: CONFIG.invokerServiceAccount });
  });

  it("refuses a request that carries an Origin (a browser), even with a valid token, without reading the body", async () => {
    for (const origin of [CONFIG.workerUrl, "https://attacker.example.test", "null"]) {
      for (const route of [run, sweepCall] as const) {
        const { deps, steps } = setup();
        const call = route(deps, { runId: randomUUID(), stepIndex: 0 }, { ...bearer(), origin });
        await expectJson(await call.response, 403, { error: "forbidden" });
        expect(call.request.bodyUsed).toBe(false);
        expect(steps).not.toHaveBeenCalled();
      }
    }
  });

  it("answers 503 when the database is not available (Cloud Tasks retries)", async () => {
    for (const route of [run, sweepCall] as const) {
      const { deps } = setup({ store: "none" });
      await expectJson(await route(deps, { runId: randomUUID(), stepIndex: 0 }).response, 503, { error: "unavailable" });
    }
  });

  it("works with the real Google OIDC verifier: only a token for the worker URL from the invoker account passes", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "synthetic-kid", alg: "RS256", use: "sig" }] };
    const jwksFetch = (async () => Response.json(jwks, { headers: { "cache-control": "max-age=300" } })) as unknown as typeof fetch;
    const now = Math.floor(Date.now() / 1000);
    const signed = (claims: Record<string, unknown>) => {
      const input = `${Buffer.from(JSON.stringify({ alg: "RS256", kid: "synthetic-kid", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
      return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
    };
    const base = { iss: "https://accounts.google.com", aud: CONFIG.workerUrl, sub: "100000000000000000001", email: CONFIG.invokerServiceAccount, email_verified: true, iat: now, exp: now + 3600 };
    const { deps, store } = setup();
    deps.verify = (token, expected) => verifyGoogleOidc(token, { ...expected, fetch: jwksFetch });
    const { runId } = await startRun(store);

    for (const claims of [{ ...base, aud: "https://other.example.test" }, { ...base, email: "other@synthetic-project.iam.gserviceaccount.com" }, { ...base, exp: now - 120 }]) {
      const call = run(deps, { runId, stepIndex: 0 }, bearer(signed(claims)));
      await expectJson(await call.response, 401, { error: "unauthorized" });
      expect(call.request.bodyUsed).toBe(false);
    }
    await expectJson(await run(deps, { runId, stepIndex: 0 }, bearer(signed(base))).response, 200, { status: "completed" });
  });
});

describe("POST /api/internal/steps/run", () => {
  it("validates the body: JSON, at most 1 KiB, only a UUID runId and a non-negative integer stepIndex", async () => {
    const { deps } = setup();
    const id = randomUUID();
    for (const body of [
      "not json",
      "[]",
      "null",
      {},
      { runId: id },
      { stepIndex: 0 },
      { runId: "not-a-uuid", stepIndex: 0 },
      { runId: id, stepIndex: -1 },
      { runId: id, stepIndex: 1.5 },
      { runId: id, stepIndex: "0" },
      { runId: id, stepIndex: 2 ** 31 },
      { runId: id, stepIndex: 0, extra: true },
    ]) {
      await expectJson(await run(deps, body).response, 400, { error: "bad_request" });
    }
    const wrongType = workerRequest("/api/internal/steps/run", { runId: id, stepIndex: 0 }, { ...bearer(), "content-type": "text/plain" });
    await expectJson(await runStepTask(wrongType.request, deps), 400, { error: "bad_request" });
    await expectJson(await run(deps, { runId: id, stepIndex: 0, pad: "x".repeat(RUN_BODY_LIMIT) }).response, 413, { error: "payload_too_large" });
  });

  it("runs the step and answers 200 with the status for completed, and queues the next step under its task name", async () => {
    const { deps, store, queue } = setup();
    const { runId } = await startRun(store);
    await expectJson(await run(deps, { runId, stepIndex: 0 }).response, 200, { status: "completed" });
    expect((queue as MemoryTaskQueue).drain()).toEqual([{ name: taskName(runId, 1, 0), runId, stepIndex: 1 }]);
    // 同じ task がもう一度届いても（Cloud Tasks の重複配信）二重に実行しない
    await expectJson(await run(deps, { runId, stepIndex: 0 }).response, 200, { status: "skipped" });
    // 存在しない run も 200（Cloud Tasks に再試行させない）
    await expectJson(await run(deps, { runId: randomUUID(), stepIndex: 0 }).response, 200, { status: "skipped" });
  });

  it("answers 200 for retry (the runner queued the retry itself), failed and stale", async () => {
    const retrying = setup({ executor: createFakeExecutor({ failures: 1 }) });
    const first = await startRun(retrying.store);
    await expectJson(await run(retrying.deps, { runId: first.runId, stepIndex: 0 }).response, 200, { status: "retry" });
    expect((retrying.queue as MemoryTaskQueue).drain()).toEqual([{ name: taskName(first.runId, 0, 1), runId: first.runId, stepIndex: 0, delaySeconds: 10 }]);

    const failing = setup({ executor: createFakeExecutor({ failures: 1, error: () => new StepError("bad_input", false) }) });
    const second = await startRun(failing.store);
    await expectJson(await run(failing.deps, { runId: second.runId, stepIndex: 0 }).response, 200, { status: "failed" });

    let cancel: () => Promise<unknown> = async () => undefined;
    const canceling = setup({
      executor: {
        run: async (input) => {
          await cancel();
          return fakeExecutor.run(input);
        },
      },
    });
    const third = await startRun(canceling.store);
    cancel = () => canceling.store.cancelRun(OWNER, third.parent, third.runId);
    await expectJson(await run(canceling.deps, { runId: third.runId, stepIndex: 0 }).response, 200, { status: "stale" });
  });

  it("answers 500 with only {error: internal} on an exception (Cloud Tasks retries the task), logging no details", async () => {
    const broken = setup();
    const { runId } = await startRun(broken.store);
    broken.store.claimAttempt = async () => {
      throw Object.assign(new Error("synthetic database outage leak-check"), { code: "57P01" });
    };
    await expectJson(await run(broken.deps, { runId, stepIndex: 0 }).response, 500, { error: "internal" });

    // 確定のあと、次の段階を積めなかった（Cloud Tasks の障害）
    const failingQueue: TaskQueue = {
      enqueue: async () => {
        throw Object.assign(new Error("cloud tasks: tasks_http_503"), { name: "CloudTasksError", code: "tasks_http_503" });
      },
    };
    const unqueued = setup({ queue: failingQueue });
    const next = await startRun(unqueued.store);
    await expectJson(await run(unqueued.deps, { runId: next.runId, stepIndex: 0 }).response, 500, { error: "internal" });
    expect(logged()).toContain("tasks_http_503");
    expect(logged()).toContain("57P01");
    expect(logged()).not.toContain("leak-check");
    expect(logged()).not.toContain(GOOD);
    expect(logged()).not.toContain(next.runId);
  });
});

describe("POST /api/internal/steps/sweep", () => {
  const ref = (stepIndex: number, generation: number, runId = randomUUID()): AttemptRef => ({ runId, stepIndex, generation });

  it("requeues an expired lease under its own generation, and a never-claimed queued step under a new one", async () => {
    const { deps, sweep, queue, sweepExpiredLeases, listQueuedAttempts, requeueAttempt } = setup();
    const expired = ref(1, 2);
    const queued = ref(0, 0);
    sweep.expired = [expired];
    // (a) で queued に戻したものは (b) にも出る
    sweep.queued = [expired, queued];

    await expectJson(await sweepCall(deps).response, 200, { requeued: 2 });
    expect(sweepExpiredLeases).toHaveBeenCalledWith({ limit: SWEEP_LIMIT });
    expect(listQueuedAttempts).toHaveBeenCalledWith({ limit: SWEEP_LIMIT });
    // lease の切れた段階は claim で世代が進んでいる（落ちた task の名前は claim の前の世代）ので、そのまま積む
    expect(requeueAttempt).toHaveBeenCalledTimes(1);
    expect(requeueAttempt).toHaveBeenCalledWith(queued);
    expect((queue as MemoryTaskQueue).drain()).toEqual([
      { name: taskName(expired.runId, 1, 2), runId: expired.runId, stepIndex: 1 },
      { name: taskName(queued.runId, 0, 1), runId: queued.runId, stepIndex: 0 },
    ]);
  });

  it("requeues a step whose task used up its retries, under a name the deleted task does not hold", async () => {
    // 5 回の配信を使い切った task は Cloud Tasks から消えるが、その名前（<run>-<段階>-0）は最大 24 時間ふさがる。
    // 同じ名前で積み直すと ALREADY_EXISTS が返り、消えた task と生きている task の区別がつかない（段階が 24 時間止まる）。
    const { deps, sweep, queue, requeueAttempt } = setup();
    const stranded = ref(0, 0);
    sweep.queued = [stranded];
    // 消えた task の名前は、まだキューが覚えている（同じ名前なら重複として拒まれる）
    await queue.enqueue({ name: taskName(stranded.runId, 0, 0), runId: stranded.runId, stepIndex: 0 });
    (queue as MemoryTaskQueue).drain();

    await expectJson(await sweepCall(deps).response, 200, { requeued: 1 });
    expect(requeueAttempt).toHaveBeenCalledWith(stranded);
    // 消えた名前ではなく、世代を進めた新しい名前で積まれる（＝この回で拾い直せている）
    expect((queue as MemoryTaskQueue).drain()).toEqual([{ name: taskName(stranded.runId, 0, 1), runId: stranded.runId, stepIndex: 0 }]);
  });

  it("does not enqueue a queued step that stopped being queued while the sweep was reading", async () => {
    const { deps, sweep, queue } = setup();
    const taken = ref(0, 0);
    const still = ref(1, 0);
    sweep.queued = [taken, still];
    sweep.claimed = [taken.runId];

    await expectJson(await sweepCall(deps).response, 200, { requeued: 1 });
    expect((queue as MemoryTaskQueue).drain()).toEqual([{ name: taskName(still.runId, 1, 1), runId: still.runId, stepIndex: 1 }]);
  });

  it("reads the queued steps page by page, so old ones that stay queued do not hide the newer ones", async () => {
    const { deps, sweep, queue, listQueuedAttempts } = setup();
    const older = Array.from({ length: SWEEP_LIMIT }, (_, index) => ref(index % 3, 0));
    const newer = [ref(0, 0), ref(1, 4), ref(2, 0)];
    sweep.queued = [...older, ...newer];

    await expectJson(await sweepCall(deps).response, 200, { requeued: SWEEP_LIMIT + newer.length });
    expect(listQueuedAttempts).toHaveBeenCalledTimes(2);
    expect(listQueuedAttempts).toHaveBeenNthCalledWith(1, { limit: SWEEP_LIMIT });
    expect(listQueuedAttempts).toHaveBeenNthCalledWith(2, { limit: SWEEP_LIMIT, after: { runId: older[SWEEP_LIMIT - 1]!.runId, stepIndex: older[SWEEP_LIMIT - 1]!.stepIndex } });
    // 後ろの 3 件にも届いている（古い分が queued のまま残っても隠れない）
    const enqueued = (queue as MemoryTaskQueue).drain();
    expect(enqueued).toHaveLength(SWEEP_LIMIT + newer.length);
    expect(enqueued.slice(-newer.length)).toEqual(newer.map((item) => ({ name: taskName(item.runId, item.stepIndex, item.generation + 1), runId: item.runId, stepIndex: item.stepIndex })));
  });

  it("stops reading after SWEEP_MAX_PAGES pages and says so", async () => {
    const { deps, sweep, listQueuedAttempts } = setup();
    sweep.queued = Array.from({ length: SWEEP_LIMIT * (SWEEP_MAX_PAGES + 1) }, (_, index) => ref(index % 3, 0));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await sweepCall(deps).response;
    expect(listQueuedAttempts).toHaveBeenCalledTimes(SWEEP_MAX_PAGES);
    expect(warn).toHaveBeenCalledWith("editor-web: sweep read only the oldest queued steps", { route: "POST /api/internal/steps/sweep", read: SWEEP_LIMIT * SWEEP_MAX_PAGES });
    warn.mockRestore();
  });

  it("does not read the body", async () => {
    const { deps } = setup();
    const call = sweepCall(deps, { runId: randomUUID(), stepIndex: 0 });
    await expectJson(await call.response, 200, { requeued: 0 });
    expect(call.request.bodyUsed).toBe(false);
    expect(call.pulls.count).toBe(0);
  });

  it("never asks Cloud Tasks for a name it has already used, so ALREADY_EXISTS cannot hide a deleted task", async () => {
    // 本物のキューで、一度使った名前は（消えたあとでも）ALREADY_EXISTS を返す Cloud Tasks を模す
    const created = new Set<string>();
    const refused: string[] = [];
    const google = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (String(input) === METADATA_TOKEN_URL) return Response.json({ access_token: "synthetic-access-token", expires_in: 3599 });
      const name = (JSON.parse(String(init.body)) as { task: { name: string } }).task.name;
      if (created.has(name)) {
        refused.push(name);
        return Response.json({ error: { code: 409, status: "ALREADY_EXISTS", message: "synthetic" } }, { status: 409 });
      }
      created.add(name);
      return Response.json({ name });
    }) as unknown as typeof fetch;
    const queue = new CloudTasksQueue(CONFIG, { fetch: google });
    const { deps, sweep } = setup({ queue });
    const attempts = [ref(0, 0), ref(1, 0), ref(0, 3)];
    sweep.queued = attempts;
    // 掃除のたびに世代が進むので、毎回ぜんぶ新しい名前で積める（止まらない）
    await expectJson(await sweepCall(deps).response, 200, { requeued: 3 });
    sweep.queued = attempts.map((item) => ({ ...item, generation: item.generation + 1 }));
    await expectJson(await sweepCall(deps).response, 200, { requeued: 3 });
    expect(created.size).toBe(6);
    expect(refused).toEqual([]);
  });

  it("keeps requeueing the rest when one fails, then answers 500 with a short code in the log", async () => {
    const enqueued: string[] = [];
    const flaky: TaskQueue = {
      enqueue: async (task) => {
        if (task.stepIndex === 1) throw Object.assign(new Error("cloud tasks: tasks_http_503"), { code: "tasks_http_503" });
        enqueued.push(task.name);
        return { deduplicated: false };
      },
    };
    const { deps, sweep } = setup({ queue: flaky });
    const items = [ref(0, 0), ref(1, 0), ref(2, 0)];
    sweep.queued = items;
    await expectJson(await sweepCall(deps).response, 500, { error: "internal" });
    expect(enqueued).toEqual([taskName(items[0]!.runId, 0, 1), taskName(items[2]!.runId, 2, 1)]);
    expect(logged()).toContain("tasks_http_503");
    for (const item of items) expect(logged()).not.toContain(item.runId);
  });

  it("answers 500 when the database fails", async () => {
    const { deps, sweepExpiredLeases } = setup();
    sweepExpiredLeases.mockRejectedValueOnce(Object.assign(new Error("synthetic outage leak-check"), { code: "57P01" }));
    await expectJson(await sweepCall(deps).response, 500, { error: "internal" });
    expect(logged()).not.toContain("leak-check");
  });
});
