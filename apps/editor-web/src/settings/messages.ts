/**
 * 設定の画面（#108）で editor-web 自身が出す一言（保存と読み込みの結果）。
 * 画面の語（エンジン・保存先・上限の説明）は docs-ui の `EDITOR_SETTINGS_TEXT`（モック v6 の語彙）が持つ。
 * 値（語彙・手順の中身・鍵）は入れない。
 */

export const SETTINGS_MESSAGES = {
  saving: "保存しています…",
  saved: "保存しました",
  failed: "保存できませんでした。もう一度お試しください",
  rejected: "この内容では保存できません。長さと空の欄を確かめてください",
  signedOut: "ログインが切れました。ログインし直してください",
  forbidden: "この画面からは操作できません",
  unavailable: "いまは保存できません",
  network: "通信できませんでした。もう一度お試しください",
  usageFailed: "使用量を読めませんでした",
  storageUsageFailed: "メディア容量を読み込めませんでした",
} as const;
