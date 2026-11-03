import "server-only";
import { getAiUsage, getEditorSettings, listReferencePages, recordAiUsage } from "@niho/editor-store";
import { monthlyLimitUsd, resolveAiCompose } from "../ai/config";
import { getAuthProvider } from "../auth";
import { createAiStepExecutor } from "../steps/ai-executor";
import { CloudTasksQueue, resolveCloudTasksConfig, type CloudTasksConfig } from "../steps/cloud-tasks";
import type { StepExecutor } from "../steps/executor";
import { createInlineQueue, resolveStepsMode } from "../steps/inline";
import type { TaskQueue } from "../steps/queue";
import type { RecipeReader } from "../steps/recipes";
import { pgStepRunStore, pgStepSweepStore } from "../steps/store";
import { getPool } from "./db";
import { verifyGoogleOidc } from "./google-oidc";
import { ownerRecipes as readOwnerRecipes } from "./recipe-source";
import type { StepsApiDeps } from "./steps-api";
import type { StepsWorkerDeps } from "./steps-worker-api";

/**
 * 段階の実行器（本物。#38 の AI を包んだ ai-executor.ts）。AI・DB・上限は要求のたびに遅延して読む
 * （`EDITOR_AI_MODE` が無効なら段階は `ai_unavailable`、DB が無ければ `usage_unavailable` で失敗する）。
 * 開発と CI の `EDITOR_AI_MODE=fake` では偽物の 1 往復（`[fake]` の印が付く）。
 */
const aiStepExecutor: StepExecutor = createAiStepExecutor({
  compose: () => resolveAiCompose(process.env),
  usage: () => {
    const pool = getPool();
    return pool
      ? {
          get: (owner, month, source) => getAiUsage(pool, owner, month, source),
          record: (owner, month, delta, source) => recordAiUsage(pool, owner, month, delta, source),
        }
      : null;
  },
  limitUsd: () => monthlyLimitUsd(process.env),
  settings: () => {
    const pool = getPool();
    return pool ? (owner) => getEditorSettings(pool, owner) : null;
  },
  references: () => {
    const pool = getPool();
    return pool ? (owner, pageId) => listReferencePages(pool, owner, pageId) : null;
  },
});

/**
 * 段階の実行器を返す、ただ 1 か所。**偽物（`fakeExecutor`）に戻さないこと。**
 * 戻すと本番で `[fake]` の印の付いた文書がページに書かれる（偽物の結果を利用者に見せない、が設計の約束）。
 * この約束は `steps-deps.test.ts` が守っている（偽物に差し替えると CI が落ちる）。
 */
export function stepExecutor(): StepExecutor {
  return aiStepExecutor;
}

/** その人の手順（表 `recipes`。無ければ既定を写して入れる。#37・#108）。DB が無ければ null。 */
function ownerRecipes(): RecipeReader | null {
  const pool = getPool();
  if (!pool) return null;
  return (owner) => readOwnerRecipes(pool, owner);
}

// inline のキューは Pool ごとに 1 つ（積んだ名前の重複の除去を要求の間で共有する）
let inline: { pool: object; queue: TaskQueue } | undefined;
// Cloud Tasks のキューは設定ごとに 1 つ（メタデータサーバーのアクセストークンを要求の間で使い回す）
let cloudTasks: { key: string; queue: TaskQueue } | undefined;

function cloudTasksQueue(config: CloudTasksConfig): TaskQueue {
  const key = `${config.queue}\n${config.workerUrl}\n${config.invokerServiceAccount}`;
  if (cloudTasks?.key !== key) cloudTasks = { key, queue: new CloudTasksQueue(config) };
  return cloudTasks.queue;
}

/** `/api/pages/{id}/steps/**` の実行時の依存（DB の接続・方式は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const stepsDeps: StepsApiDeps = {
  auth: () => getAuthProvider(),
  steps: () => {
    const pool = getPool();
    return pool ? pgStepRunStore(pool) : null;
  },
  recipes: ownerRecipes,
  queue: () => {
    const mode = resolveStepsMode(process.env);
    if (mode === "cloud-tasks") {
      const config = resolveCloudTasksConfig(process.env);
      return config ? cloudTasksQueue(config) : null;
    }
    if (mode !== "inline") return null;
    const pool = getPool();
    if (!pool) return null;
    if (inline?.pool !== pool) {
      inline = { pool, queue: createInlineQueue({ store: pgStepRunStore(pool), executor: stepExecutor() }) };
    }
    return inline.queue;
  },
};

/** `/api/internal/steps/**`（worker の route）の実行時の依存。方式が cloud-tasks のときだけ開く。 */
export const stepsWorkerDeps: StepsWorkerDeps = {
  config: () => (resolveStepsMode(process.env) === "cloud-tasks" ? resolveCloudTasksConfig(process.env) : null),
  verify: (token, expected) => verifyGoogleOidc(token, expected),
  steps: () => {
    const pool = getPool();
    return pool ? { ...pgStepRunStore(pool), ...pgStepSweepStore(pool) } : null;
  },
  queue: (config) => cloudTasksQueue(config),
  executor: stepExecutor,
};
