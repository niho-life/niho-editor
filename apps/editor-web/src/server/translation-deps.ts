import "server-only";
import {
  adoptTranslationProposal,
  detachManagedTranslation,
  failTranslationProposal,
  finishTranslationProposal,
  getAiUsage,
  getLatestTranslationProposal,
  getTranslationProposal,
  getTranslationRelation,
  markTranslationCopy,
  monthKeyJst,
  readTranslationSource,
  recordAiUsage,
  reviewManagedTranslation,
  startTranslationProposal,
} from "@niho/editor-store";
import { monthlyLimitUsd, resolveAiCompose } from "../ai/config";
import { getAuthProvider } from "../auth";
import { createPrivateJobPayloadCipher } from "../storage/private-job-payload";
import { getStorage } from "../storage/runtime";
import { getPool, getStore } from "./db";
import type { TranslationApiDeps } from "./translation-api";

/** 管理翻訳は既存Editor DB・AI usage・ObjectStorageだけに配線し、鍵なしではこの機能だけ閉じる。 */
export const translationDeps: TranslationApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const pool = getPool();
    const editor = getStore();
    if (!pool || !editor) return null;
    return {
      page: (owner, pageId) => editor.getPage(owner, pageId),
      source: (owner, pageId) => readTranslationSource(pool, owner, pageId),
      start: (owner, pageId, input) => startTranslationProposal(pool, owner, pageId, input),
      latest: (owner, sourcePageId) => getLatestTranslationProposal(pool, owner, sourcePageId),
      proposal: (owner, proposalId) => getTranslationProposal(pool, owner, proposalId),
      finish: (owner, proposalId, generation, operationId, envelope) => finishTranslationProposal(pool, owner, proposalId, generation, operationId, envelope),
      fail: (owner, proposalId, generation, operationId, errorCode) => failTranslationProposal(pool, owner, proposalId, generation, operationId, errorCode),
      markCopy: (owner, proposalId, sourceAssetId, result) => markTranslationCopy(pool, owner, proposalId, sourceAssetId, result),
      adopt: (owner, proposalId, input) => adoptTranslationProposal(pool, owner, proposalId, input),
      relation: (owner, pageId) => getTranslationRelation(pool, owner, pageId),
      review: (owner, targetPageId, sourceRevision, targetRevision) => reviewManagedTranslation(pool, owner, targetPageId, sourceRevision, targetRevision),
      detach: (owner, targetPageId, targetRevision) => detachManagedTranslation(pool, owner, targetPageId, targetRevision),
    };
  },
  storage: () => getStorage(),
  cipher: () => process.env.EDITOR_PRIVATE_JOBS_MAINTENANCE_ENABLED === "true"
    ? createPrivateJobPayloadCipher({ EDITOR_PRIVATE_JOBS_KEY_RING: process.env.EDITOR_PRIVATE_JOBS_KEY_RING }) : null,
  compose: () => resolveAiCompose(process.env),
  usage: () => {
    const pool = getPool();
    return pool ? {
      get: (owner, month) => getAiUsage(pool, owner, month, "server"),
      record: (owner, month, delta) => recordAiUsage(pool, owner, month, delta, "server"),
    } : null;
  },
  limitUsd: () => monthlyLimitUsd(process.env),
  monthKey: monthKeyJst,
};
