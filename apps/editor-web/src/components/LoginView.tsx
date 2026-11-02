"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import "niho-ui/styles/tokens.css";
import "niho-docs-ui/styles/tokens.css";
import "niho-docs-ui/styles/shell.css";
import { LoginScreen } from "niho-docs-ui/shell";
import type { LoginError } from "@/auth/return-to";
import { refreshAuthSession } from "@/lib/auth-session-refresh";

/** 失敗の知らせ（どのアカウントだったか・何が起きたかは出さない）。 */
const MESSAGES: Readonly<Record<LoginError, string>> = {
  unavailable: "ログインできませんでした。もう一度お試しください。",
  forbidden: "このアカウントでは入れません。",
};

/**
 * ログインの画面（枠の外）。既定は `/auth/login/start`、写真だけは限定した prop で `/photo/auth/start` へ移る。
 * next はサーバーで用途ごとの safeReturnTo を通した戻り先（既定の画面なら null）。
 * 「アカウントを作る」「ヘルプ」の行き先はまだ決まっていない。
 */
export type LoginStartPath = "/auth/login/start" | "/photo/auth/start";

export function loginStartLocation(startPath: LoginStartPath, next: string | null): string {
  return `${startPath}${next ? `?next=${encodeURIComponent(next)}` : ""}`;
}

export function LoginView({ next, error, startPath = "/auth/login/start", recover = false }: {
  next: string | null;
  error: LoginError | null;
  startPath?: LoginStartPath;
  recover?: boolean;
}) {
  const router = useRouter();
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const [recoveryStatus, setRecoveryStatus] = useState<"checking" | "unavailable" | null>(recover ? "checking" : null);

  useEffect(() => {
    if (!recover) return;
    let active = true;
    let busyAttempts = 0;
    let retryTimer: number | undefined;

    const attemptRecovery = async () => {
      setRecoveryStatus("checking");
      const result = await refreshAuthSession({ force: true });
      if (!active) return;
      if (result === "refreshed" || result === "skipped") {
        router.refresh();
      } else if (result === "unauthorized") {
        const params = new URLSearchParams();
        if (next) params.set("next", next);
        const query = params.toString();
        router.replace(query ? `/auth/login?${query}` : "/auth/login");
      } else if (result === "busy" && busyAttempts < 8) {
        busyAttempts += 1;
        retryTimer = window.setTimeout(() => void attemptRecovery(), 300);
      } else {
        setRecoveryStatus("unavailable");
      }
    };

    void attemptRecovery();
    return () => {
      active = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [next, recoveryAttempt, recover, router]);

  return (
    <div data-docs-app-root="" data-docs-shared-ui="" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
      {error && <p role="alert">{MESSAGES[error]}</p>}
      {recover && recoveryStatus === "checking" && <p role="status">ログイン状態を確認しています。</p>}
      {recover && recoveryStatus === "unavailable" && (
        <div>
          <p role="alert">ログイン状態を確認できませんでした。接続を確かめてもう一度お試しください。</p>
          <button type="button" onClick={() => setRecoveryAttempt((attempt) => attempt + 1)}>もう一度確認</button>
        </div>
      )}
      {(!recover || recoveryStatus !== "checking") && (
        <div style={{ flex: 1, minHeight: 0 }}>
          <LoginScreen
            onLogin={() =>
              window.location.assign(loginStartLocation(startPath, next))
            }
          />
        </div>
      )}
    </div>
  );
}
