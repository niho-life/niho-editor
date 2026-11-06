import "server-only";
import { getAiUsage, getAiUsageBySource, getConversation, listConversations } from "@niho/editor-store";
import { monthlyLimitUsd } from "../ai/config";
import { getAuthProvider } from "../auth";
import type { AiApiDeps } from "./ai-api";
import { getPool } from "./db";

/**
 * AI の route（会話の読み出し・使用量）の実行時の依存（DB・上限は要求のたびに遅延して決める。Pool は getStore と共有）。
 * deps.ts と並行して触らないよう、ここに置いている。
 */
export const aiDeps: AiApiDeps = {
  auth: () => getAuthProvider(),
  usage: () => {
    const pool = getPool();
    return pool
      ? {
          get: (owner, month, source) => getAiUsage(pool, owner, month, source),
          bySource: (owner, month) => getAiUsageBySource(pool, owner, month),
        }
      : null;
  },
  conversations: () => {
    const pool = getPool();
    return pool
      ? {
          list: (owner, pageId) => listConversations(pool, owner, pageId),
          get: (owner, pageId, conversationId) => getConversation(pool, owner, pageId, conversationId),
        }
      : null;
  },
  limitUsd: () => monthlyLimitUsd(process.env),
};
