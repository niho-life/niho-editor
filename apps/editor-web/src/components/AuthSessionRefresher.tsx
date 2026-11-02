"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { nextAuthRefreshDelay, refreshAuthSession } from "@/lib/auth-session-refresh";
import { sessionRecoveryLoginPath } from "@/lib/session-recovery-path";

const RETRY_DELAY_MS = 60_000;

/** Firebase ID tokenをHttpOnly cookie内で更新し、NIHO connectionは期限が近いときだけrotateする。 */
export function AuthSessionRefresher() {
  const router = useRouter();
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let lastSuccessfulRefresh = 0;
    let timer: number | undefined;

    const schedule = (delay = nextAuthRefreshDelay(Date.now(), lastSuccessfulRefresh)) => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (!active || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => void refresh(), delay);
    };

    const refresh = async () => {
      if (!active || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      const result = await refreshAuthSession();
      if (result === "refreshed") lastSuccessfulRefresh = Date.now();
      inFlight = false;
      if (!active) return;
      if (result === "unauthorized") {
        const next = `${window.location.pathname}${window.location.search}`;
        router.replace(sessionRecoveryLoginPath(next));
      } else if (result === "unavailable") {
        schedule(RETRY_DELAY_MS);
      } else if (result === "busy") {
        schedule(1_000);
      } else {
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
      else if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void refresh();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  return null;
}
