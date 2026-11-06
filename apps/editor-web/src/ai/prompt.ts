/**
 * 要求の文の共有部品（純粋関数）。ページの本文・文字起こしは信頼しないデータとして `<untrusted_data>` で包む
 * （本文の中の閉じ書きは `<\/untrusted_data>` に置き換えて外に出さない）。
 */

export type AiPrompt = { system: string; user: string };

/** 資料の本文を包む（中に包みの閉じ書きがあっても資料の外に出さない）。 */
export function wrapUntrusted(body: string): string {
  return `<untrusted_data>\n${body.replaceAll("</untrusted_data>", "<\\/untrusted_data>").trim()}\n</untrusted_data>`;
}
