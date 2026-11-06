import type { Block, OwnerId, StepMaterials } from "@niho/editor-store";
import type { RecipeDef } from "./recipes";

export type StepExecutorInput = {
  recipe: RecipeDef;
  stepIndex: number;
  /**
   * run を持っている人（runner が claim で分かった値を渡す。要求の値からは決めない）。
   * 本物の実行器（ai-executor.ts）が月の上限と使用量の記録に使う。偽物の実行器は見ない。
   */
  owner?: OwnerId;
  /** 手順を始めた録音ページの id（自動参考ページを、そのページと同じフォルダから選ぶのに使う）。 */
  parentPageId?: string;
  /** 録音ページの本文。 */
  parentBlocks: Block[];
  /** 親フォルダの背景本文。録音の原文とは別の入力。 */
  backgroundBlocks: Block[];
  /** 前の段階のサブページの本文（段階 0 は null）。 */
  previousBlocks: Block[] | null;
  /** 実行と前提計算が同じ時点で読んだ素材。 */
  materials?: StepMaterials;
  /** lease を失った（取消・掃除）ときに止める合図。 */
  signal?: AbortSignal;
};

export type StepExecutorOutput = {
  blocks: Block[];
  usage?: { inputTokens: number; outputTokens: number; model: string };
  /** 資料を上限で切ったときだけ、実際に使った字数（code point）。帯に「先頭 N 字だけ使いました」と出す（#277）。 */
  inputUsedChars?: number;
};

/** 1 つの段階を実行する（本物の AI は後段。#38 の AiModel をこの形に包む）。 */
export type StepExecutor = {
  run(input: StepExecutorInput): Promise<StepExecutorOutput>;
};

/**
 * 段階の失敗。`code` は短い英小文字の code だけ（本文・プロンプト・内部の情報を入れない）。
 * `retryable` は一時的な失敗（時間切れ・5xx 相当）。入力の誤り（4xx 相当）は false ですぐ失敗にする。
 *
 * `partial` は書けたところまでの本文。続きを使い切れないか、実行時間の安全枠を超えたときだけ入れる。
 * runner が最後の失敗のときだけ `step_attempts.partial_blocks` に残す（サブページの本文には書かない）。
 * 長い文字起こし修正はここに当たる段階なので、捨てると十数分かけた本文が丸ごと消える。
 */
export class StepError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly partial?: readonly Block[];

  constructor(code: string, retryable: boolean, partial?: readonly Block[]) {
    super(`step failed: ${code}`);
    this.name = "StepError";
    this.code = code;
    this.retryable = retryable;
    if (partial !== undefined) this.partial = partial;
  }
}

/** blocks の中の文字（text）をつなげたもの。 */
function plainText(value: unknown): string {
  if (Array.isArray(value)) return value.map(plainText).join("");
  if (typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  return (typeof record.text === "string" ? record.text : "") + plainText(record.content);
}

function textBlock(type: "heading" | "paragraph", text: string): Block {
  return type === "heading"
    ? { type, attrs: { level: 2 }, content: [{ type: "text", text }] }
    : { type, content: [{ type: "text", text }] };
}

/** 偽物の結果（決定的。`[fake]` の印・段階の名前・前の段階の先頭 30 文字を入れる）。 */
export function fakeBlocks(input: Pick<StepExecutorInput, "recipe" | "stepIndex" | "parentBlocks" | "previousBlocks">): Block[] {
  const step = input.recipe.steps[input.stepIndex];
  if (!step) throw new StepError("unknown_step", false);
  const source = input.stepIndex === 0 ? input.parentBlocks : (input.previousBlocks ?? []);
  const head = Array.from(plainText(source).replace(/\s+/g, " ").trim()).slice(0, 30).join("") || "（入力なし）";
  return [
    textBlock("heading", `[fake] ${step.name}`),
    textBlock("paragraph", `[fake] ${input.recipe.name}の段階 ${input.stepIndex + 1}/${input.recipe.steps.length}「${step.name}」の偽の結果です。`),
    textBlock("paragraph", `[fake] 前の段階の先頭: ${head}`),
  ];
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new StepError("aborted", true));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new StepError("aborted", true));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type FakeExecutorOptions = {
  /** 最初の n 回は失敗する。 */
  failures?: number;
  /** 失敗のときに投げるもの（既定は再試行できる `StepError("fake_failure")`）。 */
  error?: () => unknown;
  /** 毎回この時間（ms）かかる（signal で止まる）。 */
  delayMs?: number;
};

/** 偽物の実行器（AI を呼ばない）。テスト用に「n 回目まで失敗する」「遅い」「投げるものを決める」を作れる。 */
export function createFakeExecutor(options: FakeExecutorOptions = {}): StepExecutor & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async run(input) {
      calls += 1;
      if (options.delayMs) await wait(options.delayMs, input.signal);
      if (calls <= (options.failures ?? 0)) throw options.error ? options.error() : new StepError("fake_failure", true);
      return { blocks: fakeBlocks(input), usage: { inputTokens: 0, outputTokens: 0, model: "fake" } };
    },
  };
}

export const fakeExecutor: StepExecutor = createFakeExecutor();
