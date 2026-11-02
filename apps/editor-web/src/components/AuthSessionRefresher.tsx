"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const REFRESH_INTERVAL_MS = 35 * 60 * 1000;
const REFRESH_ENDPOINT = "/auth/refresh";
const LOCK_NAME = "niho-editor-auth-refresh";
const LAST_REFRESH_KEY = "niho-editor-auth-refreshed-at";
const LOCK_KEY = "niho-editor-auth-refresh-lock";

type LockManagerLike = { request<T>(name: string, callback: () => Promise<T>): Promise<T> };

function readTime(key: string): number {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function writeTime(key: string, value: number): boolean {
  try { localStorage.setItem(key, String(value)); return true; } catch { return false; }
}

async function withFallbackLock<T>(callback: () => Promise<T>): Promise<T | null> {
  const now = Date.now();
  const previous = readTime(LOCK_KEY);
  if (previous > now - 20_000) return null;
  if (!writeTime(LOCK_KEY, now)) return callback();
  if (readTime(LOCK_KEY) !== now) return null;
  try { return await callback(); } finally {
    try {
      if (readTime(LOCK_KEY) === now) localStorage.removeItem(LOCK_KEY);
    } catch { /* storage may be unavailable */ }
  }
}

/** Firebase ID tokenをHttpOnly cookie内で更新し、NIHO connectionは期限が近いときだけrotateする。 */
export function AuthSessionRefresher() {
  const router = useRouter();
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let lastSuccessfulRefresh = 0;

    const refresh = async (force = false) => {
      if (!active || inFlight || document.visibilityState !== "visible") return;
      const last = Math.max(lastSuccessfulRefresh, readTime(LAST_REFRESH_KEY));
      if (!force && Date.now() - last < REFRESH_INTERVAL_MS) return;
      inFlight = true;
      const perform = async () => {
        if (Date.now() - Math.max(lastSuccessfulRefresh, readTime(LAST_REFRESH_KEY)) < REFRESH_INTERVAL_MS) return null;
        const response = await fetch(REFRESH_ENDPOINT, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (response.ok) {
          lastSuccessfulRefresh = Date.now();
          writeTime(LAST_REFRESH_KEY, lastSuccessfulRefresh);
        }
        else if (response.status === 401) {
          const next = `${window.location.pathname}${window.location.search}`;
          router.replace(`/auth/login?next=${encodeURIComponent(next)}`);
        }
        return response;
      };
      try {
        const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
        if (locks) await locks.request(LOCK_NAME, perform);
        else await withFallbackLock(perform);
      } catch {
        // 一時的な通信エラーは次の周期で再試行する。tokenやAPI応答は画面へ出さない。
      } finally {
        inFlight = false;
      }
    };

    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  return null;
}
