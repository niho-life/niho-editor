import { MAX_CONTINUATIONS, estimateTokenCostUsd, joinContinuation } from "@niho/docs-core";
import {
  DEFAULT_EDITOR_SETTINGS,
  stepBlocksText,
  stepReferenceText,
  monthKeyJst,
  type AiUsageDelta,
  type AiUsageSource,
  type AiUsageTotals,
  type EditorSettings,
  type OwnerId,
  type ReferencePage,
} from "@niho/editor-store";
import { AnthropicError, maxTokensLimit, timeoutMs, type AnthropicErrorKind } from "../ai/anthropic";
import { buildComposePrompt, composeBlocks, composeMaxTokens, composeSourceUsedChars, parseComposeOutput, partialComposeBlocks, type ComposeInput, type ComposeSource } from "../ai/compose";
import type { AiComposeBackend } from "../ai/config";
import type { AiUsageReport } from "../ai/model";
import { referencesFrom } from "../ai/references";
import { StepError, type StepExecutor, type StepExecutorInput, type StepExecutorOutput } from "./executor";
import { stepGenerationOptions } from "./profile";

/**
 * 本物の段階の実行器（Issue #37 の実行器・#38 の AI を包んだもの）。偽物（executor.ts の fakeExecutor）の差し替え先で、
 * 配線は src/server/steps-deps.ts の 1 か所。
 *
 * 1 段階 = モデルの 1 往復（ai/compose.ts のプロンプト → AnthropicClient → 検証 → 本文のブロック）。
 * 資料は録音ページの本文、上流の全結果、録音ページ自身の背景（この録音について）、同じフォルダの参考ページ。
 *
 * - 月の上限は提案（server/ai-api.ts）と同じ意味で効く: 呼ぶ前に今月の使用額を見て、上限以上なら
 *   モデルを呼ばずに `quota_exceeded` で失敗する（再試行しない）。使った分は失敗しても記録する。
 * - ログ・エラーに鍵・プロンプト・本文を出さない（持つのは短い code と、あれば HTTP ステータスだけ）。
 */

/** 使用量の読み書き（server/ai-api.ts の AiUsageStore と同じ形）。 */
export type StepUsageStore = {
  get: (owner: OwnerId, month: string, source?: AiUsageSource) => Promise<AiUsageTotals>;
  record: (owner: OwnerId, month: string, delta: AiUsageDelta, source?: AiUsageSource) => Promise<AiUsageTotals>;
};

export type AiStepExecutorDeps = {
  /** 使える 1 往復の口（`EDITOR_AI_MODE` が無効なら null → `ai_unavailable`）。要求のたびに読む。 */
  compose: () => AiComposeBackend | null;
  /** 使用量（DB が無ければ null → `usage_unavailable`。金額を数えられないままモデルを呼ばない）。 */
  usage: () => StepUsageStore | null;
  /** 月の上限（USD）。null は上限なし。 */
  limitUsd: () => number | null;
  /** 設定（固有名詞・出力の言語・「あなたについて」。#108）。渡さない・読めないときは既定値。 */
  settings?: () => ((owner: OwnerId) => Promise<EditorSettings>) | null;
  /** 自動参考ページ（同じフォルダの直下のほかのページ）。渡さない・読めないときは参考なし。 */
  references?: () => ((owner: OwnerId, pageId: string) => Promise<ReferencePage[] | null>) | null;
  now?: () => Date;
  /** Monotonic clock and total budget are injectable for deterministic deadline tests. */
  monotonicNowMs?: () => number;
  stepBudgetMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
};

/** Cloud Tasks は最大 30 分。6 分を保存・終了処理用に残して、AI 呼び出しは 24 分で打ち切る。 */
export const MAX_STEP_GENERATION_MS = 24 * 60 * 1000;

/** 上流の失敗の種類から段階の失敗の code（`^[a-z0-9_]{1,64}$`）。 */
const ERROR_CODES: Record<AnthropicErrorKind, string> = {
  auth: "ai_auth",
  rate_limit: "ai_rate_limit",
  overloaded: "ai_overloaded",
  server: "ai_server",
  timeout: "ai_timeout",
  network: "ai_network",
  bad_request: "ai_bad_request",
  invalid_output: "invalid_output",
};

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 1 回の呼び出しの使用量（ai-api.ts の addUsage と同じ数え方。単価が分からない・偽物は金額 0）。 */
function usageDelta(backend: AiComposeBackend, usage: AiUsageReport): AiUsageDelta {
  const inputTokens = count(usage.inputTokens);
  const outputTokens = count(usage.outputTokens);
  const usd = backend.provider ? estimateTokenCostUsd(backend.provider, usage.model, inputTokens, outputTokens) : null;
  return { requests: 1, inputTokens, outputTokens, costMicroUsd: usd === null ? 0 : count(Math.round(usd * 1e6)) };
}

function overLimit(totals: AiUsageTotals, limitUsd: number | null): boolean {
  return limitUsd !== null && totals.costMicroUsd >= Math.round(limitUsd * 1e6);
}

/**
 * 原文と上流の全結果。録音の背景は独立した info section に渡す。
 * 区切って処理しているとき（#277）は、書き直す対象（段階 0 は録音ページの本文、段階 1 以降は直前の段階の結果）だけを
 * 今の区切りのテキストに置き換える。ほかの資料は区切らず、今の予算規則で添える。
 */
function sourcesOf(input: StepExecutorInput): ComposeSource[] {
  const sources: ComposeSource[] = [
    { label: "録音ページの本文", text: stepBlocksText(input.parentBlocks) },
    ...input.recipe.steps.slice(0, input.stepIndex).map((step, index) => ({
      label: `工程 ${index + 1} の結果`,
      text: stepBlocksText(input.materials?.upstream.find((item) => item.id === step.id)?.blocks ?? (index === input.stepIndex - 1 ? input.previousBlocks ?? [] : [])),
    })),
  ];
  if (input.chunk) {
    const target = sources[input.stepIndex]!;
    sources[input.stepIndex] = { label: `${target.label}（区切り ${input.chunk.index + 1}/${input.chunk.count}）`, text: input.chunk.text };
  }
  return sources;
}

/**
 * 本物の実行器。`StepExecutor` の形（executor.ts）はそのまま。`input.owner` は runner が claim で分かった
 * 持ち主を渡す（月の上限と使用量の記録に使う。無ければ数えられないので実行しない）。
 */
export function createAiStepExecutor(deps: AiStepExecutorDeps): StepExecutor {
  return {
    async run(input: StepExecutorInput): Promise<StepExecutorOutput> {
      const monotonicNowMs = deps.monotonicNowMs ?? (() => performance.now());
      const startedAt = monotonicNowMs();
      const stepBudgetMs = deps.stepBudgetMs ?? MAX_STEP_GENERATION_MS;
      input.signal?.throwIfAborted();
      const step = input.recipe.steps[input.stepIndex];
      if (!step) throw new StepError("unknown_step", false);
      const backend = deps.compose();
      if (!backend) throw new StepError("ai_unavailable", false);
      const usage = deps.usage();
      const owner = input.owner;
      // 使用量を数えられないままモデルを呼ばない（上限が効かなくなる）。DB の不調は一時的なので再試行する
      if (!usage || !owner) throw new StepError("usage_unavailable", true);

      const month = monthKeyJst(deps.now ? deps.now() : new Date());
      const limitUsd = deps.limitUsd();
      if (overLimit(await usage.get(owner, month), limitUsd)) throw new StepError("quota_exceeded", false);

      const settings = input.materials?.settings ?? (await deps.settings?.()?.(owner)) ?? DEFAULT_EDITOR_SETTINGS;
      // 参考は、作っているサブページと同じフォルダの直下のページ（親＝録音ページの兄弟）。読めなければ参考なし
      const references = input.materials
        ? input.materials.refs.map((ref) => stepReferenceText(ref.blocks).trim()).filter(Boolean).map((text, index) => ({ title: `参考 ${index + 1}`, text }))
        : referencesFrom((await deps.references?.()?.(owner, input.parentPageId ?? "")) ?? []).map((ref, index) => ({ ...ref, title: `参考 ${index + 1}` }));
      const sources = sourcesOf(input);
      const composeInput: ComposeInput = {
        recipeName: input.recipe.name,
        guide: input.recipe.guide,
        stepName: step.name,
        instruction: step.instruction,
        stepNumber: input.stepIndex + 1,
        stepCount: input.recipe.steps.length,
        sources,
        background: input.background.trim(),
        // 「書いた言語のまま」は日本語（段階の資料は録音の文字起こしで、設計 §7.2 の手順はどれも日本語）
        lang: settings.aiLang === "en" ? "en" : "ja",
        glossary: [...settings.glossary, ...(input.materials?.fields.terms ?? []), ...(input.recipe.terms ?? [])],
        entities: input.materials?.fields.entities ?? [],
        about: { name: settings.aboutName, text: settings.about },
        references,
        ...(input.chunk
          ? { chunk: { number: input.chunk.index + 1, count: input.chunk.count, target: sources[input.stepIndex]!.label, previousTail: input.chunk.previousTail } }
          : {}),
      };
      const prompt = buildComposePrompt(composeInput);

      const env = deps.env ?? process.env;
      const generation = stepGenerationOptions(backend.model, step.profile, composeMaxTokens(composeInput, maxTokensLimit(env)), maxTokensLimit(env));
      // 出力の上限で切れたら、同じ答えの続きを書かせて繋ぐ（旧アプリの「続き」。docs-core の規則と結合をそのまま使う）
      let text = "";
      let report: AiUsageReport | null = null;
      // 続きを書かせた分も足した合計（帯と記録に出す）
      let inputTokens = 0;
      let outputTokens = 0;
      let truncated = false;
      for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
        // 2 回目からは、ここまでの答えを assistant の書きかけとして渡す（モデルは止まった所の続きから書く）
        const messages: unknown[] =
          round === 0 ? [{ role: "user", content: prompt.user }] : [{ role: "user", content: prompt.user }, { role: "assistant", content: text }];
        if (round > 0 && overLimit(await usage.get(owner, month), limitUsd)) throw new StepError("quota_exceeded", false);
        // 呼び出しの最大時間を丸ごと予約し、Cloud Tasks の期限前に runner が結果を保存できるようにする。
        if (monotonicNowMs() - startedAt + timeoutMs(env) > stepBudgetMs) {
          const partial = partialComposeBlocks(text);
          throw new StepError("step_time_limit", false, partial.length > 0 ? partial : undefined);
        }
        let turn;
        try {
          turn = await backend.client.converse({
            system: prompt.system,
            messages,
            maxTokens: generation.maxTokens,
            ...(generation.thinking ? { thinking: generation.thinking } : {}),
            ...(generation.outputConfig ? { outputConfig: generation.outputConfig } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          });
        } catch (error) {
          // 応答が届いたのに使えなかった分も課金されているので記録する
          if (error instanceof AnthropicError && error.usage) await usage.record(owner, month, usageDelta(backend, error.usage));
          if (error instanceof AnthropicError) throw new StepError(ERROR_CODES[error.kind], error.retryable);
          // 中断（lease を失った・取消）は runner が世代で見分ける
          throw error;
        }
        await usage.record(owner, month, usageDelta(backend, turn.usage));
        report = turn.usage;
        inputTokens += count(turn.usage.inputTokens);
        outputTokens += count(turn.usage.outputTokens);
        const piece = turn.text.trimEnd();
        text = round === 0 ? piece : joinContinuation(text, piece);
        truncated = turn.stopReason === "max_tokens";
        // 続きが 1 字も出ないなら、これ以上は進まない（同じ要求を繰り返さない）
        if (!truncated || piece.length === 0) break;
      }
      if (!report) throw new StepError("internal", true);
      // 続きの回数を使い切っても終わらなかった。**書けた分は運ぶが、ページには書かない**（人が見て写す用）
      if (truncated) throw new StepError("output_too_long", false, partialComposeBlocks(text));

      const parsed = parseComposeOutput(parseJson(text));
      if (!parsed.ok) {
        // 理由は検証の決まった文だけ（モデルの出力そのものは書かない）
        console.error("editor-web: step output rejected", { reason: parsed.reason });
        throw new StepError("invalid_output", false);
      }
      const blocks = composeBlocks(parsed.blocks);
      if (!blocks.ok) {
        console.error("editor-web: step output rejected", { reason: blocks.reason });
        throw new StepError("invalid_output", false);
      }
      const inputUsedChars = composeSourceUsedChars(composeInput.sources);
      return { blocks: blocks.blocks, usage: { inputTokens, outputTokens, model: report.model }, ...(inputUsedChars === null ? {} : { inputUsedChars }) };
    },
  };
}

const FENCED = /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i;

/** モデルの出力の JSON（```json … ``` で囲まれていたら外す）。読めなければ null（`invalid_output`）。 */
function parseJson(text: string): unknown {
  const fenced = FENCED.exec(text.trim());
  try {
    return JSON.parse(fenced ? fenced[1]! : text);
  } catch {
    return null;
  }
}
