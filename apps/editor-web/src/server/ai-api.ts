import {
  monthKeyJst,
  type AiConversation,
  type AiConversationSummary,
  type AiUsageSource,
  type AiUsageTotals,
  type OwnerId,
} from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { errorResponse, jsonResponse, notFoundResponse } from "./http";

/**
 * AI の会話の読み出しと使用量の API（設計 §6・Issue #38）。
 *
 * 提案 → 採用の API（`/ai/proposals`・`/ai/adoptions`・`/ai/proposals/device`）は、画面から呼ばれなくなったので外した
 * （#278。オーナー決定 2026-11-06）。ページを書き換える AI はチャット（chat-api.ts）だけ。会話の表・列は残っている
 * （古い提案の発言も履歴として読める。落とすのは後の contract の migration）。
 *
 * pages-api.ts・deps.ts と並行して触らないよう、依存の型と guarded をここに置いている（search-api.ts と同じ作り）。
 */

/** 使用量の読み出し（packages/editor-store の getAiUsage・getAiUsageBySource に Pool を渡したもの）。 */
export type AiUsageStore = {
  /** 経路ごとの合計（既定はサーバーの API＝月の上限が効く方）。 */
  get: (owner: OwnerId, month: string, source?: AiUsageSource) => Promise<AiUsageTotals>;
  /** 経路ごとに分けた合計（設定の画面に出す）。 */
  bySource?: (owner: OwnerId, month: string) => Promise<Record<AiUsageSource, AiUsageTotals>>;
};

/** 会話の読み出し（packages/editor-store の ai-conversations.ts に Pool を渡したもの）。 */
export type AiConversationStore = {
  list: (owner: OwnerId, pageId: string) => Promise<AiConversationSummary[] | null>;
  get: (owner: OwnerId, pageId: string, conversationId: string) => Promise<AiConversation | null>;
};

/** AI の route が使うもの。route から渡す（テストでは差し替える）。 */
export type AiApiDeps = {
  auth: () => AuthProvider;
  usage: () => AiUsageStore | null;
  /** 会話（AI チャット）。DB が使えないときは null（503）。 */
  conversations: () => AiConversationStore | null;
  /** 月の上限（USD）。null は上限なし。 */
  limitUsd: () => number | null;
  now?: () => Date;
};

/** その月の使用量（設定に出す。上限に近いときだけ箱に一言）。 */
export type UsageSummary = {
  month: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  limitUsd: number | null;
  /** 使用額が上限の 80% 以上。 */
  nearLimit: boolean;
};

/**
 * 想定外の失敗は 500 の汎用エラー（内部の情報は応答に出さず、ログにも名前と code だけを書く）。
 * pages-api.ts の guarded と同じ。
 */
async function guarded(route: string, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
    console.error("editor-web: request failed", { route, name, code });
    return errorResponse("internal");
  }
}

function limitMicroUsd(limitUsd: number | null): number | null {
  return limitUsd === null ? null : Math.round(limitUsd * 1e6);
}

function summarize(totals: AiUsageTotals, limitUsd: number | null): UsageSummary {
  const limit = limitMicroUsd(limitUsd);
  return {
    month: totals.month,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    costUsd: totals.costMicroUsd / 1e6,
    limitUsd,
    // 80% 以上（整数の micro-USD で比べる）
    nearLimit: limit !== null && totals.costMicroUsd * 5 >= limit * 4,
  };
}

function currentMonth(deps: AiApiDeps): string {
  return monthKeyJst(deps.now ? deps.now() : new Date());
}

/**
 * GET /api/pages/{id}/ai/conversations — そのページの会話の一覧（新しい順）。AI が無効でも答える（履歴は読める）。
 * 他人のページ・無いページは同じ 404。
 */
export function listAiConversations(request: Request, id: string, deps: AiApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/ai/conversations", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const chats = deps.conversations();
    if (!chats) return errorResponse("unavailable");
    const conversations = await chats.list(session.userId, id);
    if (!conversations) return notFoundResponse();
    return jsonResponse(200, { conversations });
  });
}

/**
 * GET /api/pages/{id}/ai/conversations/{conversationId} — 1 つの会話とその発言（古い順）。
 * 他人の会話・このページでない会話・無いページは同じ 404。
 */
export function getAiConversation(request: Request, id: string, conversationId: string, deps: AiApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/ai/conversations/[conversationId]", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const chats = deps.conversations();
    if (!chats) return errorResponse("unavailable");
    const found = await chats.get(session.userId, id, conversationId);
    if (!found) return notFoundResponse();
    return jsonResponse(200, found);
  });
}

/**
 * GET /api/ai/usage — 今月（Asia/Tokyo）の使用量。AI が無効でも答える（設定に出す用）。
 * `usage` はサーバーの API の経路（**月の上限が効くのはこれだけ**）、`device` はこの Mac の CLI の経路
 * （利用者のサブスクなので金額は 0 で、上限では止めない）。
 */
export function getAiUsageSummary(request: Request, deps: AiApiDeps): Promise<Response> {
  return guarded("GET /api/ai/usage", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const usage = deps.usage();
    if (!usage) return errorResponse("unavailable");
    const month = currentMonth(deps);
    const limitUsd = deps.limitUsd();
    const both = await usage.bySource?.(session.userId, month);
    const server = both?.server ?? (await usage.get(session.userId, month));
    const device = both?.device ?? null;
    return jsonResponse(200, {
      usage: summarize(server, limitUsd),
      device: device ? { month: device.month, requests: device.requests, inputTokens: device.inputTokens, outputTokens: device.outputTokens } : null,
    });
  });
}
