"use client";

import "niho-ui/styles/tokens.css";
import "niho-docs-ui/styles/tokens.css";
import "niho-docs-ui/styles/shell.css";
import { LoginScreen } from "niho-docs-ui/shell";
import type { LoginError } from "@/auth/return-to";

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

export function LoginView({ next, error, startPath = "/auth/login/start" }: {
  next: string | null;
  error: LoginError | null;
  startPath?: LoginStartPath;
}) {
  return (
    <div data-docs-app-root="" data-docs-shared-ui="" style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
      {error && <p role="alert">{MESSAGES[error]}</p>}
      <div style={{ flex: 1, minHeight: 0 }}>
        <LoginScreen
          onLogin={() =>
            window.location.assign(loginStartLocation(startPath, next))
          }
        />
      </div>
    </div>
  );
}
