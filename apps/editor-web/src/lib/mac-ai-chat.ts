import { MODEL_OPTIONS, effortRule, fitEffort, type Effort, type EffortRule } from "@niho/docs-core";
import type { ShellBridge } from "niho-desktop-bridge/shell-bridge";
import type { AiChatEvent } from "./ai-client";
import { isShellError, type ShellAiEffort, type ShellAiEngine, type ShellAiEngineName, type ShellAiEvent, type ShellAiTurn } from "niho-desktop-bridge/shell-contract";

export const MAC_ENGINE_LABELS: Readonly<Record<ShellAiEngineName, string>> = {
  "cli:claude-code": "Claude Code",
  "cli:codex": "Codex CLI",
  "cli:antigravity": "Antigravity CLI",
};

export const MAC_AI_ERROR_TEXT = {
  unavailable: "この Mac に CLI がありません。導入してから状態を読み直してください。",
  auth: "CLI のログインが必要です。CLI でログインしてから状態を読み直してください。",
  busy: "この会話の CLI が動いています。終わってからもう一度お試しください。",
  too_large: "このページは Mac の CLI に渡せる大きさを超えています。本文を短くしてください。",
  unreadable: "このページの本文を CLI 用の文書にできません。箇条書き・引用・囲み・表の中に画像や録音があるページは、この経路では編集できません（それ以外の場所の画像は残したまま文章を直せます）。",
  aborted: "中止しました。ページには反映していません。",
  incomplete: "CLI が書き切れませんでした。ページには反映していません。",
  page_removed: "CLI が文書を削除したため、ページには反映していません。",
  extra_files: "CLI が別のファイルを作ったため、ページには反映していません。",
  invalid_result: "CLI の結果を確認できませんでした。ページには反映していません。",
  edited: "CLI の作業中にページが編集されました。結果は保存せず、もう一度頼んでください。",
  blocked: "CLI を許可した範囲（文書の書き換えだけ）で動かせなかったため止めました。ページには反映していません。もう一度試すか、CLI を更新するか、別の AI を選んでください。",
  usage_limit: "CLI の利用上限に達しました。ページには反映していません。時間をおいてから、もう一度お試しください。",
  model: "選んだモデルをこの CLI で使えませんでした。ページには反映していません。別のモデルを選んでください。",
  timed_out: "CLI が時間内に終わりませんでした。ページには反映していません。",
  session: "CLI で前の会話の続きを見つけられませんでした。ページには反映していません。新しい会話で頼んでください。",
  failed: "CLI の依頼を終えられませんでした。ページには反映していません。",
  context: "文書ガイドなど、AI に渡す資料を読めませんでした。ページには反映していません。もう一度お試しください。",
} as const;

export type MacAiErrorCode = keyof typeof MAC_AI_ERROR_TEXT;

export class MacAiError extends Error {
  override readonly name = "MacAiError";
  constructor(readonly code: MacAiErrorCode) {
    super(`mac ai chat failed: ${code}`);
  }
}

const PROVIDER_OF: Readonly<Record<ShellAiEngineName, keyof typeof MODEL_OPTIONS>> = {
  "cli:claude-code": "claude",
  "cli:codex": "gpt",
  "cli:antigravity": "gemini",
};

const SAFE_MODEL = /^(?!-)[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/;

/**
 * Claude Code が最新のモデルに解決する別名。Claude Code は一覧を返さないので控えを使うが、控えの先頭は版つきの古い ID
 * （claude-sonnet-4-6）なので、別名を先に並べて既定（一覧の先頭）を最新の Sonnet にする。2026-11-05 の Claude Code 2.1.292 で
 * sonnet → claude-sonnet-5-5・opus → claude-opus-5-5・fable → claude-fable-5-1 に解決した。控えに無い別名は出さない。
 */
const CLAUDE_LATEST_ALIASES: readonly string[] = ["sonnet", "opus", "fable", "haiku"];

/** CLI が一覧を返せないときだけ、docs-core にある同じ CLI の控えを使う（CLI の一覧は新しい順のまま）。 */
export function macEngineModels(engine: ShellAiEngine): string[] {
  const provider = PROVIDER_OF[engine.engine];
  if (!provider || !Array.isArray(engine.models)) return [];
  const fallback = MODEL_OPTIONS[provider].map((option) => option.id);
  const latestFirst = provider === "claude" ? [...CLAUDE_LATEST_ALIASES.filter((alias) => fallback.includes(alias)), ...fallback] : fallback;
  const source = engine.models.length > 0 ? engine.models : latestFirst;
  return [...new Set(source.filter((model) => SAFE_MODEL.test(model)))];
}

export function macEngineStatus(engine: ShellAiEngine): string {
  if (!engine.installed) return "未導入";
  if (!engine.authenticated) return engine.reason === "auth_required" ? "ログインが必要" : "ログイン状態を確認できません";
  return macEngineModels(engine).length > 0 ? "利用できます" : "モデルを選べません";
}

export function macEngineReady(engine: ShellAiEngine): boolean {
  return engine.installed && engine.authenticated && macEngineModels(engine).length > 0;
}

/**
 * CLI の Error の理由（アプリの契約の `ReasonCode`＝`apps/docs/src-tauri/src/contract.rs`）から、画面の決まった文を選ぶ。
 * crate の名前ではない（crate の `TimedOut` は `local_ai::app_reason` が `Timeout` に変えて渡す）。CLI の message はそのまま
 * 出さない（CLI の出力の断片を含みうるので）。知らない理由は「終えられませんでした」。
 */
const ERROR_OF_REASON: Readonly<Record<string, MacAiErrorCode>> = {
  CliLoginRequired: "auth",
  NotConfigured: "blocked",
  UsageLimitReached: "usage_limit",
  ModelNotFound: "model",
  Timeout: "timed_out",
  SessionNotFound: "session",
};

export function macErrorOfReason(reason: unknown): MacAiErrorCode {
  return typeof reason === "string" && Object.hasOwn(ERROR_OF_REASON, reason) ? ERROR_OF_REASON[reason]! : "failed";
}

/** この CLI・モデルで選べる思考量（docs-core の決まり。CLI が思考量を受けないときは選べるものが無い）。 */
export function macEffortRule(engine: ShellAiEngine, model: string): EffortRule {
  if (!engine.effort) return { efforts: [], fixed: null };
  return effortRule(PROVIDER_OF[engine.engine], model);
}

/**
 * 実際に CLI へ渡す思考量。null は「既定」（`effort` を送らず、CLI の設定のまま）。
 * 思考量がモデル名で決まる（`gemini-3.8-flash-high` など）ときも送らない。モデルに無い段階は、それより低い段階に寄せる。
 */
export function macEffortFor(engine: ShellAiEngine, model: string, wanted: Effort | null): Effort | null {
  if (wanted === null) return null;
  const rule = macEffortRule(engine, model);
  if (rule.fixed !== null || rule.efforts.length === 0) return null;
  return rule.efforts.includes(wanted) ? wanted : fitEffort(PROVIDER_OF[engine.engine], model, wanted);
}

function errorFromShell(error: unknown): MacAiError {
  if (isShellError(error)) {
    if (error.code === "shell_ai_too_large") return new MacAiError("too_large");
    if (error.code === "shell_ai_busy") return new MacAiError("busy");
    if (error.code === "shell_ai_engine_unsupported") return new MacAiError("unavailable");
  }
  return new MacAiError("failed");
}

function progressText(event: ShellAiEvent): string | null {
  switch (event.type) {
    case "ThinkingDelta": return "CLI が考えています…";
    case "TextDelta": return "CLI が返答を作っています…";
    case "ToolUse": return "CLI がページを確認・編集しています…";
    case "ToolResult": return event.ok ? "CLI がページを確認しました…" : "CLI がページの操作を確認しています…";
    default: return null;
  }
}

/** CLI の出来事を、サーバー経路の SSE と同じ形にする（画面の書きかけの発言に流す）。 */
export function macChatEvent(event: ShellAiEvent): AiChatEvent | null {
  switch (event.type) {
    case "TextDelta": return typeof event.text === "string" && event.text ? { type: "text", text: event.text, kind: "text" } : null;
    case "ThinkingDelta": return typeof event.text === "string" && event.text ? { type: "text", text: event.text, kind: "thinking" } : null;
    case "ToolUse": return { type: "tool", tool: event.name, page: null, ok: null, phase: "start" };
    case "ToolResult": return { type: "tool", tool: event.name, page: null, ok: event.ok === true, phase: "end" };
    default: return null;
  }
}

export type MacAiTurnOutput = {
  reply: string;
  sessionId: string | null;
  writes: { pageId: string; markdown: string }[];
};

/**
 * 本文に画像・録音の行（`niho-asset:`）があるときに指示へ添える注意（#281）。書き戻しはサーバーが検査し、行が欠ければ保存しない。
 */
export const MAC_PARTS_NOTE = "本文の `niho-asset:` の行は画像・録音です（中身は見えません）。消さず、作らず、前後を空行で区切った 1 行のまま残してください。動かしてよいのは行の位置と、画像の代替文・キャプションだけです。1 つでも欠けると保存されません。録音と文字起こしは書き換えられません。";

function instructionOf(input: { instruction: string; selection: string | null; page: { markdown: string } }): string {
  const base = input.selection === null ? input.instruction : `${input.instruction}\n\n選択範囲を主な対象にしてください。選択範囲は context/selection.md にあります。`;
  return input.page.markdown.includes("](niho-asset:") ? `${base}\n\n${MAC_PARTS_NOTE}` : base;
}

/** native の一時置き場でだけ動く。確定前の結果はサーバーへ送らない。 */
export async function runMacAiTurn(input: {
  shell: ShellBridge;
  engine: ShellAiEngineName;
  model: string;
  page: { pageId: string; title: string; markdown: string };
  selection: string | null;
  /** 読むだけの文脈（`context/<name>.md`。あなたについて・この録音について・文書ガイド・固有名詞）。サーバー経路が指示に入れるものと同じ。 */
  context?: readonly { name: string; title: string; markdown: string }[];
  instruction: string;
  conversationId: string | null;
  resumeSession: string | null;
  /** 思考量。null は既定（送らない）。 */
  effort?: ShellAiEffort | null;
  signal: AbortSignal;
  onProgress?: (text: string) => void;
  /** 途中の文・道具（サーバー経路の `streamAiChat` と同じ形）。 */
  onEvent?: (event: AiChatEvent) => void;
}): Promise<MacAiTurnOutput> {
  if (input.signal.aborted) throw new MacAiError("aborted");
  if (new TextEncoder().encode(input.page.markdown).byteLength > 8 * 1024 * 1024 ||
      (input.selection !== null && new TextEncoder().encode(input.selection).byteLength > 64 * 1024)) {
    throw new MacAiError("too_large");
  }
  // 文脈のファイル（選択範囲は別名 `selection`。文脈の名前と重ならない）
  const files = [...(input.context ?? []), ...(input.selection === null ? [] : [{ name: "selection", title: "選択範囲", markdown: input.selection }])];
  const turnId = crypto.randomUUID();
  let retryStopOnEvent = false;
  const stop = () => {
    void input.shell.aiStop(turnId).then((stopped) => { retryStopOnEvent = !stopped; }).catch(() => { retryStopOnEvent = true; });
  };
  input.signal.addEventListener("abort", stop, { once: true });
  let lastSeq = -1;
  let turn: ShellAiTurn;
  try {
    turn = await input.shell.aiTurn(turnId, {
      engine: input.engine,
      model: input.model,
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.resumeSession ? { resumeSession: input.resumeSession } : {}),
      instruction: instructionOf(input),
      page: input.page,
      ...(files.length === 0 ? {} : { context: files }),
    }, (envelope) => {
      if (!envelope || envelope.turnId !== turnId || !Number.isSafeInteger(envelope.seq) || envelope.seq <= lastSeq) return;
      lastSeq = envelope.seq;
      if (input.signal.aborted) {
        if (retryStopOnEvent) stop();
        return;
      }
      const message = progressText(envelope.event);
      if (message) input.onProgress?.(message);
      const event = macChatEvent(envelope.event);
      if (event) input.onEvent?.(event);
    });
  } catch (error) {
    throw input.signal.aborted ? new MacAiError("aborted") : errorFromShell(error);
  } finally {
    input.signal.removeEventListener("abort", stop);
  }
  if (input.signal.aborted) throw new MacAiError("aborted");
  if (!turn || typeof turn !== "object" || !turn.finalEvent || typeof turn.finalEvent !== "object") throw new MacAiError("invalid_result");
  if (turn.finalEvent.type === "Error") throw new MacAiError(macErrorOfReason(turn.finalEvent.reason_code));
  if (turn.finalEvent.type !== "Done" || typeof turn.finalEvent.text !== "string" ||
      (turn.finalEvent.session_id !== null && typeof turn.finalEvent.session_id !== "string")) throw new MacAiError("invalid_result");
  if (turn.finalEvent.stop_reason !== "EndTurn") throw new MacAiError(turn.finalEvent.stop_reason === "Stopped" ? "aborted" : turn.finalEvent.stop_reason === "MaxTokens" ? "incomplete" : "invalid_result");
  if (typeof turn.pageRemoved !== "boolean") throw new MacAiError("invalid_result");
  if (turn.pageRemoved) throw new MacAiError("page_removed");
  if (!Number.isSafeInteger(turn.extraFiles) || turn.extraFiles !== 0) throw new MacAiError("extra_files");
  if (turn.page !== null && (!turn.page || turn.page.pageId !== input.page.pageId || typeof turn.page.markdown !== "string")) {
    throw new MacAiError("invalid_result");
  }
  return {
    reply: turn.finalEvent.text,
    sessionId: turn.finalEvent.session_id,
    writes: turn.page ? [{ pageId: turn.page.pageId, markdown: turn.page.markdown }] : [],
  };
}
