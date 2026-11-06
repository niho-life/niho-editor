import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  ANTHROPIC_MESSAGES_URL,
  AnthropicError,
  createAnthropicClient,
  maxTokensLimit,
  timeoutMs,
  type AnthropicEnv,
} from "./anthropic";

// 合成の値だけ（本物の鍵・本物の API は使わない。fetch はすべて差し替える）
const KEY = "synthetic-anthropic-key-0123456789";
const SECRET_TEXT = "合成の秘密の本文";

type Call = { url: string; init: RequestInit; body: Record<string, unknown>; headers: Record<string, string> };

/** 呼ばれた要求を残す偽物の fetch。 */
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      init,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Messages API の応答（合成）。 */
function message(text: string | null, overrides: Record<string, unknown> = {}): Response {
  const content = text === null ? [] : [{ type: "text", text }];
  return Response.json({
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content,
    stop_reason: "end_turn",
    usage: { input_tokens: 120, output_tokens: 30 },
    ...overrides,
  });
}

/** 呼び出し元の中断か時間切れまで返らない fetch。 */
function hangingFetch() {
  return fakeFetch(
    (call) =>
      new Promise<Response>((_, reject) => {
        call.init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
}

/** 1 往復の依頼（合成）。 */
const ASK = { system: "合成の規則", user: "合成の依頼" };

const OUTPUT = "合成の答え";

async function failureOf(promise: Promise<unknown>): Promise<AnthropicError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AnthropicError);
  return error as AnthropicError;
}

let log: MockInstance<typeof console.error>;

beforeEach(() => {
  log = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  log.mockRestore();
  vi.useRealTimers();
});

describe("createAnthropicClient (the shared HTTP path)", () => {
  it("posts to the fixed Messages URL with the key, the version and the body shape, and reads the text", async () => {
    const { fetch, calls } = fakeFetch(() => message(OUTPUT));
    const model = createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: ` ${KEY} ` }, fetch });

    const result = await model.complete(ASK);
    expect(result).toEqual({ text: OUTPUT, usage: { model: "claude-sonnet-5-5", inputTokens: 120, outputTokens: 30 } });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call!.init.method).toBe("POST");
    expect(call!.init.redirect).toBe("error");
    expect(call!.headers).toEqual({ "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" });
    expect(Object.keys(call!.body).sort()).toEqual(["max_tokens", "messages", "model", "system"]);
    expect(call!.body.model).toBe("claude-sonnet-5-5");
    // claude-sonnet-5-5 は既定以外の temperature を断るので送らない
    expect(call!.body).not.toHaveProperty("temperature");
    expect(call!.body.system).toBe("合成の規則");
    expect(call!.body.messages).toEqual([{ role: "user", content: "合成の依頼" }]);
    expect(call!.body.max_tokens).toBe(12_000);
  });

  it("reads the key from the environment on every request and refuses to call without one", async () => {
    const { fetch, calls } = fakeFetch(() => message(OUTPUT));
    const env: { ANTHROPIC_API_KEY?: string } = { ANTHROPIC_API_KEY: KEY };
    const model = createAnthropicClient({ model: "claude-sonnet-5-5", env, fetch });
    await model.complete(ASK);
    env.ANTHROPIC_API_KEY = `${KEY}-rotated`;
    await model.complete(ASK);
    expect(calls.map((call) => call.headers["x-api-key"])).toEqual([KEY, `${KEY}-rotated`]);

    for (const missing of [undefined, "", "   "]) {
      env.ANTHROPIC_API_KEY = missing;
      const error = await failureOf(model.complete(ASK));
      expect(error.kind, String(missing)).toBe("auth");
      expect(error.status).toBeUndefined();
    }
    expect(calls).toHaveLength(2);
  });

  it("copies the usage from the response: the model it reports and its token counts", async () => {
    const cases: [Record<string, unknown>, { model: string; inputTokens: number; outputTokens: number }][] = [
      [{ model: "claude-sonnet-5-5-20261001", usage: { input_tokens: 2_000, output_tokens: 700, cache_read_input_tokens: 5 } }, { model: "claude-sonnet-5-5-20261001", inputTokens: 2_000, outputTokens: 700 }],
      [{ model: undefined, usage: undefined }, { model: "claude-sonnet-5-5", inputTokens: 0, outputTokens: 0 }],
      [{ model: "", usage: { input_tokens: -1, output_tokens: "7" } }, { model: "claude-sonnet-5-5", inputTokens: 0, outputTokens: 0 }],
    ];
    for (const [overrides, usage] of cases) {
      const { fetch } = fakeFetch(() => message(OUTPUT, overrides));
      const result = await createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch }).complete({ ...ASK });
      expect(result.usage).toEqual(usage);
    }
  });

  it("maps HTTP failures to a kind and the status, without reading or keeping the body", async () => {
    const cases: [number, string][] = [
      [400, "bad_request"],
      [401, "auth"],
      [402, "auth"],
      [403, "auth"],
      [404, "bad_request"],
      [413, "bad_request"],
      [429, "rate_limit"],
      [500, "server"],
      [503, "server"],
      [529, "overloaded"],
    ];
    for (const [status, kind] of cases) {
      const body = JSON.stringify({ type: "error", error: { type: "synthetic", message: `${SECRET_TEXT} ${KEY}` } });
      const { fetch, calls } = fakeFetch(() => new Response(body, { status, headers: { "content-type": "application/json" } }));
      const error = await failureOf(createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch }).complete({ ...ASK }));
      expect([error.kind, error.status, error.reason], String(status)).toEqual([kind, status, undefined]);
      expect(error.retryable, String(status)).toBe(["rate_limit", "overloaded", "server"].includes(kind));
      expect(error.usage).toBeUndefined();
      // 自動の再試行はしない
      expect(calls).toHaveLength(1);
    }
    expect(log).toHaveBeenCalledWith("editor-web: anthropic request failed", { kind: "overloaded", status: 529 });
  });

  it("fails with invalid_output and a short reason on an empty, truncated or refused answer and on a body that is not a message", async () => {
    const usage = { model: "claude-sonnet-5-5", inputTokens: 120, outputTokens: 30 };
    const answers: [Response, string, typeof usage | undefined][] = [
      [message(null), "empty", usage],
      [message("   "), "empty", usage],
      [message(OUTPUT, { content: [{ type: "thinking", thinking: "" }] }), "empty", usage],
      // 出力の上限で途中で切れた（JSON として読めても使わない）
      [message(OUTPUT, { stop_reason: "max_tokens", usage: { input_tokens: 120, output_tokens: 12_000 } }), "max_tokens", { ...usage, outputTokens: 12_000 }],
      [message('{"edits":[{"index":1,"text":"途中', { stop_reason: "max_tokens" }), "max_tokens", usage],
      [message("", { stop_reason: "refusal" }), "refusal", usage],
      [new Response("not json", { status: 200 }), "bad_body", undefined],
      [Response.json(["not", "a", "message"]), "bad_body", undefined],
    ];
    for (const [answer, reason, used] of answers) {
      const { fetch } = fakeFetch(() => answer.clone());
      const error = await failureOf(createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch }).complete({ ...ASK }));
      expect([error.kind, error.reason, error.status], reason).toEqual(["invalid_output", reason, undefined]);
      expect(error.usage, reason).toEqual(used);
      expect(error.retryable).toBe(false);
    }
    expect(log).toHaveBeenCalledWith("editor-web: anthropic request failed", { kind: "invalid_output", reason: "max_tokens" });
    // 思考のブロックの後ろの text ブロックを読む
    const { fetch } = fakeFetch(() => message(null, { content: [{ type: "thinking", thinking: "" }, { type: "text", text: OUTPUT }] }));
    expect((await createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch }).complete({ ...ASK })).text).toEqual(OUTPUT);
  });

  it("fails with network when fetch throws, without keeping the thrown message", async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError(`fetch failed: ${KEY} ${SECRET_TEXT}`);
    });
    const error = await failureOf(createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch }).complete({ ...ASK }));
    expect(error.kind).toBe("network");
    expect(error.retryable).toBe(true);
    expect(error.cause).toBeUndefined();
    expect(error.message).toBe("anthropic request failed: network");
  });

  it("times out after EDITOR_AI_TIMEOUT_MS (120 s by default)", async () => {
    vi.useFakeTimers();
    const { fetch } = hangingFetch();
    const pending = failureOf(createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch }).complete({ ...ASK }));
    await vi.advanceTimersByTimeAsync(119_999);
    let settled = false;
    void pending.finally(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect([error.kind, error.retryable]).toEqual(["timeout", true]);

    const short = hangingFetch();
    const quick = failureOf(createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY, EDITOR_AI_TIMEOUT_MS: "2500" }, fetch: short.fetch }).complete({ ...ASK }));
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await quick).kind).toBe("timeout");
  });

  it("stops when the caller aborts, with the caller's reason, and never calls with an already aborted signal", async () => {
    const { fetch, calls } = hangingFetch();
    const model = createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch });
    const controller = new AbortController();
    const pending = model.complete({ ...ASK, signal: controller.signal });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const reason = new DOMException("client went away", "AbortError");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(calls[0]!.init.signal?.aborted).toBe(true);

    const aborted = AbortSignal.abort(reason);
    await expect(model.complete({ ...ASK, signal: aborted })).rejects.toBe(reason);
    expect(calls).toHaveLength(1);
    // 中断は失敗ではないのでログに残さない
    expect(log).not.toHaveBeenCalled();
  });

  it("never puts the key, the prompt or the answer into errors or logs", async () => {
    const page = { system: "合成の規則", user: `<untrusted_data>\n${SECRET_TEXT}を直して\n</untrusted_data>` };
    const answers: (() => Response)[] = [
      () => new Response(JSON.stringify({ error: { message: `${SECRET_TEXT} ${KEY}` } }), { status: 400 }),
      () => new Response(`${SECRET_TEXT} ${KEY}`, { status: 500 }),
      () => message(`${SECRET_TEXT} は途中で切れた`, { stop_reason: "max_tokens" }),
      () => new Response(`${SECRET_TEXT} {`, { status: 200 }),
      () => {
        throw new Error(`${SECRET_TEXT} ${KEY}`);
      },
    ];
    const errors: unknown[] = [];
    for (const answer of answers) {
      const { fetch } = fakeFetch(answer);
      errors.push(await failureOf(createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch }).complete(page)));
    }
    const exposed = JSON.stringify([log.mock.calls, errors, errors.map(String), errors.map((error) => (error as Error).stack)]);
    expect(exposed).not.toContain(KEY);
    expect(exposed).not.toContain(SECRET_TEXT);
    expect(exposed).not.toContain("untrusted_data");
    expect(log.mock.calls.map(([, detail]) => Object.keys(detail as object).sort().join(","))).toEqual(["kind,status", "kind,status", "kind,reason", "kind,reason", "kind"]);
  });

  it("always calls the fixed host, whatever else is in the environment", async () => {
    const { fetch, calls } = fakeFetch(() => message(OUTPUT));
    const env = { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "https://attacker.example.com", EDITOR_AI_URL: "https://attacker.example.com/v1/messages" } as AnthropicEnv;
    await createAnthropicClient({ model: "claude-sonnet-5-5", env, fetch }).complete({ ...ASK });
    await createAnthropicClient({ model: "claude-haiku-4-5", env, fetch }).converse({ system: "s", messages: [{ role: "user", content: "u" }] });
    expect(calls.map((call) => call.url)).toEqual([ANTHROPIC_MESSAGES_URL, ANTHROPIC_MESSAGES_URL]);
    expect(ANTHROPIC_MESSAGES_URL).toBe("https://api.anthropic.com/v1/messages");
  });
});

describe("createAnthropicClient.complete", () => {
  it("sends the system and user text as given and returns the text and usage", async () => {
    const { fetch, calls } = fakeFetch(() => message("  合成の結果  \n", { usage: { input_tokens: 9, output_tokens: 4 } }));
    const client = createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch });
    expect(await client.complete({ system: "合成の規則", user: "合成の依頼", maxTokens: 500 })).toEqual({
      text: "合成の結果",
      usage: { model: "claude-sonnet-5-5", inputTokens: 9, outputTokens: 4 },
    });
    expect(calls[0]!.body).toEqual({ model: "claude-sonnet-5-5", max_tokens: 500, system: "合成の規則", messages: [{ role: "user", content: "合成の依頼" }] });
  });

  it("keeps max_tokens under EDITOR_AI_MAX_TOKENS", async () => {
    const { fetch, calls } = fakeFetch(() => message("ok"));
    const ask = (env: AnthropicEnv, maxTokens?: number) => createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY, ...env }, fetch }).complete({ system: "s", user: "u", maxTokens });
    await ask({});
    await ask({}, 99_999);
    await ask({ EDITOR_AI_MAX_TOKENS: "8000" }, 6_000.7);
    await ask({ EDITOR_AI_MAX_TOKENS: "8000" }, Number.NaN);
    await ask({}, 0);
    expect(calls.map((call) => call.body.max_tokens)).toEqual([12_000, 12_000, 6000, 8000, 1]);
  });
});

describe("createAnthropicClient.converse", () => {
  it("sends optional adaptive thinking and effort fields only when the caller provides them", async () => {
    const { fetch, calls } = fakeFetch(() => message("合成の答え"));
    const client = createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch });
    await client.converse({
      system: "合成の規則",
      messages: [{ role: "user", content: "合成の依頼" }],
      maxTokens: 4_000,
      thinking: { type: "adaptive" },
      outputConfig: { effort: "low" },
    });
    expect(calls[0]!.body).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 4_000,
      system: "合成の規則",
      messages: [{ role: "user", content: "合成の依頼" }],
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });

    await client.converse({ system: "s", messages: [{ role: "user", content: "u" }] });
    expect(calls[1]!.body).not.toHaveProperty("thinking");
    expect(calls[1]!.body).not.toHaveProperty("output_config");
  });
});

describe("settings", () => {
  it("reads the timeout and the output limit, falling back to the defaults and clamping to the allowed range", () => {
    expect(timeoutMs({})).toBe(120_000);
    expect(timeoutMs({ EDITOR_AI_TIMEOUT_MS: " 90000 " })).toBe(90_000);
    expect(timeoutMs({ EDITOR_AI_TIMEOUT_MS: "10" })).toBe(1_000);
    expect(timeoutMs({ EDITOR_AI_TIMEOUT_MS: "999999999" })).toBe(300_000);
    for (const value of ["", "abc", "Infinity", "NaN"]) expect(timeoutMs({ EDITOR_AI_TIMEOUT_MS: value }), value).toBe(120_000);

    expect(maxTokensLimit({})).toBe(12_000);
    expect(maxTokensLimit({ EDITOR_AI_MAX_TOKENS: "8192" })).toBe(8192);
    expect(maxTokensLimit({ EDITOR_AI_MAX_TOKENS: "100" })).toBe(256);
    expect(maxTokensLimit({ EDITOR_AI_MAX_TOKENS: "64000" })).toBe(32_000);
    expect(maxTokensLimit({ EDITOR_AI_MAX_TOKENS: "many" })).toBe(12_000);
  });
});

/** SSE の 1 つの event（合成）。 */
function sse(data: Record<string, unknown>): string {
  return `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 決まったチャンクを流す streaming の応答。`hang` なら最後のチャンクのあと閉じない。 */
function streamResponse(chunks: string[], options: { hang?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!options.hang) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const STREAM_TURN = [
  sse({ type: "message_start", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 120, output_tokens: 1 } } }),
  sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  sse({ type: "ping" }),
  sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "本文を読んで、" } }),
  sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "見出しを足します。" } }),
  sse({ type: "content_block_stop", index: 0 }),
  sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read_page", input: {} } }),
  sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"page_' } }),
  sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'id":"p1"}' } }),
  sse({ type: "content_block_stop", index: 1 }),
  sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } }),
  sse({ type: "message_stop" }),
];

describe("createAnthropicClient.converse (streaming)", () => {
  it("streams the text to onText and builds the same turn as the non-streaming answer", async () => {
    // チャンクの切れ目は event の途中にも来る
    const joined = STREAM_TURN.join("");
    const chunks = [joined.slice(0, 50), joined.slice(50, 333), joined.slice(333)];
    const { fetch, calls } = fakeFetch(() => streamResponse(chunks));
    const client = createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch });
    const deltas: string[] = [];
    const turn = await client.converse({ system: "s", messages: [{ role: "user", content: "u" }], tools: [{ name: "read_page" }], onText: (delta) => deltas.push(delta) });
    expect(calls[0]!.body).toMatchObject({ stream: true, tools: [{ name: "read_page" }] });
    expect(deltas).toEqual(["本文を読んで、", "見出しを足します。"]);
    expect(turn).toEqual({
      text: "本文を読んで、見出しを足します。",
      toolCalls: [{ id: "toolu_1", name: "read_page", input: { page_id: "p1" } }],
      stopReason: "tool_use",
      usage: { model: "claude-sonnet-5-5", inputTokens: 120, outputTokens: 42 },
      content: [
        { type: "text", text: "本文を読んで、見出しを足します。" },
        { type: "tool_use", id: "toolu_1", name: "read_page", input: { page_id: "p1" } },
      ],
    });
  });

  it("does not stream without onText", async () => {
    const { fetch, calls } = fakeFetch(() => message("合成の答え"));
    const client = createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch });
    expect((await client.converse({ system: "s", messages: [] })).text).toBe("合成の答え");
    expect(calls[0]!.body).not.toHaveProperty("stream");
  });

  it("fails as server on an error event in the middle, without carrying the body", async () => {
    const { fetch } = fakeFetch(() => streamResponse([
      STREAM_TURN[0]!,
      STREAM_TURN[1]!,
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: SECRET_TEXT } }),
      sse({ type: "error", error: { type: "overloaded_error", message: SECRET_TEXT } }),
    ]));
    const client = createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch });
    const error = await failureOf(client.converse({ system: "s", messages: [], onText: () => undefined }));
    expect(error.kind).toBe("server");
    expect(error.message).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET_TEXT);
  });

  it("fails as invalid_output when the tool input is broken JSON or the stream ends early", async () => {
    const broken = fakeFetch(() => streamResponse([
      STREAM_TURN[0]!,
      sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_page", input: {} } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"page_' } }),
      sse({ type: "content_block_stop", index: 0 }),
    ]));
    const first = await failureOf(createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch: broken.fetch }).converse({ system: "s", messages: [], onText: () => undefined }));
    expect([first.kind, first.reason]).toEqual(["invalid_output", "bad_body"]);

    const cut = fakeFetch(() => streamResponse(STREAM_TURN.slice(0, 4)));
    const second = await failureOf(createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch: cut.fetch }).converse({ system: "s", messages: [], onText: () => undefined }));
    expect([second.kind, second.reason]).toEqual(["invalid_output", "bad_body"]);
  });

  it("keeps a refusal as invalid_output", async () => {
    const { fetch } = fakeFetch(() => streamResponse([STREAM_TURN[0]!, sse({ type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 3 } }), sse({ type: "message_stop" })]));
    const error = await failureOf(createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch }).converse({ system: "s", messages: [], onText: () => undefined }));
    expect([error.kind, error.reason]).toEqual(["invalid_output", "refusal"]);
  });

  it("times out when the chunks stop for EDITOR_AI_TIMEOUT_MS, counting from the last chunk", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let push: ((chunk: string) => void) | null = null;
    const { fetch } = fakeFetch(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(encoder.encode(chunk));
      },
    }), { status: 200 }));
    const client = createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY, EDITOR_AI_TIMEOUT_MS: "2000" }, fetch });
    const pending = failureOf(client.converse({ system: "s", messages: [], onText: () => undefined }));
    let settled = false;
    void pending.finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1_500);
    push!(STREAM_TURN[0]!);
    // チャンクが届いたのでタイマーは張り直される（最初から 2 秒を過ぎても切れない）
    await vi.advanceTimersByTimeAsync(1_500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect((await pending).kind).toBe("timeout");
  });
});

describe("createAnthropicClient.converse with server-side Web search (#283)", () => {
  // Anthropic の web search のドキュメントの応答の形（合成の値）
  const SEARCH_CONTENT = [
    { type: "text", text: "調べます。" },
    { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "合成の店 営業時間" } },
    {
      type: "web_search_tool_result",
      tool_use_id: "srvtoolu_1",
      content: [{ type: "web_search_result", url: "https://example.com/a", title: "合成の店", encrypted_content: "enc-1", page_age: null }],
    },
    { type: "text", text: "調べた結果、" },
    {
      type: "text",
      text: "10 時から 18 時です。",
      citations: [{ type: "web_search_result_location", url: "https://example.com/a", title: "合成の店", encrypted_index: "idx-1", cited_text: "10:00-18:00" }],
    },
  ];

  it("keeps every block as it came (to send back next time), joins cited text without a break and reads the search count", async () => {
    const { fetch } = fakeFetch(() => message(null, { content: SEARCH_CONTENT, usage: { input_tokens: 600, output_tokens: 90, server_tool_use: { web_search_requests: 1 } } }));
    const client = createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch });
    const turn = await client.converse({ system: "s", messages: [], tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] });
    expect(turn.content).toEqual(SEARCH_CONTENT);
    expect(turn.text).toBe("調べます。\n調べた結果、10 時から 18 時です。");
    expect(turn.toolCalls).toEqual([]);
    expect(turn.usage).toEqual({ model: "claude-sonnet-5-5", inputTokens: 600, outputTokens: 90, webSearchRequests: 1 });
  });

  it("builds the same blocks from the stream (query deltas, the result in one start event, citation deltas) and reports them as they complete", async () => {
    const chunks = [
      sse({ type: "message_start", message: { model: "claude-sonnet-5-5", usage: { input_tokens: 600, output_tokens: 1 } } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "調べます。" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "content_block_start", index: 1, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"合成の店' } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ' 営業時間"}' } }),
      sse({ type: "content_block_stop", index: 1 }),
      sse({ type: "content_block_start", index: 2, content_block: SEARCH_CONTENT[2]! }),
      sse({ type: "content_block_stop", index: 2 }),
      sse({ type: "content_block_start", index: 3, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "調べた結果、" } }),
      sse({ type: "content_block_stop", index: 3 }),
      sse({ type: "content_block_start", index: 4, content_block: { type: "text", text: "", citations: [] } }),
      sse({ type: "content_block_delta", index: 4, delta: { type: "citations_delta", citation: (SEARCH_CONTENT[4] as { citations: unknown[] }).citations[0] } }),
      sse({ type: "content_block_delta", index: 4, delta: { type: "text_delta", text: "10 時から 18 時です。" } }),
      sse({ type: "content_block_stop", index: 4 }),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 90, server_tool_use: { web_search_requests: 1 } } }),
      sse({ type: "message_stop" }),
    ];
    const { fetch } = fakeFetch(() => streamResponse(chunks));
    const client = createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch });
    const blocks: Record<string, unknown>[] = [];
    const turn = await client.converse({ system: "s", messages: [], onText: () => undefined, onServerBlock: (block) => blocks.push(block) });
    expect(turn.content).toEqual(SEARCH_CONTENT);
    expect(blocks).toEqual([SEARCH_CONTENT[1], SEARCH_CONTENT[2]]);
    expect(turn.usage).toEqual({ model: "claude-sonnet-5-5", inputTokens: 600, outputTokens: 90, webSearchRequests: 1 });
    expect(turn.stopReason).toBe("end_turn");
  });

  it("returns pause_turn as a stop reason (the conversation sends the content back to continue)", async () => {
    const { fetch } = fakeFetch(() => message(null, { content: SEARCH_CONTENT.slice(0, 3), stop_reason: "pause_turn" }));
    const client = createAnthropicClient({ model: "claude-sonnet-5-5", env: { ANTHROPIC_API_KEY: KEY }, fetch });
    const turn = await client.converse({ system: "s", messages: [] });
    expect(turn.stopReason).toBe("pause_turn");
    expect(turn.content).toEqual(SEARCH_CONTENT.slice(0, 3));
  });
});
