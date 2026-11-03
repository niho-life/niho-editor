import type { About, GlossaryEntry } from "@niho/docs-core";
import type { AiIntent } from "./presets";

/**
 * モデルの接続口（設計 §6・Issue #38）。モデルと鍵はサーバー側だけに置く。
 * 本物は Anthropic（anthropic.ts。`EDITOR_AI_MODE=anthropic`）、開発と CI は偽物（fake-model.ts。`EDITOR_AI_MODE=fake`）。
 */

/** モデルへ送る段落 1 つ。`index` は本文の最上位のブロックの位置。`context` は文脈として送るだけ（変えられない）。 */
export type AiParagraph = { index: number; kind: "paragraph" | "heading" | "context"; text: string };

export type AiRequest = {
  intent: AiIntent;
  paragraphs: AiParagraph[];
  /** 固有名詞と誤りやすい表記（設定）。 */
  glossary: GlossaryEntry[];
  lang: "ja" | "en";
  /** 「あなたについて」（設定。空なら渡さない）。 */
  about?: About;
  /** 自動参考ページ（同じフォルダの直下のほかのページ。無ければ空）。 */
  references?: AiReference[];
};

/** 参考に入れるページ 1 枚（本文は信頼しないデータとして包んで渡す）。 */
export type AiReference = { title: string; text: string };

export type AiInsertKind = "paragraph" | "heading" | "callout";

/** モデルの構造化出力（engine.ts の parseAiOutput が検証した後の形）。 */
export type AiOutput = {
  /** 段落を変える。変えない段落は返さない。 */
  edits: { index: number; text: string }[];
  /** `afterIndex` の後ろに足す（−1 は先頭）。 */
  inserts: { afterIndex: number; kind: AiInsertKind; text: string }[];
};

export type AiUsageReport = { model: string; inputTokens: number; outputTokens: number };

/** `output` はモデルが返したまま（信用しない。engine.ts が検証する）。 */
export type AiResult = { output: unknown; usage: AiUsageReport };

export interface AiModel {
  run(request: AiRequest, signal?: AbortSignal): Promise<AiResult>;
}
