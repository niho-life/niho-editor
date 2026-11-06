import { tokenPrice, type ProviderId } from "@niho/docs-core";
import type { AiUsageSource } from "@niho/editor-store";
import { createAnthropicClient, type AnthropicClient, type AnthropicEnv } from "./anthropic";
import { createFakeClient, FAKE_CLIENT_MODEL } from "./fake-client";

/**
 * AI の有効・無効（`EDITOR_AI_MODE`）と月の上限（`EDITOR_AI_MONTHLY_LIMIT_USD`）。要求のたびに読む（build のときに固めない）。
 *
 * - 未設定・`off`: AI の route（チャット・手順の段階・翻訳）は使えない（`ai_unavailable`）。使用量の取得は動く。
 * - `anthropic`: 本物のモデル（anthropic.ts。モデルは `EDITOR_AI_MODEL`、既定 `claude-sonnet-5-5`）。`ANTHROPIC_API_KEY` が空・未設定、
 *   モデル名の形が違う・単価表（docs-core の pricing）に無いときは 503（閉じたまま。金額を数えられないと月の上限が効かないため）。
 * - `fake`: 偽物のモデル（開発と CI だけ）。`NODE_ENV=production` では受け付けない（偽物の文を本番の利用者に見せない）。
 * - それ以外: 未知（503）。
 */

export type AiEnv = AnthropicEnv & {
  readonly NODE_ENV?: string | undefined;
  readonly EDITOR_AI_MODE?: string | undefined;
  readonly EDITOR_AI_MODEL?: string | undefined;
  readonly EDITOR_AI_MONTHLY_LIMIT_USD?: string | undefined;
};

/**
 * 文を作ったのが誰か（会話と使用量に残す）。`route` は `server`（サーバーの API。従量がかかる）か
 * `device`（この Mac の CLI。利用者のサブスクなので従量が出ない）。`engine` は短い id。
 */
export type AiAuthor = { route: AiUsageSource; engine: string };

/**
 * 文書を作る側（手順の段階。steps/ai-executor.ts）が使う 1 往復の口。`model` は使用量に記録する名前。
 * 有効・無効は `EDITOR_AI_MODE` と単価表で決める。
 */
export type AiComposeBackend = AiAuthor & { client: AnthropicClient; model: string; provider: ProviderId | null };

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";
/** モデル名の形（URL やヘッダーに混ぜられる文字を入れない）。 */
const MODEL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const fakeCompose: AiComposeBackend = { client: createFakeClient(), model: FAKE_CLIENT_MODEL, provider: null, route: "server", engine: "fake:fake" };

/**
 * 文書を作る側の口（手順の段階）。使えないときは null（段階は `ai_unavailable` で失敗する）。
 * 単価の無いモデルは、使った金額を数えられない（月の上限が効かない）ので閉じたまま。
 */
export function resolveAiCompose(env: AiEnv): AiComposeBackend | null {
  const mode = env.EDITOR_AI_MODE?.trim() ?? "";
  if (mode === "fake") return env.NODE_ENV === "production" ? null : fakeCompose;
  if (mode !== "anthropic") return null;
  if ((env.ANTHROPIC_API_KEY?.trim() ?? "") === "") return null;
  const model = env.EDITOR_AI_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL;
  if (!MODEL_NAME.test(model)) return null;
  if (tokenPrice("claude", model) === null) return null;
  return { client: createAnthropicClient({ model, env }), model, provider: "claude", route: "server", engine: `anthropic:${model}` };
}

/**
 * 月の上限（USD）。未設定・空は上限なし（null）。0 以上の数でない値は 0（AI を止める側に倒す）。
 */
export function monthlyLimitUsd(env: AiEnv): number | null {
  const raw = env.EDITOR_AI_MONTHLY_LIMIT_USD?.trim() ?? "";
  if (raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
