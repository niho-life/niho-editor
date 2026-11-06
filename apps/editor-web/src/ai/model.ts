/**
 * モデルの使用量の報告（チャット・手順の段階・翻訳・使用量の記録で共有する）。
 * 提案のモデル（AiModel・AiRequest）は提案 → 採用の API と一緒に外した（#278）。
 * `webSearchRequests` はサーバー側の Web 検索の回数（応答の `usage.server_tool_use.web_search_requests`。1 回以上のときだけ持つ。#283）。
 */
export type AiUsageReport = { model: string; inputTokens: number; outputTokens: number; webSearchRequests?: number };
