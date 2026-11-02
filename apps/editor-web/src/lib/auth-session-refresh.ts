"use client";

const REFRESH_INTERVAL_MS = 35 * 60 * 1000;
const REFRESH_ENDPOINT = "/auth/refresh";
const LOCK_NAME = "niho-editor-auth-refresh";
const LAST_REFRESH_KEY = "niho-editor-auth-refreshed-at";
const LOCK_KEY = "niho-editor-auth-refresh-lock";

type LockManagerLike = { request<T>(name: string, callback: () => Promise<T>): Promise<T> };

export type AuthSessionRefreshResult = "refreshed" | "unauthorized" | "unavailable" | "skipped" | "busy";

type RefreshOptions = {
  /** ログイン復帰時は前回時刻に関係なく一度試す。待っている別タブが更新済みなら重ねて呼ばない。 */
  force?: boolean;
  fetcher?: typeof fetch;
  now?: () => number;
};

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

async function withFallbackLock<T>(callback: () => Promise<T>, now: number): Promise<T | null> {
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

/** 前回の成功から次の更新までの待ち時間。タブの再マウント時にも元の周期を保つ。 */
export function nextAuthRefreshDelay(now = Date.now(), lastSuccessfulRefresh = 0): number {
  const last = Math.max(lastSuccessfulRefresh, readTime(LAST_REFRESH_KEY));
  return Math.max(0, REFRESH_INTERVAL_MS - (now - last));
}

/** HttpOnly cookieを同一originのRoute Handlerで更新する。credentialや応答本文はJSへ取り出さない。 */
export async function refreshAuthSession(options: RefreshOptions = {}): Promise<AuthSessionRefreshResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const force = options.force === true;
  const fetcher = options.fetcher ?? fetch;
  if (!force && now() - readTime(LAST_REFRESH_KEY) < REFRESH_INTERVAL_MS) return "skipped";

  const perform = async (): Promise<AuthSessionRefreshResult> => {
    const last = readTime(LAST_REFRESH_KEY);
    if (last >= startedAt && last > 0) return "skipped";
    if (!force && now() - last < REFRESH_INTERVAL_MS) return "skipped";
    const response = await fetcher(REFRESH_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (response.ok) {
      writeTime(LAST_REFRESH_KEY, now());
      return "refreshed";
    }
    return response.status === 401 ? "unauthorized" : "unavailable";
  };

  try {
    const locks = typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { locks?: LockManagerLike }).locks;
    if (locks) return await locks.request(LOCK_NAME, perform);
    return await withFallbackLock(perform, now()) ?? "busy";
  } catch {
    return "unavailable";
  }
}
