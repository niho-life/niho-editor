/** 題名の上限（文字数。DB の CHECK と同じ）。サーバーの検証と、画面の入力で同じ値を使う。 */
export const MAX_TITLE_CHARS = 500;

/** 一覧を 1 回に読む件数（サイドバーの最初の表示と、末尾に近づいたときの続き）。 */
export const PAGE_CHUNK = 100;

/**
 * フォルダの欄の件数の上限（`PAGE_FIELD_LIMITS`（editor-store）と同じ値。画面はサーバー専用の module を読めないので写す。
 * 食い違いは src/lib/page-limits.test.ts が落とす）。
 */
export const FOLDER_FIELD_LIMITS = { entities: 200, terms: 200 } as const;
