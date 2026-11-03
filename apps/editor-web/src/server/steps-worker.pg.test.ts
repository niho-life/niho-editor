import { randomUUID } from "node:crypto";
import { EditorStore, seedRecipes } from "@niho/editor-store";
import { applyMigrations } from "@niho/editor-store/migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "../auth/types";
import { CLOUD_TASKS_ORIGIN, CloudTasksQueue, METADATA_TOKEN_URL, WORKER_RUN_PATH, type CloudTasksConfig } from "../steps/cloud-tasks";
import { fakeExecutor } from "../steps/executor";
import { taskName } from "../steps/queue";
import { DEFAULT_RECIPES, toRecipeInputs } from "../steps/recipes";
import { pgStepRunStore, pgStepSweepStore } from "../steps/store";
import type { OidcVerifyResult } from "./google-oidc";
import { createStepRun, type StepsApiDeps } from "./steps-api";
import { runStepTask, sweepStepTasks, type StepsWorkerDeps } from "./steps-worker-api";

// 受付 → Cloud Tasks（偽物の fetch）→ worker の route → 次の段階の積み込み → 最後まで、を実 PostgreSQL で通す。
// 掃除が、失われた task と lease の切れた段階を同じ名前の規則で積み直すことも確かめる。TEST_DATABASE_URL が無ければ skip。
const databaseUrl = process.env.TEST_DATABASE_URL;
const OWNER = "synthetic-owner-a";
const ORIGIN = "http://editor.test";
const CONFIG: CloudTasksConfig = {
  queue: "projects/synthetic-project/locations/asia-northeast1/queues/synthetic-queue",
  workerUrl: "https://worker.example.test",
  invokerServiceAccount: "synthetic-tasks@synthetic-project.iam.gserviceaccount.com",
};
const ENV = {
  EDITOR_STEPS_MODE: "cloud-tasks",
  EDITOR_STEPS_QUEUE: CONFIG.queue,
  EDITOR_STEPS_WORKER_URL: CONFIG.workerUrl,
  EDITOR_STEPS_INVOKER_SA: CONFIG.invokerServiceAccount,
};
const OIDC = "synthetic-oidc-token";
const transcript = [{ type: "paragraph", content: [{ type: "text", text: "合成の座談会の文字起こし" }] }];

type CreatedTask = {
  name: string;
  scheduleTime?: string;
  dispatchDeadline: string;
  httpRequest: { url: string; httpMethod: string; headers: Record<string, string>; body: string; oidcToken: { serviceAccountEmail: string; audience: string } };
};

/** Cloud Tasks の偽物: 名前で重複を拒み（ALREADY_EXISTS）、積まれた task を順に取り出せる。`lose` は task を失わせる（名前も忘れる）。 */
function fakeCloudTasks() {
  const names = new Set<string>();
  let pending: CreatedTask[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    if (url === METADATA_TOKEN_URL) return Response.json({ access_token: "synthetic-access-token", expires_in: 3599 });
    if (url !== `${CLOUD_TASKS_ORIGIN}/v2/${CONFIG.queue}/tasks`) throw new Error("unexpected url");
    const { task } = JSON.parse(String(init.body)) as { task: CreatedTask };
    if (names.has(task.name)) return Response.json({ error: { code: 409, status: "ALREADY_EXISTS", message: "synthetic" } }, { status: 409 });
    names.add(task.name);
    pending.push(task);
    return Response.json({ name: task.name });
  });
  return {
    fetch: fetchFn as unknown as typeof fetch,
    take(): CreatedTask[] {
      const tasks = pending;
      pending = [];
      return tasks;
    },
    lose(task: CreatedTask) {
      names.delete(task.name);
    },
  };
}

const shortName = (task: CreatedTask) => task.name.slice(`${CONFIG.queue}/tasks/`.length);

const authAs = (userId: string): AuthProvider => ({
  mode: "stub",
  getSession: async () => ({ userId, mode: "stub" }),
  beginLogin: async () => new Response(null, { status: 500 }),
  completeLogin: async () => new Response(null, { status: 500 }),
  logout: async () => new Response(null, { status: 500 }),
});

describe.skipIf(databaseUrl === undefined)("Cloud Tasks worker with PostgreSQL", () => {
  const schema = `editor_steps_worker_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
      await seedRecipes(client, OWNER, toRecipeInputs(DEFAULT_RECIPES));
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  function wire() {
    const tasks = fakeCloudTasks();
    const queue = new CloudTasksQueue(CONFIG, { fetch: tasks.fetch });
    const api: StepsApiDeps = { auth: () => authAs(OWNER), steps: () => pgStepRunStore(pool), recipes: () => async () => DEFAULT_RECIPES, queue: () => queue, env: ENV };
    // 検証器は偽物（トークンの検証そのものは google-oidc.test.ts）。期待値が設定のとおりかだけを見る
    const verify = async (token: string, expected: { audience: string; allowedEmail: string }): Promise<OidcVerifyResult> =>
      token === OIDC && expected.audience === CONFIG.workerUrl && expected.allowedEmail === CONFIG.invokerServiceAccount ? { ok: true } : { ok: false, code: "bad_signature" };
    const worker: StepsWorkerDeps = {
      config: () => CONFIG,
      verify,
      steps: () => ({ ...pgStepRunStore(pool), ...pgStepSweepStore(pool) }),
      queue: () => queue,
      executor: () => fakeExecutor,
    };
    /** Cloud Tasks が task を届ける（task の URL・本文・OIDC トークンで worker の route を呼ぶ）。 */
    const deliver = async (task: CreatedTask) => {
      expect(task.httpRequest.url).toBe(`${CONFIG.workerUrl}${WORKER_RUN_PATH}`);
      expect(task.httpRequest.oidcToken).toEqual({ serviceAccountEmail: CONFIG.invokerServiceAccount, audience: CONFIG.workerUrl });
      const response = await runStepTask(
        new Request(task.httpRequest.url, {
          method: task.httpRequest.httpMethod,
          headers: { ...task.httpRequest.headers, authorization: `Bearer ${OIDC}` },
          body: Buffer.from(task.httpRequest.body, "base64").toString("utf8"),
        }),
        worker,
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { status: string }).status;
    };
    const sweep = async () => {
      const response = await sweepStepTasks(new Request(`${CONFIG.workerUrl}/api/internal/steps/sweep`, { method: "POST", headers: { authorization: `Bearer ${OIDC}` } }), worker);
      expect(response.status).toBe(200);
      return ((await response.json()) as { requeued: number }).requeued;
    };
    const start = async (recipe: "tpl-1" | "tpl-2") => {
      const parent = (await new EditorStore(pool).createPage(OWNER, { kind: "rec", blocks: transcript })).id;
      const response = await createStepRun(
        new Request(`${ORIGIN}/api/pages/${parent}/steps/runs`, {
          method: "POST",
          headers: { host: "editor.test", origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ recipe }),
        }),
        parent,
        api,
      );
      expect(response.status).toBe(202);
      const { run } = (await response.json()) as { run: { id: string } };
      return { parent, runId: run.id };
    };
    const view = async (parent: string) => (await pgStepRunStore(pool).listRun(OWNER, parent))?.run;
    return { tasks, deliver, sweep, start, view };
  }

  it("runs tpl-1 from the request through Cloud Tasks and the worker route to the end", async () => {
    const { tasks, deliver, sweep, start, view } = wire();
    const { parent, runId } = await start("tpl-1");
    const statuses: string[] = [];
    const names: string[] = [];
    for (let batch = tasks.take(); batch.length > 0; batch = tasks.take()) {
      for (const task of batch) {
        names.push(shortName(task));
        statuses.push(await deliver(task));
      }
    }
    expect(names).toEqual([taskName(runId, 0, 0), taskName(runId, 1, 0), taskName(runId, 2, 0)]);
    expect(statuses).toEqual(["completed", "completed", "completed"]);
    const done = await view(parent);
    expect(done?.state).toBe("succeeded");
    expect(done?.steps.map((step) => [step.state, step.stepStatus])).toEqual([
      ["succeeded", "done"],
      ["succeeded", "done"],
      ["succeeded", "done"],
    ]);
    // 終わった run には掃除が積むものは無い
    expect(await sweep()).toBe(0);
    expect(tasks.take()).toEqual([]);
  });

  it("requeues a lost task and an expired lease from the sweep, under names no deleted task holds, and finishes the run", async () => {
    const { tasks, deliver, sweep, start, view } = wire();
    const { parent, runId } = await start("tpl-2");

    // 積んだ task が失われた（再試行を使い切って消えた・積み込みのあとに消えた）。消えた名前（世代 0）は Cloud Tasks が
    // 最大 24 時間ふさぐので、掃除は世代を 1 つ進めた名前で積み直す
    const [first] = tasks.take();
    expect(first && shortName(first)).toBe(taskName(runId, 0, 0));
    tasks.lose(first!);
    expect(await sweep()).toBe(1);
    const [again] = tasks.take();
    expect(again && shortName(again)).toBe(taskName(runId, 0, 1));
    // まだ積まれている間に掃除が重なると、さらに進めた名前でもう 1 つ積まれる（消えた task と区別できないので、
    // 名前の重複には頼らない）。二重に実行はされない: 先に届いた方が claim し、後の方は何もしない
    expect(await sweep()).toBe(1);
    const [duplicate] = tasks.take();
    expect(duplicate && shortName(duplicate)).toBe(taskName(runId, 0, 2));
    expect(await deliver(again!)).toBe("completed");
    expect(await deliver(duplicate!)).toBe("skipped");

    // 次の段階を実行していた worker が落ちた（claim したまま lease が切れた）: claim で世代が進んでいるので、
    // 掃除はその世代のまま積み直す（落ちた task の名前は claim の前の世代なので、ぶつからない）
    const [second] = tasks.take();
    expect(second && shortName(second)).toBe(taskName(runId, 1, 0));
    const claimed = await pgStepRunStore(pool).claimAttempt(runId, 1);
    expect(claimed.ok).toBe(true);
    await pool.query("UPDATE step_attempts SET lease_until = clock_timestamp() - interval '1 second' WHERE run_id = $1 AND state = 'running'", [runId]);
    // 落ちた worker の task が再配信されても、実行中なので二重に実行しない
    expect(await deliver(second!)).toBe("skipped");
    expect(await sweep()).toBe(1);
    const [requeued] = tasks.take();
    expect(requeued && shortName(requeued)).toBe(taskName(runId, 1, 1));
    expect(await deliver(requeued!)).toBe("completed");
    expect(tasks.take()).toEqual([]);

    const done = await view(parent);
    expect(done?.state).toBe("succeeded");
    expect(done?.steps.map((step) => [step.state, step.stepStatus, step.tries])).toEqual([
      ["succeeded", "done", 1],
      ["succeeded", "done", 2],
    ]);
  });
});
