/**
 * AI チャットの上限のうち、画面（クライアント）も読むもの。
 * ループ本体（chat.ts）はサーバー専用の anthropic.ts を読むので、画面からは取り込めない。
 */

/** 人の指示の上限（文字）。 */
export const MAX_CHAT_INPUT_CHARS = 2_000;

/** 選択範囲の文字として AI に見せる長さの上限（これを超える分は、段落の番号で示して read_page で読ませる。#280）。 */
export const MAX_SELECTION_TEXT_CHARS = 2_000;
