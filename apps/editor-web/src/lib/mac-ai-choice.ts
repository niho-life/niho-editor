import { EFFORTS, type Effort } from "@niho/docs-core";
import type { ShellAiEngineName } from "niho-desktop-bridge/shell-contract";

/**
 * Mac の AI チャットで選んだ実行先・モデル・思考量（この Mac の localStorage に覚える。端末ごとの好みで、サーバーには送らない）。
 * モデルと思考量は CLI ごとに覚える（CLI を替えて戻ったとき、前に選んだものに戻る）。思考量が無いのは「既定」。
 * 読めない・壊れているときは何も覚えていない扱いにする（開けなくならないように）。
 */
export type MacAiRoute = "" | "server" | ShellAiEngineName;

export type MacAiChoice = {
  route: MacAiRoute;
  models: Partial<Record<ShellAiEngineName, string>>;
  efforts: Partial<Record<ShellAiEngineName, Effort>>;
};

const KEY = "niho-editor:mac-ai-choice";
const ENGINES: readonly ShellAiEngineName[] = ["cli:claude-code", "cli:codex", "cli:antigravity"];
/** モデルの ID（mac-ai-chat.ts の SAFE_MODEL と同じ形）。 */
const SAFE_MODEL = /^(?!-)[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/;

export const EMPTY_MAC_AI_CHOICE: MacAiChoice = { route: "", models: {}, efforts: {} };

function isEngine(value: unknown): value is ShellAiEngineName {
  return typeof value === "string" && (ENGINES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readMacAiChoice(): MacAiChoice {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY_MAC_AI_CHOICE;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return EMPTY_MAC_AI_CHOICE;
    const route: MacAiRoute = value.route === "server" || isEngine(value.route) ? value.route : "";
    const models: MacAiChoice["models"] = {};
    const efforts: MacAiChoice["efforts"] = {};
    if (isRecord(value.models)) {
      for (const [engine, model] of Object.entries(value.models)) {
        if (isEngine(engine) && typeof model === "string" && SAFE_MODEL.test(model)) models[engine] = model;
      }
    }
    if (isRecord(value.efforts)) {
      for (const [engine, effort] of Object.entries(value.efforts)) {
        if (isEngine(engine) && (EFFORTS as readonly unknown[]).includes(effort)) efforts[engine] = effort as Effort;
      }
    }
    return { route, models, efforts };
  } catch {
    return EMPTY_MAC_AI_CHOICE;
  }
}

export function writeMacAiChoice(choice: MacAiChoice): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(choice));
  } catch {
    // 覚えられなくても、今の画面の選択はそのまま使える
  }
}
