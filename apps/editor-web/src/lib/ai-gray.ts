"use client";

import { useSyncExternalStore } from "react";

/** 「AI の文を灰色で見せる」の置き場（この端末だけ。`"off"` のときだけ切る。既定は見せる）。 */
export const AI_GRAY_STORAGE_KEY = "editor.aiGray";

const listeners = new Set<() => void>();
/** 置き場を使えない端末で、切り替えた値をこの画面のあいだ持つ。 */
let fallback = true;

/** 今の設定（SSR は ON。置き場を使えない端末は、この画面で切り替えた値）。 */
export function readAiGray(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(AI_GRAY_STORAGE_KEY) !== "off";
  } catch {
    return fallback;
  }
}

/** 切り替えて、開いている画面へ知らせる。 */
export function setAiGray(on: boolean): void {
  fallback = on;
  try {
    if (on) window.localStorage.removeItem(AI_GRAY_STORAGE_KEY);
    else window.localStorage.setItem(AI_GRAY_STORAGE_KEY, "off");
  } catch {
    // 置き場が無い端末では、この画面のあいだだけ
  }
  listeners.forEach((listener) => listener());
}

/** 変わったら知らせる（別のタブで変えたときも）。返す関数で外す。 */
export function subscribeAiGray(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === AI_GRAY_STORAGE_KEY || event.key === null) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** 画面の値（SSR は ON）。 */
export function useAiGray(): boolean {
  return useSyncExternalStore(subscribeAiGray, readAiGray, () => true);
}
