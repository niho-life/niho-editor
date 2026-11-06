/**
 * モデルの使用量の報告（チャット・手順の段階・翻訳・使用量の記録で共有する）。
 * 提案のモデル（AiModel・AiRequest）は提案 → 採用の API と一緒に外した（#278）。
 */
export type AiUsageReport = { model: string; inputTokens: number; outputTokens: number };
