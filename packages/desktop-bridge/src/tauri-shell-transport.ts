/**
 * 本番の transport（Tauri の `invoke` と `Channel`）。**Tauri の import はこのファイルだけ。**
 * editor.niho.life は `detectShell()` で殻の中かを見分け、null ならブラウザ・PWA として動く。
 */
import { Channel, invoke } from "@tauri-apps/api/core";

import { createShellBridge, isShellWindow, type ShellBridge, type ShellTransport } from "./shell-bridge";

export function createTauriShellTransport(): ShellTransport {
  return {
    invoke: (command, args) => invoke(command, args),
    channel: <T>(onMessage: (value: T) => void) => {
      const created = new Channel<T>();
      created.onmessage = onMessage;
      return created;
    },
  };
}

/** Mac の殻の中なら bridge、ブラウザ・PWA・SSR なら null。 */
export function detectShell(): ShellBridge | null {
  if (typeof window === "undefined" || !isShellWindow(window)) return null;
  return createShellBridge(createTauriShellTransport());
}
