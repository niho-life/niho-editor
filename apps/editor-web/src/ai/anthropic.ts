import "server-only";
import type { AiModel, AiRequest, AiResult, AiUsageReport } from "./model";
import { buildPrompt } from "./prompt";

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
};

/** モデルが呼んだ道具 1 回（`input` はモデルが作った値なので信用しない）。 */
export type ToolCall = { id: string; name: string; input: unknown };

/**
 * 道具つきの 1 往復の答え。`text` はこの往復で書いた文（実況・返答）、`toolCalls` は呼ばれた道具、
 * `stopReason` は `tool_use`（道具の結果を返すと続く）・`end_turn`（終わり）・`max_tokens`（出力の上限で切れた）など。
 */
export type Turn = { text: string; toolCalls: ToolCall[]; stopReason: string | null; usage: AiUsageReport };

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

/**
 * 提案の 1 回の要求の出力の上限。書き直しは送った文と同じくらいの長さで返る（日本語は 1 字 1〜1.5 トークン。JSON と思考の分も要る）ので、
 * 送る編集できる段落の文字数の 3 倍に 1,024 を足し、`EDITOR_AI_MAX_TOKENS` で止める（小さな依頼で出力が暴走しないように）。
 */
export function proposalMaxTokens(request: AiRequest, limit: number): number {
  const chars = request.paragraphs.reduce((sum, paragraph) => (paragraph.kind === "context" ? sum : sum + Array.from(paragraph.text).length), 0);
  return Math.min(limit, 1024 + chars * 3);
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

function readUsage(message: Record<string, unknown>, requested: string): AiUsageReport {
  const usage = isPlainObject(message.usage) ? message.usage : {};
  const model = typeof message.model === "string" && message.model.length > 0 ? message.model : requested;
  return { model, inputTokens: tokens(usage.input_tokens), outputTokens: tokens(usage.output_tokens) };
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
  system: string;
  messages: unknown[];
  tools?: unknown[];
  thinking?: { type: "adaptive" };
  output_config?: { effort: "low" | "medium" | "high" };
};

/**
 * 道具つきの往復の答えを読む。文（text）は連ねて 1 つにし、道具（tool_use）は呼ばれた順に並べる。
 * 断られた（refusal）ときだけ invalid_output（使用量は持たせる）。出力の上限で切れたのは `stopReason` で返し、
 * 会話の側が「途中で止まりました」として扱う（書いた分の道具の結果は残っている）。
 */
function readTurn(message: Record<string, unknown>, requested: string): Turn {
  const usage = readUsage(message, requested);
  if (message.stop_reason === "refusal") throw failure("invalid_output", { reason: "refusal", usage });
  const content = Array.isArray(message.content) ? message.content : [];
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const item of content) {
    if (!isPlainObject(item)) continue;
    if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
    else if (item.type === "tool_use" && typeof item.id === "string" && typeof item.name === "string") {
      toolCalls.push({ id: item.id, name: item.name, input: item.input });
    }
  }
  return {
    text: texts.join("\n").trim(),
    toolCalls,
    stopReason: typeof message.stop_reason === "string" ? message.stop_reason : null,
    usage,
  };
}

async function send(options: AnthropicOptions, body: MessagesBody, maxTokens: number, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  // 鍵は呼ぶたびに読む。無ければ呼ばない
  const key = options.env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (key === "") throw failure("auth");

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs(options.env));
  const onAbort = () => controller.abort();
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
    let message: unknown;
    try {
      message = await response.json();
    } catch {
      throw interrupted("invalid_output", { reason: "bad_body" });
    }
    if (!isPlainObject(message)) throw failure("invalid_output", { reason: "bad_body" });
    return message;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
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
      const message = await send(options, body, boundedMaxTokens(options, input.maxTokens), input.signal);
      return readTurn(message, options.model);
    },
  };
}

const FENCED = /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i;

/** モデルの出力の JSON（```json … ``` で囲まれていたら外す）。読めなければ invalid_output（使用量は持たせる）。 */
function parseJsonOutput(text: string, usage: AiUsageReport): unknown {
  const fenced = FENCED.exec(text);
  try {
    return JSON.parse(fenced ? fenced[1]! : text);
  } catch {
    throw failure("invalid_output", { reason: "not_json", usage });
  }
}

/** 提案のモデル（AiModel）。プロンプトは buildPrompt（本文は system ではなく信頼しないデータの枠に入る）。 */
export function createAnthropicModel(options: AnthropicOptions): AiModel {
  const client = createAnthropicClient(options);
  return {
    async run(request: AiRequest, signal?: AbortSignal): Promise<AiResult> {
      const prompt = buildPrompt(request);
      const { text, usage } = await client.complete({ system: prompt.system, user: prompt.user, maxTokens: proposalMaxTokens(request, maxTokensLimit(options.env)), signal });
      return { output: parseJsonOutput(text, usage), usage };
    },
  };
}
