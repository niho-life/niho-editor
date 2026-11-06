"use client";

/**
 * ログアウト（設定の一覧のいちばん下）。結果に関わらずログインの画面へ。
 * この画面の状態（一覧など）を残さないよう、読み込み直す。
 */
export function logoutAndLeave(): void {
  void fetch("/auth/logout", { method: "POST", credentials: "same-origin" })
    .catch(() => undefined)
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- 読み込み直すため
    .finally(() => window.location.assign("/auth/login"));
}
