import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SHELL_COMMANDS } from "./shell-contract";

/** Rust 側の正本（apps/docs/src-tauri）。この package と同じリポジトリにあるので直接読む。 */
const SRC_TAURI = new URL("../../../apps/docs/src-tauri/", import.meta.url);

function read(relative: string): string {
  return readFileSync(new URL(relative, SRC_TAURI), "utf8");
}

/** `permissions/docs.toml` の `allow-editor-shell` が許す command。 */
function allowedByEditorShell(): Set<string> {
  const toml = read("permissions/docs.toml");
  const block = /identifier = "allow-editor-shell"[\s\S]*?commands\.allow = \[([^\]]*)\]/.exec(toml);
  if (!block?.[1]) throw new Error("allow-editor-shell が docs.toml に無い");
  return new Set(
    block[1]
      .split(",")
      .map((entry) => entry.trim().replace(/^"|"$/g, ""))
      .filter((entry) => entry.length > 0),
  );
}

describe("殻の command の契約", () => {
  it("TS の一覧と docs.toml の allow-editor-shell が同じ（片方だけ増えると落ちる）", () => {
    expect(new Set(Object.values(SHELL_COMMANDS))).toEqual(allowedByEditorShell());
  });

  it("remote から届く command は全部 shell_ で始まり、remote の capability は allow-editor-shell だけ", () => {
    for (const command of Object.values(SHELL_COMMANDS)) {
      expect(command.startsWith("shell_"), command).toBe(true);
    }
    const remote = JSON.parse(read("capabilities/remote-editor.json")) as { remote: { urls: string[] }; permissions: string[] };
    expect(remote.remote.urls).toEqual(["https://editor.niho.life"]);
    expect(remote.permissions).toEqual(["allow-editor-shell"]);
  });
});
