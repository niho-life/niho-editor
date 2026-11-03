import { estimateTokenCostUsd } from "@niho/docs-core";
import {
  DEFAULT_EDITOR_SETTINGS,
  isPositiveInteger,
  monthKeyJst,
  type AdoptionInput,
  type AiConversation,
  type AiConversationSummary,
  type AiMessage,
  type AiTurn,
  type AiTurnInput,
  type AiUsageDelta,
  type AiUsageSource,
  type AiUsageTotals,
  type EditorSettings,
  type Block,
  type EditorStore,
  type OwnerId,
  type ReferencePage,
} from "@niho/editor-store";
import { AnthropicError } from "../ai/anthropic";
import type { AiBackend } from "../ai/config";
import { applyAdoptions, blockText, buildProposal, buildRequest, type Adoptions, type AiRun, type AiScope, type Proposal, type ProposalChange, type ProposalInsert, type ProposalResult } from "../ai/engine";
import { diffWords } from "../ai/diff";
import { referencesFrom } from "../ai/references";
import type { AiInsertKind, AiUsageReport } from "../ai/model";
import { MAX_INTENT_TEXT_CHARS, intentLabel, parseIntent, type AiIntent } from "../ai/presets";
import type { AuthProvider } from "../auth/types";
import { conflictResponse, errorResponse, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";
import { parseBlocks } from "./page-input";

/**
 * AI の提案と採用・使用量の API（設計 §6・Issue #38）。
 *
 * - 提案はページに何も書かない（版も残さない）。採用のときだけ、今の本文を版（ai）に残してから保存する。
 * - モデルと鍵はサーバー側（src/ai/config.ts）。`EDITOR_AI_MODE` が無効なら提案・採用は 503 `ai_unavailable`。
 *
 * pages-api.ts・deps.ts と並行して触らないよう、依存の型と guarded をここに置いている（search-api.ts と同じ作り）。
 */

/** AI の route が使う store の操作。 */
export type AiPagesStore = Pick<EditorStore, "getPage" | "savePage" | "createVersion">;

/** 使用量の読み書き（packages/editor-store の getAiUsage・recordAiUsage に Pool を渡したもの）。 */
export type AiUsageStore = {
  /** 経路ごとの合計（既定はサーバーの API＝月の上限が効く方）。 */
  get: (owner: OwnerId, month: string, source?: AiUsageSource) => Promise<AiUsageTotals>;
  record: (owner: OwnerId, month: string, delta: AiUsageDelta, source?: AiUsageSource) => Promise<AiUsageTotals>;
  /** 経路ごとに分けた合計（設定の画面に出す）。 */
  bySource?: (owner: OwnerId, month: string) => Promise<Record<AiUsageSource, AiUsageTotals>>;
};

/** 会話の読み書き（packages/editor-store の ai-conversations.ts に Pool を渡したもの）。 */
export type AiConversationStore = {
  append: (owner: OwnerId, input: AiTurnInput) => Promise<AiTurn | null>;
  list: (owner: OwnerId, pageId: string) => Promise<AiConversationSummary[] | null>;
  get: (owner: OwnerId, pageId: string, conversationId: string) => Promise<AiConversation | null>;
  message: (owner: OwnerId, pageId: string, messageId: string) => Promise<AiMessage | null>;
  adopt: (owner: OwnerId, input: AdoptionInput) => Promise<boolean>;
};

/** AI の route が使うもの。route から渡す（テストでは差し替える）。 */
export type AiApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503）。 */
  store: () => AiPagesStore | null;
  usage: () => AiUsageStore | null;
  /** 会話（AI チャット）。DB が使えないときは null（503）。 */
  conversations: () => AiConversationStore | null;
  /** 自動参考ページ（同じフォルダの直下のほかのページ）。渡さない・読めないときは参考なし。 */
  references?: () => ((owner: OwnerId, pageId: string) => Promise<ReferencePage[] | null>) | null;
  /** 設定（固有名詞と提案の言語。#108）。渡さない・読めないときは既定値（語彙なし・本文の言語のまま）。 */
  settings?: () => ((owner: OwnerId) => Promise<EditorSettings>) | null;
  /** 使えるモデル。無効のときは null（503 `ai_unavailable`）。 */
  ai: () => AiBackend | null;
  /** 月の上限（USD）。null は上限なし。 */
  limitUsd: () => number | null;
  now?: () => Date;
  env?: Readonly<Record<string, string | undefined>>;
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

type AiErrorCode = "quota_exceeded" | "ai_unavailable" | "ai_failed" | "too_large";

const AI_STATUS: Record<AiErrorCode, number> = {
  // 今月の使用額が上限以上（モデルを呼ぶ前に止める）
  quota_exceeded: 429,
  // AI を使わない設定（未設定・off・本番での fake・未知の値）
  ai_unavailable: 503,
  // モデルが失敗した・出力が検証に通らない
  ai_failed: 502,
  // 送る本文が 30,000 文字を超える（範囲を選んで頼む）
  too_large: 413,
};

/** http.ts に無い AI の code。header は他の応答と同じ（jsonResponse）。 */
function aiErrorResponse(code: AiErrorCode): Response {
  return jsonResponse(AI_STATUS[code], { error: code });
}

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

/**
 * 会話への記録は、提案を返す・ページを保存するより**後のおまけ**。ここで失敗しても応答は壊さない
 * （モデルを呼んだ分は課金済みで、保存は既に済んでいる。500 を返すと、成功したのに失敗に見える）。
 * ログに出すのは route と失敗の名前だけ（本文・理由は出さない）。
 */
async function recorded<T>(route: string, work: () => Promise<T | null>): Promise<T | null> {
  try {
    const result = await work();
    if (result === null) console.error("editor-web: conversation not recorded", { route });
    return result;
  } catch (error) {
    console.error("editor-web: conversation not recorded", { route, name: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

type InputResult<T> = { ok: true; value: T } | { ok: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isNonNegativeIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

type ProposalInput = { baseRevision: number; intent: AiIntent; scope: AiScope | undefined; conversationId: string | null };

/** POST …/ai/proposals の本文。範囲が本文の内側か・会話がこのページのものかはページを読んでから確かめる。 */
function parseProposalBody(body: unknown): InputResult<ProposalInput> {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["baseRevision", "intent", "scope", "conversationId"])) return { ok: false };
  if (!isPositiveInteger(body.baseRevision)) return { ok: false };
  const intent = parseIntent(body.intent);
  if (!intent) return { ok: false };
  if (body.conversationId !== undefined && body.conversationId !== null && typeof body.conversationId !== "string") return { ok: false };
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
  let scope: AiScope | undefined;
  if (body.scope !== undefined) {
    const raw = body.scope;
    if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["fromIndex", "toIndex"])) return { ok: false };
    if (!isNonNegativeIndex(raw.fromIndex) || !isNonNegativeIndex(raw.toIndex) || raw.fromIndex > raw.toIndex) return { ok: false };
    scope = { fromIndex: raw.fromIndex, toIndex: raw.toIndex };
  }
  return { ok: true, value: { baseRevision: body.baseRevision, intent, scope, conversationId } };
}

const INSERT_KINDS: readonly string[] = ["paragraph", "heading", "callout"] satisfies readonly AiInsertKind[];

/** POST …/ai/adoptions の本文（採用するものだけ。両方空は断る）。位置と文の中身は applyAdoptions が今の本文で確かめる。 */
function parseAdoptionBody(body: unknown): InputResult<Adoptions & { baseRevision: number; messageId: string | null }> {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["baseRevision", "changes", "inserts", "messageId"])) return { ok: false };
  if (!isPositiveInteger(body.baseRevision)) return { ok: false };
  if (body.messageId !== undefined && body.messageId !== null && typeof body.messageId !== "string") return { ok: false };
  const messageId = typeof body.messageId === "string" ? body.messageId : null;
  const rawChanges = body.changes ?? [];
  const rawInserts = body.inserts ?? [];
  if (!Array.isArray(rawChanges) || !Array.isArray(rawInserts)) return { ok: false };
  if (rawChanges.length === 0 && rawInserts.length === 0) return { ok: false };
  const changes: Adoptions["changes"] = [];
  for (const raw of rawChanges) {
    if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["index", "text"])) return { ok: false };
    if (!isNonNegativeIndex(raw.index) || typeof raw.text !== "string") return { ok: false };
    changes.push({ index: raw.index, text: raw.text });
  }
  const inserts: Adoptions["inserts"] = [];
  for (const raw of rawInserts) {
    if (!isPlainObject(raw) || !hasOnlyKeys(raw, ["afterIndex", "kind", "text"])) return { ok: false };
    if (typeof raw.afterIndex !== "number" || !Number.isSafeInteger(raw.afterIndex) || raw.afterIndex < -1) return { ok: false };
    if (typeof raw.kind !== "string" || !INSERT_KINDS.includes(raw.kind) || typeof raw.text !== "string") return { ok: false };
    inserts.push({ afterIndex: raw.afterIndex, kind: raw.kind as AiInsertKind, text: raw.text });
  }
  return { ok: true, value: { baseRevision: body.baseRevision, changes, inserts, messageId } };
}

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 1 回の呼び出しの使用量を足す。金額は単価表の見込み（micro-USD に丸める）。単価が分からない・偽物は 0。 */
function addUsage(total: AiUsageDelta, backend: AiBackend, usage: AiUsageReport): void {
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  const usd = backend.provider ? estimateTokenCostUsd(backend.provider, usage.model, inputTokens, outputTokens) : null;
  total.requests += 1;
  total.inputTokens += inputTokens;
  total.outputTokens += outputTokens;
  total.costMicroUsd += usd === null ? 0 : count(Math.round(usd * 1e6));
}

function limitMicroUsd(limitUsd: number | null): number | null {
  return limitUsd === null ? null : Math.round(limitUsd * 1e6);
}

function overLimit(totals: AiUsageTotals, limitUsd: number | null): boolean {
  const limit = limitMicroUsd(limitUsd);
  return limit !== null && totals.costMicroUsd >= limit;
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
 * POST /api/pages/{id}/ai/proposals — AI の提案（ページには何も書かない）。
 * `baseRevision` が今の revision と違えば 409 と今のページ。今月の使用額が上限以上なら、モデルを呼ぶ前に 429。
 * 長いページは段落の切れ目で分けて頼み、結果を 1 つの提案にまとめる。モデルの失敗・不正な出力は 502（使った分は記録する）。
 */
export function createAiProposal(request: Request, id: string, deps: AiApiDeps): Promise<Response> {
  const route = "POST /api/pages/[id]/ai/proposals";
  return guarded(route, async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    const usage = deps.usage();
    const chats = deps.conversations();
    if (!store || !usage || !chats) return errorResponse("unavailable");
    const backend = deps.ai();
    if (!backend) return aiErrorResponse("ai_unavailable");
    // 本文の検査は id の有無より先（どの id でも同じ順に判定し、存在を漏らさない）
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = parseProposalBody(body.value);
    if (!input.ok) return errorResponse("bad_request");
    const owner = session.userId;
    const page = await store.getPage(owner, id);
    if (!page) return notFoundResponse();
    if (page.revision !== input.value.baseRevision) return conflictResponse(page);
    // 続ける会話は、モデルを呼ぶ前に確かめる（他人の会話・このページでない会話は 404）
    const conversationId = input.value.conversationId;
    if (conversationId !== null && !(await chats.get(owner, id, conversationId))) return notFoundResponse();
    const settings = (await deps.settings?.()?.(owner)) ?? DEFAULT_EDITOR_SETTINGS;
    // 自動参考ページ（同じフォルダの直下のほかのページ。読めなければ参考なしで進む）
    const references = referencesFrom((await deps.references?.()?.(owner, id)) ?? []);
    const plan = buildRequest(page, input.value.intent, input.value.scope, {
      glossary: settings.glossary,
      // 「書いた言語のまま」は本文の言語（buildRequest の既定）
      lang: settings.aiLang === "same" ? undefined : settings.aiLang,
      about: { name: settings.aboutName, text: settings.about },
      references,
    });
    if (!plan.ok) return plan.error === "too_large" ? aiErrorResponse("too_large") : errorResponse("bad_request");

    const month = currentMonth(deps);
    const limitUsd = deps.limitUsd();
    const before = await usage.get(owner, month);
    if (overLimit(before, limitUsd)) return aiErrorResponse("quota_exceeded");

    const runs: AiRun[] = [];
    const delta: AiUsageDelta = { requests: 0, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 };
    let failed = false;
    for (const aiRequest of plan.requests) {
      try {
        const result = await backend.model.run(aiRequest, request.signal);
        addUsage(delta, backend, result.usage);
        runs.push({ request: aiRequest, output: result.output });
      } catch (error) {
        console.error("editor-web: ai model failed", { route, name: error instanceof Error ? error.name : "unknown" });
        // 応答は届いたが使えなかった（JSON でない・途中で切れた）ときも課金されているので、その分も数える
        if (error instanceof AnthropicError && error.usage) addUsage(delta, backend, error.usage);
        failed = true;
        break;
      }
    }
    // 失敗しても、それまでに使った分は記録する
    const totals = delta.requests > 0 ? await usage.record(owner, month, delta, backend.route) : before;
    if (failed) return aiErrorResponse("ai_failed");
    const built = buildProposal(page.blocks, runs, input.value.intent, page.revision);
    if (!built.ok) {
      // 理由は検証の決まった文だけ（モデルの出力そのものは書かない）
      console.error("editor-web: ai output rejected", { route, reason: built.reason });
      return aiErrorResponse("ai_failed");
    }
    // 会話に 1 回のやりとり（頼んだこと → 提案）を足す。**記録に失敗しても提案は返す**
    // （ページが消えた・提案が会話の上限より大きい・DB が一時的に落ちた、のどれでも提案そのものは使える）
    const turn = await recorded(route, () =>
      chats.append(owner, {
        pageId: id,
        conversationId,
        request: { text: intentLabel(input.value.intent), ...("preset" in input.value.intent ? { preset: input.value.intent.preset } : {}) },
        result: { text: resultText(built.proposal), proposal: built.proposal },
        author: { route: backend.route, engine: backend.engine },
      }),
    );
    return jsonResponse(200, {
      proposal: built.proposal,
      usage: summarize(totals, limitUsd),
      conversation: turn ? { id: turn.conversation.id, messageId: turn.result.id } : null,
    });
  });
}

/** 会話に残す AI の返事の一言（件数だけ。本文は提案そのものが持つ）。 */
function resultText(proposal: Proposal): string {
  const items = proposal.changes.length + proposal.inserts.length;
  return items === 0 ? "変えるところはありませんでした" : `提案が ${items} 件あります`;
}

/**
 * POST /api/pages/{id}/ai/adoptions — 採用したものだけを保存する。今の本文を版（ai）に残してから、`baseRevision` 付きで保存する
 * （履歴から戻せる）。`baseRevision` が違えば 409 と今のページ。当てた結果が保存できる形でなければ 400（何も書かない）。
 */
export function adoptAiProposal(request: Request, id: string, deps: AiApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/ai/adoptions", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    const chats = deps.conversations();
    if (!store || !deps.usage() || !chats) return errorResponse("unavailable");
    if (!deps.ai()) return aiErrorResponse("ai_unavailable");
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = parseAdoptionBody(body.value);
    if (!input.ok) return errorResponse("bad_request");
    const owner = session.userId;
    const page = await store.getPage(owner, id);
    if (!page) return notFoundResponse();
    const { baseRevision, changes, inserts, messageId } = input.value;
    if (page.revision !== baseRevision) return conflictResponse(page);
    // 繋ぐ提案の発言は、何かを書く前に確かめる（他人の会話・このページでない会話は 404）
    if (messageId !== null && !(await chats.message(owner, id, messageId))) return notFoundResponse();
    const applied = applyAdoptions(page.blocks, { changes, inserts });
    if (!applied.ok) return errorResponse("bad_request");
    // 保存のときと同じ大きさ・深さの検査
    const blocks = parseBlocks(applied.blocks);
    if (!blocks.ok) return errorResponse("bad_request");
    // 1 トランザクションにまとめるのは後段（版を残した後に別の保存が先に入れば、版は残ったまま 409 になる）
    const version = await store.createVersion(owner, id, "ai");
    if (!version) return notFoundResponse();
    const result = await store.savePage(owner, id, { blocks: blocks.value }, { baseRevision });
    if (!result) return notFoundResponse();
    if (result.status === "page_full") return errorResponse("page_full");
    if (result.status !== "saved") return conflictResponse(result.page);
    // 採用を会話に書く（版の番号で履歴から辿れる）。書けなくてもページの保存は済んでいるので 200 のまま
    let adopted: { messageId: string; version: number } | null = null;
    if (messageId !== null) {
      // **ページの保存は済んでいる**ので、会話に書けなくても 200 のまま返す（成功したのに失敗に見せない）
      const written = await recorded("POST /api/pages/[id]/ai/adoptions", async () =>
        (await chats.adopt(owner, { pageId: id, messageId, version: version.version, adopted: { changes, inserts } })) ? true : null,
      );
      if (written) adopted = { messageId, version: version.version };
    }
    return jsonResponse(200, { page: result.page, adopted });
  });
}

/** この Mac の CLI が作った提案（`POST …/ai/proposals/device`）。モデルはサーバーで呼ばない。 */
type DeviceProposalInput = {
  conversationId: string | null;
  baseRevision: number;
  input: string;
  reply: string;
  engine: string;
  label: string;
  changes: { index: number; text: string }[];
  inserts: ProposalInsert[];
};

/** エンジンの短い id（鍵・端末の情報を入れない）。chat-api.ts と同じ形。 */
const ENGINE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,95}$/;

function parseDeviceProposalBody(body: unknown): InputResult<DeviceProposalInput> {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["conversationId", "baseRevision", "input", "reply", "engine", "label", "changes", "inserts"])) return { ok: false };
  if (!isPositiveInteger(body.baseRevision)) return { ok: false };
  if (typeof body.engine !== "string" || !ENGINE_PATTERN.test(body.engine)) return { ok: false };
  if (body.conversationId !== undefined && body.conversationId !== null && typeof body.conversationId !== "string") return { ok: false };
  if (typeof body.input !== "string") return { ok: false };
  const input = body.input.trim();
  if (Array.from(input).length === 0 || Array.from(input).length > MAX_INTENT_TEXT_CHARS || input.includes("\u0000")) return { ok: false };
  if (body.reply !== undefined && typeof body.reply !== "string") return { ok: false };
  if (body.label !== undefined && typeof body.label !== "string") return { ok: false };
  const adoptions = parseAdoptionBody({ baseRevision: body.baseRevision, changes: body.changes ?? [], inserts: body.inserts ?? [] });
  if (!adoptions.ok) return { ok: false };
  return {
    ok: true,
    value: {
      conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
      baseRevision: body.baseRevision,
      input,
      reply: typeof body.reply === "string" ? body.reply.trim() : "",
      engine: body.engine,
      label: typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim().slice(0, 200) : input,
      changes: adoptions.value.changes,
      inserts: adoptions.value.inserts,
    },
  };
}

/**
 * POST /api/pages/{id}/ai/proposals/device — **この Mac の CLI が作った提案**を受ける（設計 §6.1 の Mac の往復）。
 * サーバーはモデルを呼ばず、**差分は今の本文から自分で作る**（送られてきた差分は信用しない）。ページは変わらず、
 * 採用（`POST …/ai/adoptions`）のときだけ版に残して保存する＝ブラウザの提案とまったく同じ扱い。
 *
 * **月の上限には数えない**（利用者のサブスクで従量が出ないため）。使用量は `device` の行に回数だけ残る。
 * `baseRevision` が今の revision と違えば 409 と今のページ。未認証は 401、他人のページ・無いページ・他人の会話は同じ 404。
 */
export function recordDeviceProposal(request: Request, id: string, deps: AiApiDeps): Promise<Response> {
  const route = "POST /api/pages/[id]/ai/proposals/device";
  return guarded(route, async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    const usage = deps.usage();
    const chats = deps.conversations();
    if (!store || !usage || !chats) return errorResponse("unavailable");
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = parseDeviceProposalBody(body.value);
    if (!input.ok) return errorResponse("bad_request");

    const owner = session.userId;
    const page = await store.getPage(owner, id);
    if (!page) return notFoundResponse();
    if (page.revision !== input.value.baseRevision) return conflictResponse(page);
    const conversationId = input.value.conversationId;
    if (conversationId !== null && !(await chats.get(owner, id, conversationId))) return notFoundResponse();

    // 差分はサーバーが今の本文から作る（Mac から来た「前の文」は使わない）
    const built = deviceProposal(page.blocks, input.value);
    if (!built.ok) return errorResponse("bad_request");

    const turn = await recorded(route, () =>
      chats.append(owner, {
        pageId: id,
        conversationId,
        request: { text: input.value.input },
        result: { text: input.value.reply || resultText(built.proposal), proposal: built.proposal },
        author: { route: "device", engine: input.value.engine },
      }),
    );
    // 回数だけ数える（サブスクなので金額は 0。月の上限では止めない）
    const month = currentMonth(deps);
    await usage.record(owner, month, { requests: 1, inputTokens: 0, outputTokens: 0, costMicroUsd: 0 }, "device");
    return jsonResponse(200, {
      proposal: built.proposal,
      conversation: turn ? { id: turn.conversation.id, messageId: turn.result.id } : null,
    });
  });
}

/** 外で作った提案を、今の本文と突き合わせて組み直す（変わらない変更は落とし、差分はここで作る）。 */
function deviceProposal(blocks: readonly Block[], input: DeviceProposalInput): ProposalResult {
  const changes: ProposalChange[] = [];
  const seen = new Set<number>();
  for (const change of input.changes) {
    const block = blocks[change.index];
    if (!block || (block.type !== "paragraph" && block.type !== "heading")) return { ok: false, reason: "index is not an editable paragraph" };
    if (seen.has(change.index)) return { ok: false, reason: "duplicate index" };
    seen.add(change.index);
    const before = blockText(block);
    if (before === change.text) continue;
    changes.push({ index: change.index, before, after: change.text, parts: diffWords(before, change.text) });
  }
  for (const insert of input.inserts) {
    if (insert.afterIndex < -1 || insert.afterIndex >= blocks.length) return { ok: false, reason: "afterIndex out of range" };
  }
  changes.sort((a, b) => a.index - b.index);
  const inserts = [...input.inserts].sort((a, b) => a.afterIndex - b.afterIndex);
  return { ok: true, proposal: { label: input.label, baseRevision: input.baseRevision, changes, inserts, unchanged: input.changes.length - changes.length } };
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
