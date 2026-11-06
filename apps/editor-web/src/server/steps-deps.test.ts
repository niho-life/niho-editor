import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RECIPES } from "../steps/recipes";
import { fakeExecutor } from "../steps/executor";
import { stepExecutor } from "./steps-deps";
import { stepsWorkerDeps } from "./steps-deps";

/**
 * 段階の実行器が**本物**（`src/steps/ai-executor.ts`）であることを固定する。
 *
 * ここは一度、別のレーンの merge で偽物（`fakeExecutor`）に戻ったことがある。戻ると本番のページに
 * `[fake]` の印の付いた文書が書かれるので、人の記憶ではなく test で止める。
 */

const tpl1 = DEFAULT_RECIPES[0]!;
const input = { recipe: tpl1, stepIndex: 0, owner: "synthetic-owner-a", parentBlocks: [], background: "", previousBlocks: null };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the step executor that steps-deps wires", () => {
  it("is never the fake one", () => {
    expect(stepExecutor()).not.toBe(fakeExecutor);
    expect(stepsWorkerDeps.executor()).not.toBe(fakeExecutor);
    expect(stepsWorkerDeps.executor()).toBe(stepExecutor());
  });

  it("fails instead of writing a fake document when the AI is not configured", async () => {
    // 本番相当（EDITOR_AI_MODE が無い）。偽物なら `[fake]` のブロックを返してしまう
    vi.stubEnv("EDITOR_AI_MODE", "");
    await expect(stepExecutor().run(input)).rejects.toMatchObject({ name: "StepError", code: "ai_unavailable", retryable: false });
    await expect(fakeExecutor.run(input)).resolves.toMatchObject({ usage: { model: "fake" } });
  });

  it("refuses the fake model in production even when the setting asks for it", async () => {
    vi.stubEnv("EDITOR_AI_MODE", "fake");
    vi.stubEnv("NODE_ENV", "production");
    await expect(stepExecutor().run(input)).rejects.toMatchObject({ code: "ai_unavailable" });
  });

  it("needs the usage before it calls a model, so the month's limit cannot be skipped", async () => {
    // 開発・CI の偽物の 1 往復は使えるが、DB が無いので使用量を数えられない＝モデルを呼ばない
    vi.stubEnv("EDITOR_AI_MODE", "fake");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "");
    await expect(stepExecutor().run(input)).rejects.toMatchObject({ code: "usage_unavailable", retryable: true });
  });
});
