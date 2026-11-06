import { MAX_CONTINUATIONS } from "@niho/docs-core";
import { describe, expect, it, vi } from "vitest";
import type { AiUsageDelta, AiUsageTotals, Block, OwnerId } from "@niho/editor-store";
import { AnthropicError, type AnthropicClient } from "../ai/anthropic";
import type { AiComposeBackend } from "../ai/config";
import { StepError } from "./executor";
import { createAiStepExecutor, type AiStepExecutorDeps, type StepUsageStore } from "./ai-executor";
import { DEFAULT_RECIPES, findRecipeIn } from "./recipes";

// 合成の値だけを使う（本物のモデルは呼ばない）
const OWNER: OwnerId = "synthetic-owner-a";
const MONTH = "2026-11";
const now = () => new Date("2026-11-01T10:00:00+09:00");
const tpl1 = findRecipeIn(DEFAULT_RECIPES, "tpl-1")!;
const transcript: Block[] = [
  { type: "paragraph", content: [{ type: "text", text: "合成の座談会の文字起こし" }] },
  { type: "paragraph", content: [{ type: "text", text: "二つ目の段落" }] },
];

const answer = JSON.stringify({
  blocks: [
    { kind: "heading", level: 2, text: "合成の見出し" },
    { kind: "paragraph", text: "合成の本文" },
  ],
});

/** 送られたプロンプトを覚える偽の往復（段階の実行器は道具を渡さない `converse` を使う）。 */
function stubClient(reply: (round: number) => Promise<{ text: string; stopReason?: string; usage: { model: string; inputTokens: number; outputTokens: number } }>) {
  const calls: { system: string; user: string; messages: unknown[]; maxTokens?: number; thinking?: { type: "adaptive" }; outputConfig?: { effort: "low" | "medium" | "high" } }[] = [];
  const client: AnthropicClient = {
    complete: async () => {
      throw new Error("the step executor uses converse");
    },
    converse: async (input) => {
      const first = input.messages[0] as { content?: unknown } | undefined;
      calls.push({
        system: input.system,
        user: typeof first?.content === "string" ? first.content : "",
        messages: input.messages,
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
        ...(input.thinking ? { thinking: input.thinking } : {}),
        ...(input.outputConfig ? { outputConfig: input.outputConfig } : {}),
      });
      const answer = await reply(calls.length - 1);
      return { text: answer.text, toolCalls: [], stopReason: answer.stopReason ?? "end_turn", usage: answer.usage };
    },
  };
  return { client, calls };
}

function okClient(text = answer) {
  return stubClient(async () => ({ text, usage: { model: "claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 500 } }));
}

/** 使用量を覚えるだけの偽の store。 */
function memoryUsage(start: Partial<AiUsageTotals> = {}): StepUsageStore & { totals: AiUsageTotals; records: AiUsageDelta[] } {
  const totals: AiUsageTotals = { owner: OWNER, month: MONTH, source: "server", requests: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0, ...start };
  const records: AiUsageDelta[] = [];
  return {
    totals,
    records,
    get: async () => totals,
    record: async (_owner, _month, delta) => {
      records.push(delta);
      totals.requests += delta.requests;
      totals.inputTokens += delta.inputTokens;
      totals.outputTokens += delta.outputTokens;
      totals.costMicroUsd += delta.costMicroUsd;
      return totals;
    },
  };
}

function setup(options: {
  client?: AnthropicClient;
  usage?: StepUsageStore | null;
  limitUsd?: number | null;
  provider?: "claude" | null;
  monotonicNowMs?: () => number;
  stepBudgetMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
} = {}) {
  const backend: AiComposeBackend = {
    client: options.client ?? okClient().client,
    model: "claude-sonnet-5-5",
    provider: options.provider === undefined ? "claude" : options.provider,
    route: "server",
    engine: "anthropic:claude-sonnet-5-5",
  };
  const deps: AiStepExecutorDeps = {
    compose: () => backend,
    usage: () => (options.usage === undefined ? memoryUsage() : options.usage),
    limitUsd: () => options.limitUsd ?? null,
    now,
    ...(options.monotonicNowMs ? { monotonicNowMs: options.monotonicNowMs } : {}),
    ...(options.stepBudgetMs === undefined ? {} : { stepBudgetMs: options.stepBudgetMs }),
    env: options.env ?? {},
  };
  return createAiStepExecutor(deps);
}

const input = { recipe: tpl1, stepIndex: 0, owner: OWNER, parentBlocks: transcript, background: "", previousBlocks: null };

describe("the real step executor", () => {
  it("turns the model's output into blocks and reports the usage", async () => {
    const executor = setup();
    const output = await executor.run(input);
    expect(output.blocks).toEqual([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "合成の見出し" }] },
      { type: "paragraph", content: [{ type: "text", text: "合成の本文" }] },
    ]);
    expect(output.usage).toEqual({ inputTokens: 1_000, outputTokens: 500, model: "claude-sonnet-5-5" });
  });

  it("applies the frozen step profile to effort and the bounded output ceiling", async () => {
    const client = okClient();
    const longInput = { ...input, parentBlocks: [{ type: "paragraph", content: [{ type: "text", text: "合".repeat(24_000) }] }] as Block[] };
    const cases = [
      ["light", "low", 32_000],
      ["standard", "medium", 12_000],
      ["advanced", "high", 20_000],
    ] as const;
    for (const [profile, effort, expectedMaxTokens] of cases) {
      const recipe = { ...tpl1, steps: tpl1.steps.map((step, index) => index === 0 ? { ...step, profile } : step) };
      await setup({ client: client.client, env: { EDITOR_AI_MAX_TOKENS: "32000" } }).run({ ...longInput, recipe });
      expect(client.calls.at(-1)).toMatchObject({
        maxTokens: expectedMaxTokens,
        thinking: { type: "adaptive" },
        outputConfig: { effort },
      });
    }
  });

  it("reports the used input chars only when the sources were cut at the 100,000-character limit (#277)", async () => {
    const paragraphOf = (text: string) => [{ type: "paragraph", content: [{ type: "text", text }] }] as Block[];
    const whole = await setup().run({ ...input, parentBlocks: paragraphOf("合".repeat(100_000)) });
    expect(whole.inputUsedChars).toBeUndefined();
    expect("inputUsedChars" in (await setup().run(input))).toBe(false);

    const client = okClient();
    const cut = await setup({ client: client.client }).run({ ...input, parentBlocks: paragraphOf("合".repeat(100_500)) });
    expect(cut.inputUsedChars).toBe(100_000);
    expect(client.calls[0]!.user).toContain("### 録音ページの本文（長いので先頭だけ）");
  });

  it("sends the source and every earlier result in order", async () => {
    const first = okClient();
    await setup({ client: first.client }).run(input);
    expect(first.calls[0]!.user).toContain(`手順「${tpl1.name}」の段階 1/${tpl1.steps.length}「${tpl1.steps[0]!.name}」`);
    expect(first.calls[0]!.user).toContain("合成の座談会の文字起こし\n\n二つ目の段落");
    expect(first.calls[0]!.user).not.toContain("背景情報（この録音について）");

    const second = okClient();
    await setup({ client: second.client }).run({
      ...input,
      stepIndex: 1,
      previousBlocks: [{ type: "paragraph", content: [{ type: "text", text: "段階 1 の結果" }] }],
    });
    expect(second.calls[0]!.user).toContain("### 工程 1 の結果");
    expect(second.calls[0]!.user).toContain("段階 1 の結果");
    expect(second.calls[0]!.user).toContain("合成の座談会の文字起こし");
  });

  it("uses the captured recording fields, settings and stable reference labels", async () => {
    const call = okClient();
    const prior = (text: string): Block[] => [{ type: "paragraph", content: [{ type: "text", text }] }];
    await setup({ client: call.client }).run({
      ...input,
      stepIndex: 2,
      background: "合成の録音の背景",
      previousBlocks: prior("二番目"),
      materials: {
        parentBlocks: transcript,
        background: "合成の録音の背景",
        upstream: [{ id: tpl1.steps[0]!.id, blocks: prior("一番目") }, { id: tpl1.steps[1]!.id, blocks: prior("二番目") }],
        refs: [{ id: "synthetic-ref", blocks: prior("参考の本文"), title: "変更される題名" }],
        fields: { entities: [{ name: "合成人物", reading: "ごうせい", role: "取材相手", note: "" }], terms: [{ term: "合成語", reading: "", variants: [], note: "" }] },
        settings: { aiLang: "en", glossary: [], aboutName: "合成の筆者", about: "合成の説明" },
      },
    });
    const prompt = call.calls[0]!.user;
    expect(prompt.indexOf("合成の座談会の文字起こし")).toBeLessThan(prompt.indexOf("一番目"));
    expect(prompt.indexOf("一番目")).toBeLessThan(prompt.indexOf("二番目"));
    expect(prompt).toContain("### 参考 1");
    expect(prompt).not.toContain("変更される題名");
    expect(prompt).toContain("合成人物");
    expect(prompt).toContain("合成語");
    expect(prompt).toContain("出力の言語: en");
    expect(prompt).toContain("合成の筆者");
    expect(prompt).toContain("## 背景情報（この録音について）\n<untrusted_data>\n合成の録音の背景\n</untrusted_data>");
  });

  it("records the estimated cost of the call", async () => {
    const usage = memoryUsage();
    await setup({ usage }).run(input);
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]!.requests).toBe(1);
    expect(usage.records[0]!.inputTokens).toBe(1_000);
    // claude-sonnet-5-5: 入力 $2・出力 $10／100 万トークン → 0.002 + 0.005 USD
    expect(usage.records[0]!.costMicroUsd).toBe(7_000);
  });

  it("counts nothing when the model is the fake one (no price list)", async () => {
    const usage = memoryUsage();
    await setup({ usage, provider: null }).run(input);
    expect(usage.records[0]!.costMicroUsd).toBe(0);
  });

  it("stops before calling the model when this month is at or over the limit", async () => {
    const client = okClient();
    const usage = memoryUsage({ costMicroUsd: 10_000_000 });
    const executor = setup({ client: client.client, usage, limitUsd: 10 });
    await expect(executor.run(input)).rejects.toMatchObject({ name: "StepError", code: "quota_exceeded", retryable: false });
    expect(client.calls).toHaveLength(0);
    expect(usage.records).toHaveLength(0);
  });

  it("still calls the model just under the limit", async () => {
    const usage = memoryUsage({ costMicroUsd: 9_999_999 });
    await expect(setup({ usage, limitUsd: 10 }).run(input)).resolves.toMatchObject({ usage: { model: "claude-sonnet-5-5" } });
  });

  it("fails without calling the model when the AI is off or the usage cannot be counted", async () => {
    const executor = createAiStepExecutor({ compose: () => null, usage: () => memoryUsage(), limitUsd: () => null, now, env: {} });
    await expect(executor.run(input)).rejects.toMatchObject({ code: "ai_unavailable", retryable: false });

    const noDb = setup({ usage: null });
    await expect(noDb.run(input)).rejects.toMatchObject({ code: "usage_unavailable", retryable: true });

    // 持ち主が分からない要求（runner は claim の owner を渡す）でもモデルを呼ばない
    const client = okClient();
    await expect(setup({ client: client.client }).run({ ...input, owner: undefined })).rejects.toMatchObject({ code: "usage_unavailable" });
    expect(client.calls).toHaveLength(0);
  });

  it("maps the upstream failure to a short code and keeps the retryable ones retryable", async () => {
    const cases = [
      ["auth", "ai_auth", false],
      ["rate_limit", "ai_rate_limit", true],
      ["overloaded", "ai_overloaded", true],
      ["server", "ai_server", true],
      ["timeout", "ai_timeout", true],
      ["network", "ai_network", true],
      ["bad_request", "ai_bad_request", false],
      ["invalid_output", "invalid_output", false],
    ] as const;
    for (const [kind, code, retryable] of cases) {
      const client = stubClient(async () => {
        throw new AnthropicError(kind);
      });
      await expect(setup({ client: client.client }).run(input)).rejects.toMatchObject({ code, retryable });
    }
  });

  it("records the tokens of a call that answered but could not be used", async () => {
    const usage = memoryUsage();
    const client = stubClient(async () => {
      throw new AnthropicError("invalid_output", { reason: "max_tokens", usage: { model: "claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 12_000 } });
    });
    await expect(setup({ client: client.client, usage }).run(input)).rejects.toMatchObject({ code: "invalid_output" });
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]!.outputTokens).toBe(12_000);
  });

  it("refuses output that is not the documented JSON, and says nothing about its content", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const text of ["これは JSON ではありません", "{}", JSON.stringify({ blocks: [{ kind: "image", text: "x" }] }), JSON.stringify({ blocks: [] })]) {
        const usage = memoryUsage();
        await expect(setup({ client: okClient(text).client, usage }).run(input)).rejects.toMatchObject({ code: "invalid_output", retryable: false });
        // 呼んだ分は数える
        expect(usage.records).toHaveLength(1);
      }
      for (const call of logged.mock.calls) expect(JSON.stringify(call)).not.toContain("これは JSON ではありません");
    } finally {
      logged.mockRestore();
    }
  });

  it("accepts output wrapped in a code fence", async () => {
    const fenced = "```json\n" + answer + "\n```";
    await expect(setup({ client: okClient(fenced).client }).run(input)).resolves.toMatchObject({ usage: { model: "claude-sonnet-5-5" } });
  });

  it("fails for a step the recipe does not have, before anything else", async () => {
    const client = okClient();
    await expect(setup({ client: client.client }).run({ ...input, stepIndex: 99 })).rejects.toMatchObject({ code: "unknown_step", retryable: false });
    expect(client.calls).toHaveLength(0);
  });

  it("stops on the signal of the caller (the lease was lost)", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = okClient();
    await expect(setup({ client: client.client }).run({ ...input, signal: controller.signal })).rejects.toThrow();
    expect(client.calls).toHaveLength(0);
  });

  it("asks the settings for the glossary and the language", async () => {
    const client = okClient();
    const executor = createAiStepExecutor({
      compose: () => ({ client: client.client, model: "claude-sonnet-5-5", provider: "claude", route: "server", engine: "anthropic:claude-sonnet-5-5" }),
      usage: () => memoryUsage(),
      limitUsd: () => null,
      settings: () => async () => ({ aiLang: "en", glossary: [{ term: "NIHO", reading: "ニホ", variants: [], note: "" }], recipes: [], aboutName: "", about: "", webSearch: true }),
      now,
      env: {},
    });
    await executor.run(input);
    expect(client.calls[0]!.user).toContain("出力の言語: en");
    expect(client.calls[0]!.user).toContain("NIHO");
  });

  it("sends 「あなたについて」 and the other pages of the folder", async () => {
    const client = okClient();
    const executor = createAiStepExecutor({
      compose: () => ({ client: client.client, model: "claude-sonnet-5-5", provider: "claude", route: "server", engine: "anthropic:claude-sonnet-5-5" }),
      usage: () => memoryUsage(),
      limitUsd: () => null,
      settings: () => async () => ({ aiLang: "same", glossary: [], recipes: [], aboutName: "合成の呼び名", about: "合成の自己紹介です。", webSearch: true }),
      references: () => async () => [
        { id: "ref-1", title: "同じフォルダのページ", kind: "note", blocks: [{ type: "paragraph", content: [{ type: "text", text: "参考の本文" }] }] },
      ],
      now,
      env: {},
    });
    await executor.run({ ...input, parentPageId: "00000000-0000-4000-8000-0000000000aa" });
    expect(client.calls[0]!.user).toContain("## あなたについて");
    expect(client.calls[0]!.user).toContain("呼び名: 合成の呼び名");
    expect(client.calls[0]!.user).toContain("合成の自己紹介です。");
    expect(client.calls[0]!.user).toContain("## 参考（同じフォルダのほかのページ）");
    expect(client.calls[0]!.user).toContain("参考の本文");
  });

  it("runs without them when the settings and the folder cannot be read", async () => {
    const client = okClient();
    await setup({ client: client.client }).run(input);
    expect(client.calls[0]!.user).not.toContain("## あなたについて");
    expect(client.calls[0]!.user).not.toContain("## 参考");
  });

  it("asks for the rest when the answer was cut by the output limit, and joins it", async () => {
    // 1 通目は途中で切れ、2 通目が続きを書く（重なりは docs-core の規則で除く）
    const head = '{"blocks":[{"kind":"heading","level":2,"text":"合成の見出し"},{"kind":"para';
    const tail = 'graph","text":"合成の本文"}]}';
    const usage = memoryUsage();
    const client = stubClient(async (round) =>
      round === 0
        ? { text: head, stopReason: "max_tokens", usage: { model: "claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 500 } }
        : { text: tail, usage: { model: "claude-sonnet-5-5", inputTokens: 1_200, outputTokens: 100 } },
    );
    const output = await setup({ client: client.client, usage }).run(input);
    expect(output.blocks).toEqual([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "合成の見出し" }] },
      { type: "paragraph", content: [{ type: "text", text: "合成の本文" }] },
    ]);
    // 2 通目には、ここまでの答えを assistant の書きかけとして渡す
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]!.messages[1]).toEqual({ role: "assistant", content: head });
    // どちらの呼び出しも使用量に数え、帯に出す数は合計
    expect(usage.records).toHaveLength(2);
    expect(output.usage).toEqual({ inputTokens: 2_200, outputTokens: 600, model: "claude-sonnet-5-5" });
  });

  it("removes what the continuation repeats", async () => {
    const head = '{"blocks":[{"kind":"paragraph","text":"合成の本文です。つづき';
    const client = stubClient(async (round) =>
      round === 0
        ? { text: head, stopReason: "max_tokens", usage: { model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 10 } }
        : { text: 'です。つづきの文です。"}]}', usage: { model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 10 } },
    );
    const output = await setup({ client: client.client }).run(input);
    expect(output.blocks).toEqual([{ type: "paragraph", content: [{ type: "text", text: "合成の本文です。つづきの文です。" }] }]);
  });

  it("gives up after the documented number of continuations, and writes nothing", async () => {
    const usage = memoryUsage();
    const client = stubClient(async () => ({ text: '{"blocks":[{"kind":"paragraph","text":"長い', stopReason: "max_tokens", usage: { model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 10 } }));
    await expect(setup({ client: client.client, usage }).run(input)).rejects.toMatchObject({ code: "output_too_long", retryable: false });
    // 1 回目 + 続き 8 回
    expect(client.calls).toHaveLength(MAX_CONTINUATIONS + 1);
    expect(usage.records).toHaveLength(MAX_CONTINUATIONS + 1);
  });

  it("carries the text it did write when it gives up (to show, never to write to the page)", async () => {
    const written = '{"blocks":[{"kind":"heading","level":2,"text":"書けた見出し"},{"kind":"paragraph","text":"書けた段落。"},{"kind":"paragraph","text":"切れた';
    const client = stubClient(async (round) =>
      round === 0
        ? { text: written, stopReason: "max_tokens", usage: { model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 10 } }
        : { text: "段", stopReason: "max_tokens", usage: { model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 10 } },
    );
    const error = await setup({ client: client.client })
      .run(input)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(StepError);
    expect((error as StepError).code).toBe("output_too_long");
    // 書けた分だけ（切れた段落は入らない）。サブページの本文に書く道はここには無い
    expect((error as StepError).partial).toEqual([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "書けた見出し" }] },
      { type: "paragraph", content: [{ type: "text", text: "書けた段落。" }] },
    ]);
    // 失敗の文そのものには本文を入れない（ログに流れるのは message と code）
    expect((error as Error).message).toBe("step failed: output_too_long");
    expect((error as Error).message).not.toContain("書けた");
  });

  it("stops before a continuation can overrun the task deadline and keeps parsed partial blocks", async () => {
    let elapsed = 0;
    const written = '{"blocks":[{"kind":"heading","level":2,"text":"途中まで"},{"kind":"paragraph","text":"続き';
    const client = stubClient(async () => {
      elapsed = 1_600;
      return { text: written, stopReason: "max_tokens", usage: { model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 10 } };
    });
    const error = await setup({
      client: client.client,
      monotonicNowMs: () => elapsed,
      stepBudgetMs: 2_500,
      env: { EDITOR_AI_TIMEOUT_MS: "1000" },
    }).run(input).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(StepError);
    expect((error as StepError).code).toBe("step_time_limit");
    expect((error as StepError).retryable).toBe(false);
    expect((error as StepError).partial).toEqual([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "途中まで" }] },
    ]);
    expect((error as Error).message).toBe("step failed: step_time_limit");
    expect(client.calls).toHaveLength(1);
  });

  it("has no partial text on the other failures", async () => {
    const client = stubClient(async () => ({ text: "これは JSON ではありません", usage: { model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 10 } }));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = await setup({ client: client.client })
      .run(input)
      .catch((reason: unknown) => reason);
    log.mockRestore();
    expect((error as StepError).code).toBe("invalid_output");
    expect((error as StepError).partial).toBeUndefined();
  });

  it("stops asking for the rest when the month's limit is reached in the middle", async () => {
    const usage = memoryUsage();
    const client = stubClient(async () => ({ text: '{"blocks":[{"kind":"paragraph","text":"長い', stopReason: "max_tokens", usage: { model: "claude-sonnet-5-5", inputTokens: 1_000_000, outputTokens: 1_000_000 } }));
    await expect(setup({ client: client.client, usage, limitUsd: 1 }).run(input)).rejects.toMatchObject({ code: "quota_exceeded", retryable: false });
    // 1 回目は通り、続きの前で止まる
    expect(client.calls).toHaveLength(1);
  });

  it("stops asking when the continuation adds nothing, and still says it was too long", async () => {
    const client = stubClient(async (round) =>
      round === 0
        ? { text: '{"blocks":[{"kind":"paragraph","text":"途中', stopReason: "max_tokens", usage: { model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 10 } }
        : { text: "   ", stopReason: "max_tokens", usage: { model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 10 } },
    );
    await expect(setup({ client: client.client }).run(input)).rejects.toMatchObject({ code: "output_too_long", retryable: false });
    // 同じ要求を繰り返さない（2 回で止める）
    expect(client.calls).toHaveLength(2);
  });

  it("is a StepError for every failure the runner has to classify", async () => {
    const client = stubClient(async () => {
      throw new AnthropicError("server");
    });
    const error = await setup({ client: client.client })
      .run(input)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(StepError);
  });
});

describe("the real step executor with chunks (#277)", () => {
  const chunk = { index: 2, count: 5, text: "合成の区切り 3 の本文", previousTail: "話者A: 合成の前の区切りの終わり" };

  it("replaces only the rewritten source with the chunk and says which chunk it is", async () => {
    const client = okClient();
    await setup({ client: client.client }).run({ ...input, parentBlocks: [{ type: "paragraph", content: [{ type: "text", text: "区切る前の全文" }] }], chunk });
    const user = client.calls[0]!.user;
    expect(user).toContain("### 録音ページの本文（区切り 3/5）");
    expect(user).toContain("合成の区切り 3 の本文");
    expect(user).not.toContain("区切る前の全文");
    expect(user).toContain("全 5 区切りのうちの 3 番目");
    expect(user).toContain("話者A: 合成の前の区切りの終わり");
  });

  it("on a later step, chunks the previous result and keeps the recording as it is", async () => {
    const client = okClient();
    const previous: Block[] = [{ type: "paragraph", content: [{ type: "text", text: "前の段階の全文" }] }];
    await setup({ client: client.client }).run({ ...input, stepIndex: 1, previousBlocks: previous, chunk: { ...chunk, previousTail: "" } });
    const user = client.calls[0]!.user;
    expect(user).toContain("### 録音ページの本文\n");
    expect(user).toContain("合成の座談会の文字起こし");
    expect(user).toContain("### 工程 1 の結果（区切り 3/5）");
    expect(user).not.toContain("前の段階の全文");
    expect(user).not.toContain("前の区切りの出力の末尾");
  });

  it("never cuts the chunk to the shared budget, and reports a cut only when the other sources were cut", async () => {
    const client = okClient();
    const long = (text: string): Block[] => [{ type: "paragraph", content: [{ type: "text", text }] }];
    const longInput = {
      ...input,
      stepIndex: 5,
      recipe: { ...input.recipe, steps: Array.from({ length: 6 }, (_, index) => ({ ...input.recipe.steps[0]!, id: `step${index}0001`, name: `段階 ${index + 1}` })) },
      parentBlocks: long("Ψ".repeat(40_000)),
      previousBlocks: long("Θ".repeat(40_000)),
      materials: undefined,
    };
    const output = await setup({ client: client.client }).run({ ...longInput, chunk: { index: 0, count: 3, text: "Ω".repeat(16_000), previousTail: "" } });
    const user = client.calls[0]!.user;
    expect(Array.from(user).filter((ch) => ch === "Ω")).toHaveLength(16_000);
    expect(user).not.toContain("（区切り 1/3）（長いので先頭だけ）");
    // 原文（40,000 字）は残りの予算に収まっていれば切られず、通知は出ない
    expect(output.inputUsedChars).toBeUndefined();
  });

  it("reports a cut when the other sources only exceed the budget left after the chunk (84,000 chars, not 100,000)", async () => {
    const client = okClient();
    const long = (text: string): Block[] => [{ type: "paragraph", content: [{ type: "text", text }] }];
    // 原文は 90,000 字。区切り（16,000 字）を引いた残り 84,000 字には収まらず切られるが、10 万字の上限だけで見ると収まって見える
    const longInput = { ...input, stepIndex: 5, recipe: { ...input.recipe, steps: Array.from({ length: 6 }, (_, index) => ({ ...input.recipe.steps[0]!, id: `step${index}0001`, name: `段階 ${index + 1}` })) }, parentBlocks: long("Ψ".repeat(90_000)), materials: undefined };
    const output = await setup({ client: client.client }).run({ ...longInput, chunk: { index: 0, count: 3, text: "Ω".repeat(16_000), previousTail: "" } });
    const user = client.calls[0]!.user;
    expect(Array.from(user).filter((ch) => ch === "Ω")).toHaveLength(16_000);
    expect(Array.from(user).filter((ch) => ch === "Ψ")).toHaveLength(84_000);
    expect(output.inputUsedChars).toBe(100_000);
  });

  it("checks this month's limit before each chunk and records the usage of each chunk", async () => {
    const usage = memoryUsage();
    const client = okClient();
    const executor = setup({ client: client.client, usage, limitUsd: 10 });
    await executor.run({ ...input, chunk: { ...chunk, index: 0, previousTail: "" } });
    expect(usage.records).toHaveLength(1);
    // 区切りの途中で上限に達したら、次の区切りの前に止まる（呼ばない）
    usage.totals.costMicroUsd = 10_000_000;
    await expect(executor.run({ ...input, chunk: { ...chunk, index: 1 } })).rejects.toMatchObject({ code: "quota_exceeded", retryable: false });
    expect(client.calls).toHaveLength(1);
  });
});
