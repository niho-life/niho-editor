import "server-only";
import {
  appendChatTurn,
  getAiUsage,
  getChatChanges,
  getConversation,
  getEditorSettings,
  getPageFields,
  getRecording,
  getRunGuide,
  listChatWorkspace,
  listReferencePages,
  markChangesUndone,
  recordAiUsage,
} from "@niho/editor-store";
import { monthlyLimitUsd, resolveAiCompose } from "../ai/config";
import { getAuthProvider } from "../auth";
import type { ChatApiDeps } from "./chat-api";
import { getPool, getStore } from "./db";

/**
 * AI チャットの route の実行時の依存（DB・モデル・上限は要求のたびに遅延して決める。Pool は getStore と共有）。
 * ai-deps.ts と並行して触らないよう、ここに置いている。
 */
export const chatDeps: ChatApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const store = getStore();
    if (!store) return null;
    return {
      getPage: (owner, id) => store.getPage(owner, id),
      savePage: (owner, id, patch, options) => store.savePage(owner, id, patch, options),
      createVersion: (owner, id, reason) => store.createVersion(owner, id, reason),
      createPage: (owner, input) => store.createPage(owner, input),
      restoreVersion: (owner, id, version, options) => store.restoreVersion(owner, id, version, options),
      deletePage: (owner, id) => store.deletePage(owner, id),
    };
  },
  conversations: () => {
    const pool = getPool();
    if (!pool) return null;
    return {
      workspace: (owner, pageId) => listChatWorkspace(pool, owner, pageId),
      references: (owner, pageId) => listReferencePages(pool, owner, pageId),
      recording: (owner, pageId) => getRecording(pool, owner, pageId),
      fields: (owner, pageId) => getPageFields(pool, owner, pageId),
      guide: (owner, pageId) => getRunGuide(pool, owner, pageId),
      history: (owner, pageId, conversationId) => getConversation(pool, owner, pageId, conversationId),
      append: (owner, input) => appendChatTurn(pool, owner, input),
      changes: (owner, pageId, messageId) => getChatChanges(pool, owner, pageId, messageId),
      undone: (owner, messageId, pageIds) => markChangesUndone(pool, owner, messageId, pageIds),
    };
  },
  usage: () => {
    const pool = getPool();
    return pool
      ? {
          get: (owner, month, source) => getAiUsage(pool, owner, month, source),
          record: (owner, month, delta, source) => recordAiUsage(pool, owner, month, delta, source),
        }
      : null;
  },
  settings: () => {
    const pool = getPool();
    return pool ? (owner) => getEditorSettings(pool, owner) : null;
  },
  ai: () => resolveAiCompose(process.env),
  limitUsd: () => monthlyLimitUsd(process.env),
};
