// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import type { AiDiffState, AttachedAi, AttachedAiDiff, AttachedAiSteps } from "@/lib/attached-page";
import { AiPanel } from "./AiBox";

const nativeMock = vi.hoisted(() => ({ shell: null as unknown }));
vi.mock("niho-desktop-bridge/tauri-shell-transport", () => ({ detectShell: () => nativeMock.shell }));

const resizeCallbacks: ResizeObserverCallback[] = [];
class FakeResizeObserver {
  constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
  observe() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  nativeMock.shell = null;
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  resizeCallbacks.length = 0;
  window.localStorage.removeItem("niho-editor:mac-ai-choice");
  vi.unstubAllGlobals();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.restoreAllMocks();
});

const PAGE_1 = "00000000-0000-4000-8000-000000000001";
const PAGE_2 = "00000000-0000-4000-8000-000000000002";
const CHAT_1 = "00000000-0000-4000-8000-0000000000c1";
const CHAT_2 = "00000000-0000-4000-8000-0000000000c2";
const MESSAGE = "00000000-0000-4000-8000-0000000000a1";
const AT = "2026-11-03T01:00:00.000Z";

const summary = (id: string, lastText = "前の返答") => ({ id, updatedAt: AT, messages: 2, lastText });
const messages = (name = "前の会話") => [
  { id: `${name}-u`, seq: 1, role: "user", text: name, preset: null, proposal: null, version: null, result: null, items: [], changes: [] },
  { id: `${name}-a`, seq: 2, role: "assistant", text: `${name}の返答`, preset: null, proposal: null, version: null, result: "done", items: [], changes: [] },
];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function chatResponse(text = "返答しました", options: { page?: unknown; changes?: unknown[]; conversationId?: string } = {}) {
  return json(200, {
    conversation: { id: options.conversationId ?? CHAT_1, messageId: MESSAGE },
    message: { id: MESSAGE, seq: 4, role: "assistant", text, preset: null, proposal: null, version: null, result: "done", resultCode: null, items: [], changes: options.changes ?? [] },
    page: options.page ?? null,
    usage: { nearLimit: false },
  });
}

function page(id = PAGE_1) {
  return { id, title: "合成ページ", blocks: [{ type: "paragraph", content: [{ type: "text", text: "本文" }] }], revision: 2, updatedAt: AT };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** 本文の「変更を見る」の代わり（開くと差分 2 か所を描いたことにする）。 */
function fakeDiff() {
  const listeners = new Set<(state: AiDiffState | null) => void>();
  let state: AiDiffState | null = null;
  const emit = (next: AiDiffState | null) => {
    state = next;
    listeners.forEach((listener) => listener(next));
  };
  const diff = {
    open: vi.fn(async ({ version }: { version: number; revision: number }) => emit({ version, hunks: 2, reverted: 0, edited: false })),
    close: vi.fn(() => emit(null)),
    subscribe: (listener: (next: AiDiffState | null) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    current: () => state,
  } satisfies AttachedAiDiff;
  return { ...diff, emit };
}

function context(id = PAGE_1, overrides: Partial<AttachedAi["bridge"]> = {}, diff: AttachedAiDiff = fakeDiff()): AttachedAi {
  return {
    editor: null,
    diff,
    title: "合成ページ",
    kind: "note",
    lang: "ja",
    bridge: {
      prepare: vi.fn(async () => ({ ok: true as const, pageId: id, revision: 1 })),
      saved: vi.fn(() => ({ title: "合成ページ", blocks: page(id).blocks, revision: 1 })),
      replace: vi.fn(async () => true),
      ...overrides,
    },
  };
}

function defaultServer(options: {
  list?: Response | Promise<Response>;
  get?: (id: string) => Response | Promise<Response>;
  device?: () => Response | Promise<Response>;
  chat?: (body: Record<string, unknown>, signal: AbortSignal | null | undefined) => Response | Promise<Response>;
} = {}) {
  const calls: { url: string; method: string; body: Record<string, unknown>; signal?: AbortSignal | null }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = String(init.method ?? "GET");
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, method, body, signal: init.signal });
    if (method === "GET" && url.endsWith("/ai/conversations")) return await (options.list ?? json(200, { conversations: [] }));
    if (method === "GET" && url.includes("/ai/conversations/")) {
      const id = decodeURIComponent(url.split("/").at(-1)!);
      if (options.get) return await options.get(id);
      return json(200, { conversation: summary(id), messages: messages(id) });
    }
    if (url.endsWith("/ai/chat/turns")) return options.device ? await options.device() : chatResponse("CLI の返答を保存しました");
    if (url.endsWith("/ai/chat")) return options.chat ? await options.chat(body, init.signal) : chatResponse();
    if (url.endsWith(`/ai/chat/${MESSAGE}/undo`)) return json(200, { undone: [PAGE_1], kept: [], page: page() });
    throw new Error(`unexpected ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher };
}

async function render(pageId: string | null = PAGE_1, ai: AttachedAi | null = context(pageId ?? PAGE_1), steps: AttachedAiSteps | null = null) {
  if (!container) {
    container = document.createElement("div");
    container.setAttribute("data-docs-app-root", "");
    container.setAttribute("data-docs-shared-ui", "");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(<div className="es-root"><AiPanel pageId={pageId} context={ai} steps={steps} /></div>);
  });
}

async function until(check: () => boolean, rounds = 30) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve(); });
    if (check()) return;
  }
  throw new Error("condition was not met");
}

/** SSE の応答（chunk を順に流す。`hold` を渡すと、それが解けるまで残りを流さない）。 */
function sseResponse(chunks: string[], hold?: Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const [first, ...rest] = chunks;
      if (first) controller.enqueue(encoder.encode(first));
      if (hold) await hold;
      for (const chunk of rest) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const field = () => container!.querySelector<HTMLTextAreaElement>('textarea[aria-label="AIへのメッセージ"]')!;
const button = (label: string) => container!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const logText = () => container!.querySelector('[role="log"]')?.textContent ?? "";
/** 入力欄の下端の「実行先・モデル・思考量」のボタンと、その窓。 */
const enginePill = () => container!.querySelector<HTMLButtonElement>(".es-ai-engine-pill");
const engineDialog = () => container!.querySelector<HTMLElement>('[role="dialog"][aria-label="AI の実行先・モデル・思考量"]');

function setValue(value: string, caret = value.length) {
  act(() => {
    const input = field();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}

describe("AiPanel", () => {
  it("has no axe serious/critical violations in the persistent rail UI", async () => {
    defaultServer();
    await render();
    await until(() => !button("新しい会話").disabled);
    const result = await axe.run(container!, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
  });

  it("is inline, loads the newest chat, and exposes new/history controls without presets or old entry text", async () => {
    defaultServer({ list: json(200, { conversations: [summary(CHAT_1)] }) });
    await render();
    await until(() => logText().includes(CHAT_1));
    expect(container!.querySelector('[role="dialog"]')).toBeNull();
    expect(container!.textContent).not.toMatch(/整える|要約|見出しをつける|英語にする|このページ|Enterで送信|\/ で工程・スキル/);
    expect(button("新しい会話")).toBeTruthy();
    expect(button("会話履歴と切り替え")).toBeTruthy();
  });

  it("does not send during initial history loading; Enter sends once after loading, Shift+Enter and IME Enter do not send", async () => {
    const waiting = deferred<Response>();
    const server = defaultServer({ list: waiting.promise });
    await render();
    setValue("相談したい");
    await press("Enter");
    expect(server.calls.filter((call) => call.url.endsWith("/ai/chat"))).toHaveLength(0);
    waiting.resolve(json(200, { conversations: [] }));
    await until(() => !button("メッセージを送る").disabled);
    await press("Enter", { shiftKey: true });
    await press("Enter", { isComposing: true });
    await press("Enter", { keyCode: 229 });
    expect(server.calls.filter((call) => call.url.endsWith("/ai/chat"))).toHaveLength(0);
    await press("Enter");
    await until(() => logText().includes("返答しました"));
    expect(server.calls.filter((call) => call.url.endsWith("/ai/chat"))).toHaveLength(1);
  });

  it("shows history failure and retry instead of pretending there is no history", async () => {
    let failed = true;
    vi.stubGlobal("fetch", vi.fn(async () => failed ? json(503, { error: "ai_unavailable" }) : json(200, { conversations: [] })));
    await render();
    await until(() => container!.textContent!.includes("会話履歴を読み込めませんでした"));
    await click(button("会話履歴と切り替え"));
    const retry = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "再試行")!;
    expect(retry).toBeTruthy();
    failed = false;
    await click(retry);
    await until(() => !button("新しい会話").disabled);
    await click(button("会話履歴と切り替え"));
    await until(() => container!.textContent!.includes("保存された会話はありません"));
  });

  it("supports Japanese slash search, keyboard selection/Esc, and inserts the fact-check instruction at the caret", async () => {
    defaultServer();
    await render();
    await until(() => !button("工程とスキルを開く").disabled);
    setValue("前置き /事実");
    expect(container!.querySelector('[aria-label="工程とスキル"]')?.textContent).toContain("事実確認");
    await press("Enter");
    expect(field().value).toContain("前置き\n本文の固有名詞・数値・日付・引用を、文字起こしと資料に照らし確認してください。本文は直さず、確認箇所と理由を一覧にしてください。");
    setValue("/要約");
    await press("Escape");
    expect(container!.querySelector('[aria-label="工程とスキル"]')).toBeNull();
  });

  it("grows the textarea up to ten lines and keeps vertical manual resize enabled", async () => {
    defaultServer();
    await render();
    setValue(Array.from({ length: 14 }, (_, index) => `行${index}`).join("\n"));
    expect(field().style.maxHeight).toBe("208px");
    expect(field().rows).toBe(2);
  });

  it("blocks double submit while prepare is pending", async () => {
    defaultServer();
    const waiting = deferred<{ ok: true; pageId: string; revision: number }>();
    const ai = context(PAGE_1, { prepare: vi.fn(() => waiting.promise) });
    await render(PAGE_1, ai);
    await until(() => !button("メッセージを送る").disabled || field() !== null);
    setValue("一度だけ");
    await press("Enter");
    await press("Enter");
    expect(ai.bridge.prepare).toHaveBeenCalledTimes(1);
    waiting.resolve({ ok: true, pageId: PAGE_1, revision: 1 });
  });

  it("keeps conflict handling: replaces with the latest server page and asks for a retry", async () => {
    const latest = page();
    const ai = context();
    defaultServer({ chat: () => json(409, { error: "conflict", page: latest }) });
    await render(PAGE_1, ai);
    await until(() => !field().disabled && !button("新しい会話").disabled);
    setValue("競合する依頼");
    await press("Enter");
    await until(() => container!.textContent!.includes("ページが更新されました。もう一度お試しください"));
    expect(ai.bridge.replace).toHaveBeenCalledWith(expect.objectContaining({ title: latest.title, blocks: latest.blocks, revision: latest.revision }), { saved: false });
  });

  it("runs a Mac CLI turn, records it once, and does not carry resume session into a new conversation", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const aiTurn = vi.fn(async (turnId: string, request: Record<string, unknown>) => {
      void turnId;
      void request;
      return {
        finalEvent: {
          type: "Done" as const,
          text: "CLI の返答",
          stop_reason: "EndTurn" as const,
          session_id: "resume-one",
          usage: { input_tokens: 1, output_tokens: 1, cost_usd: null, model_used: "gpt-5", cost_known: false },
          duration_ms: 1,
          continuations: 0,
        },
        page: null,
        pageRemoved: false,
        extraFiles: 0,
      };
    });
    nativeMock.shell = {
      aiEngines: vi.fn(async () => [{ engine: "cli:codex", installed: true, authenticated: true, reason: null, models: ["gpt-5"], effort: true, resume: true }]),
      aiTurn,
      aiStop: vi.fn(async () => true),
    };
    let deviceFails = false;
    const server = defaultServer({ device: () => deviceFails ? Promise.reject(new Error("network lost")) : chatResponse("CLI の返答を保存しました") });
    await render();
    await until(() => enginePill()?.textContent?.includes("Codex CLI") ?? false);
    setValue("端末で直す");
    await press("Enter");
    await until(() => logText().includes("CLI の返答を保存しました"));
    expect(server.calls.filter((call) => call.url.endsWith("/ai/chat/turns"))).toHaveLength(1);
    expect(server.calls.find((call) => call.url.endsWith("/ai/chat/turns"))?.body).toMatchObject({ input: "端末で直す", reply: "CLI の返答", engine: "cli:codex" });
    // 思考量を選んでいなければ（既定）、CLI へ送らない
    expect(aiTurn.mock.calls[0]?.[1]).not.toHaveProperty("effort");

    await click(button("新しい会話"));
    setValue("新しい会話");
    await press("Enter");
    await until(() => aiTurn.mock.calls.length === 2);
    expect(aiTurn.mock.calls[0]?.[1]).not.toHaveProperty("resumeSession");
    expect(aiTurn.mock.calls[1]?.[1]).not.toHaveProperty("resumeSession");
    await until(() => server.calls.filter((call) => call.url.endsWith("/ai/chat/turns")).length === 2);
    await until(() => !button("新しい会話").disabled);

    setValue("残す文章");
    await click(button("工程とスキルを開く"));
    await click([...container!.querySelectorAll<HTMLButtonElement>(".es-ai-menu-row")].find((item) => item.textContent?.includes("ここまでを要約して軽くする"))!);
    await until(() => field().value.includes("前の会話の要約"));
    expect(field().value).toContain("残す文章");
    expect(aiTurn.mock.calls).toHaveLength(3);
    expect(server.calls.some((call) => call.url.endsWith("/ai/chat"))).toBe(false);

    // CLI 完了後の保存通信が切れた場合は自動再送せず、保存済みか不明と明示する。
    await click(button("新しい会話"));
    deviceFails = true;
    setValue("保存結果が不明になる依頼");
    await press("Enter");
    await until(() => container!.textContent!.includes("保存結果を確認できませんでした"));
    expect(server.calls.filter((call) => call.url.endsWith("/ai/chat/turns"))).toHaveLength(4);
  });

  it("puts the Mac route, model and effort behind one button at the bottom of the input, sends the effort, and remembers them on this Mac", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const aiTurn = vi.fn(async (turnId: string, request: Record<string, unknown>) => {
      void turnId;
      void request;
      return {
        finalEvent: { type: "Done" as const, text: "CLI の返答", stop_reason: "EndTurn" as const, session_id: null, usage: { input_tokens: 1, output_tokens: 1, cost_usd: null, model_used: "sonnet", cost_known: false }, duration_ms: 1, continuations: 0 },
        page: null,
        pageRemoved: false,
        extraFiles: 0,
      };
    });
    nativeMock.shell = {
      aiEngines: vi.fn(async () => [
        { engine: "cli:claude-code", installed: true, authenticated: true, reason: null, models: ["sonnet", "opus"], effort: true, resume: true },
        { engine: "cli:codex", installed: false, authenticated: false, reason: "cli_not_found", models: [], effort: true, resume: true },
        { engine: "cli:antigravity", installed: true, authenticated: true, reason: null, models: ["gemini-3.8-flash", "gemini-3.8-flash-high"], effort: true, resume: true },
      ]),
      aiTurn,
      aiStop: vi.fn(async () => true),
    };
    defaultServer();
    await render();
    await until(() => enginePill()?.textContent?.includes("Claude Code · sonnet") ?? false);
    // 入力欄の上に選択欄は置かない。下端のボタンは押すまで閉じている
    expect(container!.querySelector("select")).toBeNull();
    expect(engineDialog()).toBeNull();
    expect(enginePill()!.getAttribute("aria-expanded")).toBe("false");

    await click(enginePill()!);
    expect(enginePill()!.getAttribute("aria-expanded")).toBe("true");
    const route = (value: string) => engineDialog()!.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
    const effort = (label: string) => [...engineDialog()!.querySelectorAll<HTMLLabelElement>(".es-ai-effort label")].find((item) => item.textContent === label)!.querySelector("input")!;
    // 入っていない CLI は選べない。既定の思考量は「既定」
    expect(route("cli:codex").disabled).toBe(true);
    expect(route("cli:claude-code").checked).toBe(true);
    expect(effort("既定").checked).toBe(true);
    await click(effort("高"));
    expect(enginePill()!.textContent).toContain("Claude Code · sonnet · 高");
    const result = await axe.run(container!, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);

    // Escape で閉じて、開いたボタンへ戻る
    await act(async () => {
      engineDialog()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(engineDialog()).toBeNull();
    expect(document.activeElement).toBe(enginePill());

    setValue("高い思考量で直す");
    await press("Enter");
    await until(() => aiTurn.mock.calls.length === 1);
    expect(aiTurn.mock.calls[0]?.[1]).toMatchObject({ engine: "cli:claude-code", model: "sonnet", effort: "high" });
    await until(() => !enginePill()!.disabled);

    // Antigravity の gemini-3.8-flash には「最大」が無い。思考量入りの名前のモデルは、思考量を選ばない
    await click(enginePill()!);
    await click(route("cli:antigravity"));
    expect(effort("最大").disabled).toBe(true);
    await act(async () => {
      const select = engineDialog()!.querySelector<HTMLSelectElement>('select[aria-label="CLI のモデル"]')!;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "gemini-3.8-flash-high");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(engineDialog()!.textContent).toContain("このモデルは、思考量が名前で決まっています（高）");
    expect(enginePill()!.textContent).toContain("Antigravity CLI · gemini-3.8-flash-high");

    // 窓の外を押すと閉じる
    await act(async () => {
      field().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(engineDialog()).toBeNull();

    // 開き直しても同じ実行先・モデル。Claude Code に戻すと、前に選んだ「高」のまま
    await act(async () => root!.unmount());
    container!.remove();
    root = null;
    container = null;
    await render();
    await until(() => enginePill()?.textContent?.includes("Antigravity CLI · gemini-3.8-flash-high") ?? false);
    await click(enginePill()!);
    await click(route("cli:claude-code"));
    expect(enginePill()!.textContent).toContain("Claude Code · sonnet · 高");
  });

  it("passes saved conversation history to the Mac CLI when no resumable session exists", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const aiTurn = vi.fn(async (turnId: string, request: Record<string, unknown>) => {
      void turnId;
      void request;
      return {
        finalEvent: {
          type: "Done" as const,
          text: "写真はページへ都度添付する方針。",
          stop_reason: "EndTurn" as const,
          session_id: null,
          usage: { input_tokens: 1, output_tokens: 1, cost_usd: null, model_used: "gpt-5", cost_known: false },
          duration_ms: 1,
          continuations: 0,
        },
        page: null,
        pageRemoved: false,
        extraFiles: 0,
      };
    });
    nativeMock.shell = {
      aiEngines: vi.fn(async () => [{ engine: "cli:codex", installed: true, authenticated: true, reason: null, models: ["gpt-5"], effort: true, resume: true }]),
      aiTurn,
      aiStop: vi.fn(async () => true),
    };
    const savedMessages = [
      { id: "saved-user", seq: 1, role: "user", text: "写真をライブラリに共有しない。文書ページへその都度添付する。", preset: null, proposal: null, version: null, result: null, items: [], changes: [] },
      { id: "saved-assistant", seq: 2, role: "assistant", text: "NIHO-editorでは写真ライブラリを作らず、ページ内の添付として扱います。", preset: null, proposal: null, version: null, result: "done", items: [], changes: [] },
    ];
    const server = defaultServer({
      list: json(200, { conversations: [summary(CHAT_1)] }),
      get: () => json(200, { conversation: summary(CHAT_1), messages: savedMessages }),
      device: () => chatResponse("写真はページへ都度添付する方針。", { conversationId: CHAT_1 }),
    });
    await render();
    await until(() => enginePill()?.textContent?.includes("Codex CLI") ?? false);
    await until(() => logText().includes("NIHO-editorでは写真ライブラリを作らず"));
    await click(button("工程とスキルを開く"));
    await click([...container!.querySelectorAll<HTMLButtonElement>(".es-ai-menu-row")].find((item) => item.textContent?.includes("ここまでを要約して軽くする"))!);
    await until(() => field().value.includes("写真はページへ都度添付する方針"));

    const instruction = String(aiTurn.mock.calls[0]?.[1].instruction);
    expect(instruction).toContain("保存済み会話");
    expect(instruction).toContain("写真をライブラリに共有しない");
    expect(instruction).toContain("NIHO-editorでは写真ライブラリを作らず");
    expect(aiTurn.mock.calls[0]?.[1]).toMatchObject({ conversationId: CHAT_1 });
    expect(aiTurn.mock.calls[0]?.[1]).not.toHaveProperty("resumeSession");
    const recorded = server.calls.find((call) => call.url.endsWith("/ai/chat/turns"));
    expect(recorded?.body).toMatchObject({ conversationId: CHAT_1, input: expect.stringContaining("会話で決まったこと") });
    expect(String(recorded?.body.input)).not.toContain("写真をライブラリに共有しない");
  });

  it("aborts/ignores an old reply when the page owner changes", async () => {
    const waiting = deferred<Response>();
    defaultServer({ chat: () => waiting.promise });
    const first = context(PAGE_1);
    await render(PAGE_1, first);
    setValue("古い依頼");
    await until(() => !button("メッセージを送る").disabled);
    await press("Enter");
    const second = context(PAGE_2);
    await render(PAGE_2, second);
    waiting.resolve(chatResponse("古い返答", { page: page(PAGE_1) }));
    await act(async () => { await Promise.resolve(); });
    expect(logText()).not.toContain("古い返答");
    expect(second.bridge.replace).not.toHaveBeenCalled();
  });

  it("does not unlock a new owner's pending turn when an old reply settles", async () => {
    const oldReply = deferred<Response>();
    const newReply = deferred<Response>();
    const server = defaultServer({ chat: (body) => body.text === "古い依頼" ? oldReply.promise : newReply.promise });
    await render(PAGE_1, context(PAGE_1));
    setValue("古い依頼");
    await press("Enter");
    await render(PAGE_2, context(PAGE_2));
    setValue("新しい依頼");
    await press("Enter");
    oldReply.resolve(chatResponse("古い返答"));
    await act(async () => { await Promise.resolve(); });
    await press("Enter");
    expect(server.calls.filter((call) => call.url.endsWith("/ai/chat"))).toHaveLength(2);
    newReply.resolve(chatResponse("新しい返答"));
    await until(() => logText().includes("新しい返答"));
    expect(logText()).not.toContain("古い返答");
  });

  it("keeps the current chat and draft when the compact handoff exceeds the input limit", async () => {
    defaultServer({ list: json(200, { conversations: [summary(CHAT_1)] }), chat: () => chatResponse("あ".repeat(2000)) });
    await render();
    await until(() => logText().includes(CHAT_1));
    setValue("入力中");
    await click(button("工程とスキルを開く"));
    await click([...container!.querySelectorAll<HTMLButtonElement>(".es-ai-menu-row")].find((item) => item.textContent?.includes("ここまでを要約して軽くする"))!);
    await until(() => container!.textContent!.includes("2000 文字を超えた"));
    expect(field().value).toBe("入力中");
    expect(logText()).toContain(CHAT_1);
  });

  it("switches saved chats and starts a new local conversation without deleting server history", async () => {
    const server = defaultServer({ list: json(200, { conversations: [summary(CHAT_1), summary(CHAT_2, "二つ目")] }) });
    await render();
    await until(() => logText().includes(CHAT_1));
    await click(button("会話履歴と切り替え"));
    const second = [...container!.querySelectorAll<HTMLButtonElement>(".es-ai-menu-row")].find((item) => item.textContent?.includes("二つ目"))!;
    await click(second);
    await until(() => logText().includes(CHAT_2));
    await click(button("新しい会話"));
    expect(logText()).not.toContain(CHAT_2);
    expect(server.calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("shows a saved-chat read failure and retries the same conversation", async () => {
    let failSecond = true;
    defaultServer({
      list: json(200, { conversations: [summary(CHAT_1), summary(CHAT_2, "二つ目")] }),
      get: (id) => id === CHAT_2 && failSecond
        ? json(503, { error: "ai_unavailable" })
        : json(200, { conversation: summary(id), messages: messages(id) }),
    });
    await render();
    await until(() => logText().includes(CHAT_1));
    await click(button("会話履歴と切り替え"));
    const second = [...container!.querySelectorAll<HTMLButtonElement>(".es-ai-menu-row")].find((item) => item.textContent?.includes("二つ目"))!;
    await click(second);
    await until(() => container!.textContent!.includes("会話を切り替えられませんでした"));
    failSecond = false;
    const retry = [...container!.querySelectorAll<HTMLButtonElement>(".es-ai-menu-note button")].find((item) => item.textContent === "再試行")!;
    await click(retry);
    await until(() => logText().includes(CHAT_2));
  });

  it("keeps the existing undo path and replaces the page with the saved undo result", async () => {
    const ai = context();
    const changed = {
      ...messages(CHAT_1)[1],
      id: MESSAGE,
      changes: [{ pageId: PAGE_1, title: "合成ページ", change: "edited", chars: 2, delta: 1, undoneAt: null }],
    };
    defaultServer({
      list: json(200, { conversations: [summary(CHAT_1)] }),
      get: () => json(200, { conversation: summary(CHAT_1), messages: [messages(CHAT_1)[0], changed] }),
    });
    await render(PAGE_1, ai);
    await until(() => container!.textContent!.includes("元に戻す"));
    await click([...container!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "元に戻す")!);
    await until(() => logText().includes("元に戻しました"));
    expect(ai.bridge.replace).toHaveBeenCalledWith(expect.objectContaining({ revision: 2 }), { saved: true });
  });

  it("compacts into a real new-conversation draft, but keeps the old chat/draft when the response changes the page", async () => {
    let changesPage = false;
    const ai = context();
    defaultServer({
      list: json(200, { conversations: [summary(CHAT_1)] }),
      chat: () => changesPage
        ? chatResponse("変更もしました", { page: page(), changes: [{ pageId: PAGE_1, title: "合成ページ", change: "edited", chars: 2, delta: 1, undoneAt: null }] })
        : chatResponse("決定事項の短い要約", { conversationId: CHAT_1 }),
    });
    await render(PAGE_1, ai);
    await until(() => logText().includes(CHAT_1));
    setValue("残しているdraft");
    await click(button("工程とスキルを開く"));
    await click([...container!.querySelectorAll<HTMLButtonElement>(".es-ai-menu-row")].find((item) => item.textContent?.includes("ここまでを要約して軽くする"))!);
    await until(() => field().value.includes("前の会話の要約"));
    expect(field().value).toContain("決定事項の短い要約");
    expect(field().value).toContain("残しているdraft");
    expect(logText()).not.toContain(CHAT_1);

    // 元会話を再読込して、本文変更を伴う compact は切り替えない。
    changesPage = true;
    await click(button("会話履歴と切り替え"));
    await click(container!.querySelector<HTMLButtonElement>(".es-ai-menu-row")!);
    await until(() => logText().includes(CHAT_1));
    setValue("保持するdraft");
    await click(button("工程とスキルを開く"));
    await click([...container!.querySelectorAll<HTMLButtonElement>(".es-ai-menu-row")].find((item) => item.textContent?.includes("ここまでを要約して軽くする"))!);
    await until(() => container!.textContent!.includes("本文の変更を伴ったため"));
    expect(field().value).toBe("保持するdraft");
    expect(logText()).toContain(CHAT_1);
    expect(ai.bridge.replace).toHaveBeenCalled();
  });

  it("attaches a real PageSteps option and reports its start result", async () => {
    defaultServer();
    const start = vi.fn(async () => ({ ok: true, message: "記事制作を開始しました" }));
    const steps: AttachedAiSteps = { ownerId: PAGE_1, options: [{ id: "article", label: "記事制作", hint: "記事にする", disabledReason: null }], start };
    const ai = context();
    await render(PAGE_1, ai, steps);
    await until(() => !button("工程とスキルを開く").disabled);
    await click(button("工程とスキルを開く"));
    await click([...container!.querySelectorAll<HTMLButtonElement>(".es-ai-menu-row")].find((item) => item.textContent?.includes("記事制作"))!);
    expect(container!.querySelector(".es-ai-chip")?.textContent).toContain("記事制作");
    await click(button("メッセージを送る"));
    await until(() => container!.textContent!.includes("記事制作を開始しました"));
    expect(start).toHaveBeenCalledWith("article");
    expect(ai.bridge.prepare).toHaveBeenCalledOnce();
  });

  it("shows no prompt text while the conversation is empty (the composer is the only cue)", async () => {
    defaultServer();
    await render(PAGE_1, context());
    expect(container!.querySelector(".es-ai-empty")).toBeNull();
    expect(container!.textContent).not.toContain("何をつくりますか");
  });

  it("shows narration as paragraphs before the reply and hides the tool lines", async () => {
    const answered = {
      ...messages(CHAT_1)[1],
      id: MESSAGE,
      text: "二段落目を短くしました。",
      items: [{ kind: "narration", text: "本文を読んで、二段落目を短くします。" }, { kind: "tool", tool: "read_page", page: "合成ページ", ok: true }],
    };
    defaultServer({ list: json(200, { conversations: [summary(CHAT_1)] }), get: () => json(200, { conversation: summary(CHAT_1), messages: [messages(CHAT_1)[0], answered] }) });
    await render();
    await until(() => logText().includes("二段落目を短くしました"));
    const paragraphs = [...container!.querySelectorAll(".es-ai-message--assistant p")].map((node) => node.textContent);
    expect(paragraphs).toEqual(["本文を読んで、二段落目を短くします。", "二段落目を短くしました。"]);
    expect(container!.querySelector(".es-ai-message ul")).toBeNull();
    expect(logText()).not.toContain("読みました");
  });

  it("streams a live reply with a work line, then replaces it with the saved reply", async () => {
    let release!: () => void;
    const hold = new Promise<void>((done) => { release = done; });
    const done = await chatResponse("一段落目を直しました。").json();
    const server = defaultServer({
      chat: () => sseResponse([
        sse("text", { text: "本文を読みます。" }) + sse("tool", { tool: "read_page", page: null, ok: null, phase: "start" }),
        sse("tool", { tool: "read_page", page: "合成ページ", ok: true, phase: "end" }) + sse("text", { text: "一段落目を直しました。" }) + sse("done", done),
      ], hold),
    });
    await render();
    setValue("一段落目を直して");
    await until(() => !button("メッセージを送る").disabled);
    expect(container!.querySelector(".es-ai-work")).toBeNull();
    await press("Enter");
    await until(() => container!.querySelector(".es-ai-work") !== null);
    expect(container!.querySelector(".es-ai-message--live")?.textContent).toContain("本文を読みます。");
    expect(container!.querySelector(".es-ai-work")?.textContent).toBe("本文を読んでいます…");
    expect([...container!.querySelectorAll(".es-ai-message--user")].map((node) => node.textContent)).toContain("一段落目を直して");
    expect(button("止める")).toBeTruthy();
    expect(server.calls.find((call) => call.url.endsWith("/ai/chat"))).toBeTruthy();
    release();
    await until(() => container!.querySelector(".es-ai-message--live") === null);
    expect(container!.querySelector(".es-ai-work")).toBeNull();
    expect(logText()).toContain("一段落目を直しました。");
    expect([...container!.querySelectorAll(".es-ai-message--user")].map((node) => node.textContent)).toEqual(["一段落目を直して"]);
    expect(button("メッセージを送る")).toBeTruthy();
  });

  it("stops a running turn with the square stop button", async () => {
    defaultServer({
      chat: (_body, signal) => new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    });
    await render();
    setValue("長い依頼");
    await until(() => !button("メッセージを送る").disabled);
    await press("Enter");
    await until(() => container!.querySelector('button[aria-label="止める"]') !== null);
    expect(button("止める").classList.contains("es-ai-send--stop")).toBe(true);
    expect([...container!.querySelectorAll("button")].some((item) => item.textContent === "中止")).toBe(false);
    await click(button("止める"));
    await until(() => container!.textContent!.includes("中止しました"));
    expect(container!.querySelector('button[aria-label="止める"]')).toBeNull();
    expect(field().value).toBe("長い依頼");
  });

  it("shows one version line per change and offers 変更を見る only for an edit of the open page with a version", async () => {
    const diff = fakeDiff();
    const ai = context(PAGE_1, {}, diff);
    const change = (pageId: string, extra: Record<string, unknown>) => ({ pageId, title: `題名${pageId.slice(-1)}`, change: "edited", version: 4, revision: 7, chars: 10, delta: -18, undoneAt: null, ...extra });
    const answered = {
      ...messages(CHAT_1)[1],
      id: MESSAGE,
      changes: [change(PAGE_1, {}), change(PAGE_2, {}), change("00000000-0000-4000-8000-000000000003", { change: "created", version: null, delta: 30 })],
    };
    const old = { ...messages(CHAT_1)[1], id: "old-message", seq: 1, changes: [change(PAGE_1, { version: null }), change(PAGE_1, { undoneAt: AT })] };
    defaultServer({ list: json(200, { conversations: [summary(CHAT_1)] }), get: () => json(200, { conversation: summary(CHAT_1), messages: [old, messages(CHAT_1)[0], answered] }) });
    await render(PAGE_1, ai);
    await until(() => container!.querySelectorAll(".es-ai-verline").length === 5);
    expect(container!.querySelector(".es-ai-change")).toBeNull();
    const lines = [...container!.querySelectorAll(".es-ai-verline")];
    expect(lines.map((line) => line.querySelector("span")?.textContent)).toEqual([
      "題名1 を直しました（-18 字）",
      "題名1 を直しました（-18 字）（元に戻しました）",
      "題名1 を直しました（-18 字）",
      "題名2 を直しました（-18 字）",
      "題名3 を作りました（30 字）",
    ]);
    const views = lines.map((line) => [...line.querySelectorAll("button")].find((item) => item.textContent === "変更を見る") ?? null);
    expect(views.map(Boolean)).toEqual([false, false, true, false, false]);
    await click(views[2]!);
    expect(diff.open).toHaveBeenCalledWith({ version: 4, revision: 7 });
    await until(() => lines[2]!.textContent!.includes("変更を閉じる"));
    act(() => diff.emit({ version: 4, hunks: 1, reverted: 2, edited: false }));
    await click([...lines[2]!.querySelectorAll("button")].find((item) => item.textContent === "変更を閉じる")!);
    expect(diff.close).toHaveBeenCalled();
    await until(() => lines[2]!.textContent!.includes("（2 か所を戻しました）"));
    expect(lines[2]!.textContent).toContain("変更を見る");
  });

  it("says the change could not be read when the version fails to load", async () => {
    const diff = fakeDiff();
    diff.open.mockRejectedValueOnce(new Error("not found"));
    const answered = { ...messages(CHAT_1)[1], id: MESSAGE, changes: [{ pageId: PAGE_1, title: "題名", change: "edited", version: 4, revision: 7, chars: 1, delta: 1, undoneAt: null }] };
    defaultServer({ list: json(200, { conversations: [summary(CHAT_1)] }), get: () => json(200, { conversation: summary(CHAT_1), messages: [messages(CHAT_1)[0], answered] }) });
    await render(PAGE_1, context(PAGE_1, {}, diff));
    await until(() => container!.textContent!.includes("変更を見る"));
    await click([...container!.querySelectorAll<HTMLButtonElement>(".es-ai-verline button")].find((item) => item.textContent === "変更を見る")!);
    await until(() => container!.textContent!.includes("変更を読めませんでした"));
    expect(container!.textContent).not.toContain("変更を閉じる");
  });

  it.each([
    ["推敲", "文体をそろえ、繰り返しと冗長な言い回しを削って読みやすくしてください。意味・固有名詞・数字・引用は変えないでください。"],
    ["肉付け", "本文の各段落を章の書き出しとして一字も変えずに残し"],
  ])("inserts the %s skill text into the composer", async (label, text) => {
    defaultServer();
    await render();
    await until(() => !button("工程とスキルを開く").disabled);
    await click(button("工程とスキルを開く"));
    await click([...container!.querySelectorAll<HTMLButtonElement>(".es-ai-menu-row")].find((item) => item.textContent?.startsWith(label))!);
    expect(field().value).toContain(text);
  });
});
