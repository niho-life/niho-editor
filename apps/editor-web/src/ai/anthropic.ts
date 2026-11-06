import "server-only";
import type { AiUsageReport } from "./model";

/**
 * 本物のモデル: Anthropic の Messages API（Issue #38。`EDITOR_AI_MODE=anthropic` のとき config.ts が作る）。
 *
 * - 呼ぶのは固定の URL（`ANTHROPIC_MESSAGES_URL`）だけ。設定では変えられない。転送（redirect）も追わない。
 * - 鍵は要求のたびに `ANTHROPIC_API_KEY` から読む（import のときに固めない）。鍵・プロンプト・本文・応答の本文は、
 *   エラー・例外・ログに出さない（ログは kind と、HTTP ステータスか invalid_output の理由の code だけ）。
 * - 自動の再試行はしない。失敗はすべて `AnthropicError`（呼び出し元の中断だけは、呼び出し元の理由をそのまま投げる）。
 * - `temperature` は送らない: claude-sonnet-5-5 を含む Claude 4.7 以降のモデルは既定以外の値を 400 で断る。
 * - 工程生成では工程 snapshot の profile を `thinking: adaptive` と `output_config.effort` に訳す（対応する Claude 4.6+ / 5+ のみ）。
 *   `max_tokens` はサーバーの `EDITOR_AI_MAX_TOKENS` と profile の両方で制限する。
 */

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

/** 1 回の呼び出しの時間切れ（ミリ秒。`EDITOR_AI_TIMEOUT_MS`）。Cloud Run の要求の時間切れは 300 秒（deploy.sh）。 */
export const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;

/** 1 回の出力の上限（トークン。思考の分を含む。`EDITOR_AI_MAX_TOKENS`）。 */
export const DEFAULT_MAX_TOKENS = 12_000;
const MIN_MAX_TOKENS = 256;
const MAX_MAX_TOKENS = 32_000;

export type AnthropicErrorKind = "auth" | "rate_limit" | "overloaded" | "bad_request" | "server" | "timeout" | "network" | "invalid_output";

/**
 * `invalid_output` の理由（短い code だけ）: 文が無い・空（empty）、出力の上限で途中で切れた（max_tokens）、断られた（refusal）、
 * 文が JSON でない（not_json）、応答の本文が Messages API の形でない（bad_body）。
 */
export type AnthropicInvalidReason = "empty" | "max_tokens" | "refusal" | "not_json" | "bad_body";

const RETRYABLE: readonly AnthropicErrorKind[] = ["rate_limit", "overloaded", "server", "timeout", "network"];

type FailureDetails = { status?: number; reason?: AnthropicInvalidReason; usage?: AiUsageReport };

/**
 * Anthropic の呼び出しの失敗。持つのは kind と（あれば）HTTP ステータス・invalid_output の理由・使用量だけ
 * （応答の本文・鍵・プロンプトは持たない）。`usage` は応答が届いたのに使えなかったとき（JSON でない・途中で切れた）。
 * トークンは課金されているので、ai-api.ts はこの分も使用量に数える。
 */
export class AnthropicError extends Error {
  readonly kind: AnthropicErrorKind;
  readonly status: number | undefined;
  readonly reason: AnthropicInvalidReason | undefined;
  readonly usage: AiUsageReport | undefined;

  constructor(kind: AnthropicErrorKind, details: FailureDetails = {}) {
    const detail = details.status ?? details.reason;
    super(detail === undefined ? `anthropic request failed: ${kind}` : `anthropic request failed: ${kind} (${detail})`);
    this.name = "AnthropicError";
    this.kind = kind;
    this.status = details.status;
    this.reason = details.reason;
    this.usage = details.usage;
  }

  /** 一時的な失敗（時間を置けば通りうる）。#37 の手順の実行器が再試行の判断に使う。この層では再試行しない。 */
  get retryable(): boolean {
    return RETRYABLE.includes(this.kind);
  }
}

/** 要求のたびに読む環境変数（本番は process.env をそのまま渡す）。 */
export type AnthropicEnv = {
  readonly ANTHROPIC_API_KEY?: string | undefined;
  readonly EDITOR_AI_TIMEOUT_MS?: string | undefined;
  readonly EDITOR_AI_MAX_TOKENS?: string | undefined;
};

export type AnthropicOptions = {
  /** モデル名（config.ts が形を確かめたもの）。 */
  model: string;
  env: AnthropicEnv;
  /** テストで差し替える。既定は呼んだ時点の globalThis.fetch。 */
  fetch?: typeof fetch;
};

export type CompleteInput = {
  system: string;
  user: string;
  /** 出力の上限（トークン）。`EDITOR_AI_MAX_TOKENS` を超えない。省くと `EDITOR_AI_MAX_TOKENS`。 */
  maxTokens?: number;
  signal?: AbortSignal;
};

export type Completion = { text: string; usage: AiUsageReport };

/**
 * 道具つきの 1 往復（AI チャットの会話。#38）。`messages` は Messages API の messages をそのまま渡す
 * （本文は role: "user" の中のデータで、system の指示ではない）。`tools` は道具の定義。
 */
export type ConverseInput = {
  system: string;
  messages: unknown[];
  tools?: unknown[];
  maxTokens?: number;
  /** Claude 4.6+ / 5+ の工程生成で使う適応型思考。 */
  thinking?: { type: "adaptive" };
  /** Claude 4.6+ / 5+ の工程 profile に対応する思考量。 */
  outputConfig?: { effort: "low" | "medium" | "high" };
  signal?: AbortSignal;
  /**
   * 書いている文の差分を受け取る（AI チャットの思考の中継）。渡すと streaming で呼び、文が届くたびに呼ぶ。
   * 結果（Turn）は streaming でないときと同じ形。
   */
  onText?: (delta: string) => void;
  /**
   * サーバー側の道具のブロック（`server_tool_use`・`web_search_tool_result`）が揃ったときに呼ぶ（streaming のときだけ。#283）。
   * 作業の行（「Web を検索: …」）を出すため。ブロックは応答のまま渡す（中身をログに出さない）。
   */
  onServerBlock?: (block: Record<string, unknown>) => void;
};

/** モデルが呼んだ道具 1 回（`input` はモデルが作った値なので信用しない）。 */
export type ToolCall = { id: string; name: string; input: unknown };

/**
 * 道具つきの 1 往復の答え。`text` はこの往復で書いた文（実況・返答）、`toolCalls` は呼ばれた道具、
 * `stopReason` は `tool_use`（道具の結果を返すと続く）・`end_turn`（終わり）・`max_tokens`（出力の上限で切れた）・
 * `pause_turn`（サーバー側の道具の途中で止まった。content をそのまま返すと続く）など。
 * `content` は応答の content ブロック（次の往復の assistant にそのまま返す。サーバー側の検索の呼び出し・結果・引用つきの文を含む。#283）。
 * 本物は必ず持ち、テストの偽物は省ける（省くと text と toolCalls から組み直す）。
 */
export type Turn = { text: string; toolCalls: ToolCall[]; stopReason: string | null; usage: AiUsageReport; content?: unknown[] };

export type AnthropicClient = {
  complete(input: CompleteInput): Promise<Completion>;
  converse(input: ConverseInput): Promise<Turn>;
};

/** 数の設定（空・数でない値は既定、範囲の外は端に丸める）。 */
function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const text = raw?.trim() ?? "";
  const value = text === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function timeoutMs(env: AnthropicEnv): number {
  return boundedInteger(env.EDITOR_AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
}

export function maxTokensLimit(env: AnthropicEnv): number {
  return boundedInteger(env.EDITOR_AI_MAX_TOKENS, DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS);
}

function statusKind(status: number): AnthropicErrorKind {
  if (status === 401 || status === 402 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status >= 500) return "server";
  return "bad_request";
}

/** 失敗を作ってログに残す（kind と status か理由の code だけ）。 */
function failure(kind: AnthropicErrorKind, details: FailureDetails = {}): AnthropicError {
  const logged: { kind: AnthropicErrorKind; status?: number; reason?: AnthropicInvalidReason } = { kind };
  if (details.status !== undefined) logged.status = details.status;
  if (details.reason !== undefined) logged.reason = details.reason;
  console.error("editor-web: anthropic request failed", logged);
  return new AnthropicError(kind, details);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** `usage.server_tool_use.web_search_requests`（サーバー側の Web 検索の回数。無ければ 0）。 */
function webSearchRequestsOf(usage: Record<string, unknown>): number {
  const server = isPlainObject(usage.server_tool_use) ? usage.server_tool_use : {};
  return tokens(server.web_search_requests);
}

function readUsage(message: Record<string, unknown>, requested: string): AiUsageReport {
  const usage = isPlainObject(message.usage) ? message.usage : {};
  const model = typeof message.model === "string" && message.model.length > 0 ? message.model : requested;
  const searches = webSearchRequestsOf(usage);
  return { model, inputTokens: tokens(usage.input_tokens), outputTokens: tokens(usage.output_tokens), ...(searches > 0 ? { webSearchRequests: searches } : {}) };
}

/** 応答の最初の text ブロック。途中で切れた（max_tokens）・断られた（refusal）・無い・空は invalid_output（使用量は持たせる）。 */
function readMessage(message: unknown, requested: string): Completion {
  if (!isPlainObject(message)) throw failure("invalid_output", { reason: "bad_body" });
  const usage = readUsage(message, requested);
  const stop = message.stop_reason;
  if (stop === "max_tokens" || stop === "refusal") throw failure("invalid_output", { reason: stop, usage });
  const content = Array.isArray(message.content) ? message.content : [];
  const block = content.find((item: unknown) => isPlainObject(item) && item.type === "text" && typeof item.text === "string") as { text: string } | undefined;
  const text = block?.text.trim() ?? "";
  if (text === "") throw failure("invalid_output", { reason: "empty", usage });
  return { text, usage };
}

/** Messages API の本文（model と max_tokens はここで足す）。 */
type MessagesBody = {
  stream?: true;
  system: string;
  messages: unknown[];
  tools?: unknown[];
  thinking?: { type: "adaptive" };
  output_config?: { effort: "low" | "medium" | "high" };
};

/**
 * 道具つきの往復の答えを読む。文（text）は連ねて 1 つにし、道具（tool_use）は呼ばれた順に並べる。
 * 隣り合う text ブロック（Web 検索の引用で 1 つの文が分かれたもの）は区切らずにつなぎ、ほかのブロックを挟んだ text は改行でつなぐ。
 * 断られた（refusal）ときだけ invalid_output（使用量は持たせる）。出力の上限で切れたのは `stopReason` で返し、
 * 会話の側が「途中で止まりました」として扱う（書いた分の道具の結果は残っている）。
 * `content` は応答のブロックをそのまま持つ（サーバー側の道具のブロックは、次の往復へ手を加えずに返す必要がある）。
 */
function readTurn(message: Record<string, unknown>, requested: string): Turn {
  const usage = readUsage(message, requested);
  if (message.stop_reason === "refusal") throw failure("invalid_output", { reason: "refusal", usage });
  const content = (Array.isArray(message.content) ? message.content : []).filter(isPlainObject);
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let adjacent = false;
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") {
      if (adjacent && texts.length > 0) texts[texts.length - 1] += item.text;
      else texts.push(item.text);
      adjacent = true;
      continue;
    }
    adjacent = false;
    if (item.type === "tool_use" && typeof item.id === "string" && typeof item.name === "string") {
      toolCalls.push({ id: item.id, name: item.name, input: item.input });
    }
  }
  return {
    text: texts.join("\n").trim(),
    toolCalls,
    stopReason: typeof message.stop_reason === "string" ? message.stop_reason : null,
    usage,
    content,
  };
}

/** 応答の本文を読む口。`touch` は届いたことを知らせる（時間切れのタイマーを張り直す）。 */
type ReadBody = (
  response: Response,
  hooks: { touch: () => void; interrupted: (fallback: AnthropicErrorKind, details?: FailureDetails) => unknown; onCancel: (cancel: () => void) => void },
) => Promise<Record<string, unknown>>;

const readJson: ReadBody = async (response, { interrupted }) => {
  let message: unknown;
  try {
    message = await response.json();
  } catch {
    throw interrupted("invalid_output", { reason: "bad_body" });
  }
  if (!isPlainObject(message)) throw failure("invalid_output", { reason: "bad_body" });
  return message;
};

async function send(
  options: AnthropicOptions,
  body: MessagesBody,
  maxTokens: number,
  signal: AbortSignal | undefined,
  read: ReadBody = readJson,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  // 鍵は呼ぶたびに読む。無ければ呼ばない
  const key = options.env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (key === "") throw failure("auth");

  const controller = new AbortController();
  let timedOut = false;
  let cancelBody: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = timeoutMs(options.env);
  // 時間切れは「最後に届いてから limit」（streaming はチャンクごとに張り直す）
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      cancelBody?.();
    }, limit);
  };
  arm();
  const onAbort = () => {
    controller.abort();
    cancelBody?.();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  // 呼び出し元の中断は呼び出し元の理由のまま、時間切れは timeout、それ以外は fallback の失敗
  const interrupted = (fallback: AnthropicErrorKind, details?: FailureDetails): unknown => {
    if (signal?.aborted) return signal.reason;
    return timedOut ? failure("timeout") : failure(fallback, details);
  };
  const doFetch = options.fetch ?? globalThis.fetch;
  try {
    let response: Response;
    try {
      response = await doFetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
        body: JSON.stringify({ model: options.model, max_tokens: maxTokens, ...body }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      // fetch の例外の文（URL や内部の情報）は持ち出さない
      throw interrupted("network");
    }
    if (!response.ok) {
      // 失敗の本文は読まない（モデル名やプロンプトの一部を含みうる）
      await response.body?.cancel().catch(() => undefined);
      throw failure(statusKind(response.status), { status: response.status });
    }
    return await read(response, {
      touch: arm,
      interrupted,
      onCancel: (cancel) => {
        cancelBody = cancel;
      },
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * streaming の中の 1 ブロック。文（引用つき）・道具・サーバー側の道具の呼び出し（`server_tool_use`。入力は差分で届く）・
 * サーバー側の道具の結果（`web_search_tool_result`。content_block_start で全部が届く）。ほかは捨てる（前と同じ）。
 */
type StreamBlock =
  | { type: "text"; text: string; citations: unknown[] }
  | { type: "tool_use"; id: string; name: string; json: string; input: unknown }
  | { type: "server_tool_use"; raw: Record<string, unknown>; json: string; input: unknown }
  | { type: "server_result"; raw: Record<string, unknown> }
  | { type: "other" };

/** 次の往復へ返すブロックの形（streaming でない応答の content と同じ）。 */
function streamBlockContent(block: Exclude<StreamBlock, { type: "other" }>): Record<string, unknown> {
  switch (block.type) {
    case "text":
      return block.citations.length > 0 ? { type: "text", text: block.text, citations: block.citations } : { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "server_tool_use":
      return { ...block.raw, input: block.input };
    case "server_result":
      return block.raw;
  }
}

/**
 * streaming（`text/event-stream`）の応答を読み、streaming でない応答と同じ形の message に組み立てる
 * （そのあと readTurn に通す）。文の差分は `onText` に、揃ったサーバー側の道具のブロックは `onServerBlock` に渡す。
 * 届いた本文はログ・例外に出さない。
 */
function readStream(onText: (delta: string) => void, requested: string, onServerBlock?: (block: Record<string, unknown>) => void): ReadBody {
  return async (response, { touch, interrupted, onCancel }) => {
    const stream = response.body;
    if (!stream) throw failure("invalid_output", { reason: "bad_body" });
    const reader = stream.getReader();
    onCancel(() => {
      reader.cancel().catch(() => undefined);
    });
    const decoder = new TextDecoder();
    const blocks: StreamBlock[] = [];
    let model = requested;
    let inputTokens = 0;
    let outputTokens = 0;
    let webSearchRequests = 0;
    let stopReason: string | null = null;
    let stopped = false;
    let buffer = "";
    const usageNow = (): AiUsageReport => ({ model, inputTokens, outputTokens, ...(webSearchRequests > 0 ? { webSearchRequests } : {}) });
    const badBody = () => failure("invalid_output", { reason: "bad_body", usage: usageNow() });

    const handle = (data: Record<string, unknown>) => {
      const index = typeof data.index === "number" ? data.index : -1;
      switch (data.type) {
        case "message_start": {
          const message = isPlainObject(data.message) ? data.message : {};
          if (typeof message.model === "string" && message.model.length > 0) model = message.model;
          const usage = isPlainObject(message.usage) ? message.usage : {};
          inputTokens = tokens(usage.input_tokens);
          outputTokens = tokens(usage.output_tokens);
          return;
        }
        case "content_block_start": {
          const block = isPlainObject(data.content_block) ? data.content_block : {};
          if (index < 0) return;
          if (block.type === "text") {
            const text = typeof block.text === "string" ? block.text : "";
            blocks[index] = { type: "text", text, citations: Array.isArray(block.citations) ? [...block.citations] : [] };
            if (text) onText(text);
          } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
            blocks[index] = { type: "tool_use", id: block.id, name: block.name, json: "", input: {} };
          } else if (block.type === "server_tool_use" && typeof block.id === "string" && typeof block.name === "string") {
            blocks[index] = { type: "server_tool_use", raw: block, json: "", input: isPlainObject(block.input) ? block.input : {} };
          } else if (block.type === "web_search_tool_result" && typeof block.tool_use_id === "string") {
            // 結果は content_block_start で全部が届く（差分は来ない）。手を加えずに持つ（encrypted_content は次の往復に要る）
            blocks[index] = { type: "server_result", raw: block };
            onServerBlock?.(block);
          } else blocks[index] = { type: "other" };
          return;
        }
        case "content_block_delta": {
          const delta = isPlainObject(data.delta) ? data.delta : {};
          const block = blocks[index];
          if (!block) return;
          if (delta.type === "text_delta" && block.type === "text" && typeof delta.text === "string") {
            block.text += delta.text;
            if (delta.text) onText(delta.text);
          } else if (delta.type === "citations_delta" && block.type === "text" && isPlainObject(delta.citation)) {
            block.citations.push(delta.citation);
          } else if (delta.type === "input_json_delta" && (block.type === "tool_use" || block.type === "server_tool_use") && typeof delta.partial_json === "string") {
            block.json += delta.partial_json;
          }
          return;
        }
        case "content_block_stop": {
          const block = blocks[index];
          if (block?.type !== "tool_use" && block?.type !== "server_tool_use") return;
          try {
            if (block.json.trim() !== "") block.input = JSON.parse(block.json);
            else if (block.type === "tool_use") block.input = {};
          } catch {
            throw badBody();
          }
          if (block.type === "server_tool_use") onServerBlock?.(streamBlockContent(block));
          return;
        }
        case "message_delta": {
          const delta = isPlainObject(data.delta) ? data.delta : {};
          if (typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
          const usage = isPlainObject(data.usage) ? data.usage : {};
          if (usage.output_tokens !== undefined) outputTokens = tokens(usage.output_tokens);
          if (usage.input_tokens !== undefined) inputTokens = Math.max(inputTokens, tokens(usage.input_tokens));
          // message_delta の usage は累計（Web 検索の回数も）
          if (usage.server_tool_use !== undefined) webSearchRequests = webSearchRequestsOf(usage);
          return;
        }
        case "message_stop":
          stopped = true;
          return;
        case "error":
          // 上流が途中で失敗した（本文は持ち出さない）
          throw failure("server");
        default:
          // ping など
          return;
      }
    };

    const flushEvent = (raw: string) => {
      const lines = raw.split(/\r?\n/);
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw badBody();
      }
      if (isPlainObject(parsed)) handle(parsed);
    };

    try {
      while (!stopped) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          throw interrupted("network");
        }
        if (chunk.done) break;
        touch();
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = /\r?\n\r?\n/.exec(buffer);
        while (boundary && !stopped) {
          const raw = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          flushEvent(raw);
          boundary = /\r?\n\r?\n/.exec(buffer);
        }
      }
      if (!stopped && buffer.trim() !== "") flushEvent(buffer);
    } catch (error) {
      // 失敗したら残りは読まない
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    // 途切れた（message_stop が来ない）のは、時間切れか中断なら timeout・その理由、それ以外は壊れた本文
    if (!stopped) throw interrupted("invalid_output", { reason: "bad_body", usage: usageNow() });
    const content = blocks
      .filter((block): block is Exclude<StreamBlock, { type: "other" }> => block !== undefined && block.type !== "other")
      .map(streamBlockContent);
    return {
      model,
      content,
      stop_reason: stopReason,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, ...(webSearchRequests > 0 ? { server_tool_use: { web_search_requests: webSearchRequests } } : {}) },
    };
  };
}

function boundedMaxTokens(options: AnthropicOptions, asked: number | undefined): number {
  const limit = maxTokensLimit(options.env);
  const value = asked === undefined || !Number.isFinite(asked) ? limit : Math.floor(asked);
  return Math.min(limit, Math.max(1, value));
}

/** 汎用の 1 往復（system と user の 1 通）。#37 の手順の実行器が使う。 */
export function createAnthropicClient(options: AnthropicOptions): AnthropicClient {
  return {
    async complete(input) {
      const body = { system: input.system, messages: [{ role: "user", content: input.user }] };
      const message = await send(options, body, boundedMaxTokens(options, input.maxTokens), input.signal);
      return readMessage(message, options.model);
    },
    async converse(input) {
      const body: MessagesBody = {
        system: input.system,
        messages: input.messages,
        ...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
        ...(input.thinking ? { thinking: input.thinking } : {}),
        ...(input.outputConfig ? { output_config: input.outputConfig } : {}),
      };
      const maxTokens = boundedMaxTokens(options, input.maxTokens);
      const message = input.onText
        ? await send(options, { ...body, stream: true }, maxTokens, input.signal, readStream(input.onText, options.model, input.onServerBlock))
        : await send(options, body, maxTokens, input.signal);
      return readTurn(message, options.model);
    },
  };
}
