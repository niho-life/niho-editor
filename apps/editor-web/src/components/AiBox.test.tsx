// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_CHAT_INPUT_CHARS } from "@/ai/chat-limits";
import { presetsFor } from "@/ai/presets";
import { AI_ADOPT_REFUSED_TEXT, AI_BLOCKED_TEXT, AI_ERROR_TEXT, AI_NOTICE_MS, AI_TEXT, aiAdoptedText, aiDoneText } from "./AiBox";
import { PageEditor, type EditablePage } from "./PageEditor";

const nativeMock = vi.hoisted(() => ({ shell: null as unknown }));
vi.mock("niho-desktop-bridge/tauri-shell-transport", () => ({ detectShell: () => nativeMock.shell }));

beforeAll(() => {
  // jsdom に無い描画の API（ProseMirror・浮かぶメニューの位置の計算が読む）
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => undefined;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  nativeMock.shell = null;
});

const PAGE_ID = "00000000-0000-4000-8000-000000000001";
const UPDATED_AT = "2026-10-31T03:40:00.000Z";
const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
/** 最上位のブロック: 0「一つ目」・1「二つ目」・2「三つ目 です」。 */
const BODY = [p("一つ目"), p("二つ目"), p("三つ目 です")];

/** 先頭への差し込み 1 つと、段落 0・2 の変更（並びは 差し込み → 0 → 2）。 */
const PROPOSAL = {
  label: "整える",
  baseRevision: 1,
  changes: [
    { index: 0, before: "一つ目", after: "一つ目。", parts: ["一つ目", { ins: "。" }] },
    { index: 2, before: "三つ目 です", after: "三つ目です", parts: ["三つ目", { del: " " }, "です"] },
  ],
  inserts: [{ afterIndex: -1, kind: "paragraph", text: "要約（合成）" }],
  unchanged: 1,
};
const USAGE = { month: "2026-10", inputTokens: 10, outputTokens: 5, costUsd: 0, limitUsd: null, nearLimit: false };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Call = { url: string; method: string; body: Record<string, unknown>; signal?: AbortSignal | null };
type Handler = (body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>;

/**
 * サーバーの代わり。保存（PATCH）は revision を 1 つ進める（`save` で差し替え）。提案・採用は渡した応答。
 * 既定の提案は PROPOSAL（baseRevision は送られてきた値）、既定の採用は採用したものを当てた本文で revision を進める。
 */
function fakeServer(options: { proposal?: Handler; adoption?: Handler; save?: Handler; chats?: ChatHistory; chat?: Handler; deviceTurn?: Handler; undo?: Handler } = {}) {
  const calls: Call[] = [];
  let revision = 1;
  // 会話（開いたときに読む履歴）。渡さなければ会話なし
  const history = options.chats ?? { conversations: [], messages: {} };
  let conversations = history.conversations;
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = String(init.method ?? "GET");
    if (method === "GET") {
      calls.push({ url, method, body: {}, signal: init.signal });
      if (url === `/api/pages/${PAGE_ID}/ai/conversations`) return json(200, { conversations });
      const opened = /\/ai\/conversations\/([^/]+)$/.exec(url)?.[1];
      const found = opened ? history.messages[opened] : undefined;
      if (!opened || !found) throw new Error(`unexpected request GET ${url}`);
      const summary = conversations.find((item) => item.id === opened) ?? { id: opened, updatedAt: UPDATED_AT, messages: found.length, lastText: null };
      return json(200, { conversation: summary, messages: found });
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, method, body, signal: init.signal });
    if (url === `/api/pages/${PAGE_ID}` && init.method === "PATCH") {
      if (options.save) return options.save(body, init);
      revision = (body.baseRevision as number) + 1;
      return json(200, { page: { id: PAGE_ID, revision } });
    }
    if (url === `/api/pages/${PAGE_ID}/ai/proposals`) {
      if (options.proposal) return options.proposal(body, init);
      const id = typeof body.conversationId === "string" ? body.conversationId : CONVERSATION_ID;
      if (!conversations.some((item) => item.id === id)) conversations = [{ id, updatedAt: UPDATED_AT, messages: 2, lastText: null }, ...conversations];
      return json(200, { proposal: { ...PROPOSAL, baseRevision: body.baseRevision }, usage: USAGE, conversation: { id, messageId: MESSAGE_ID } });
    }
    if (url === `/api/pages/${PAGE_ID}/ai/chat/turns` && options.deviceTurn) return options.deviceTurn(body, init);
    if (url === `/api/pages/${PAGE_ID}/ai/chat`) {
      if (options.chat) return options.chat(body, init);
      revision += 1;
      return json(200, {
        conversation: { id: CONVERSATION_ID, messageId: MESSAGE_ID },
        message: {
          id: MESSAGE_ID,
          seq: 2,
          role: "assistant",
          text: "二段落目を短くしました。",
          preset: null,
          proposal: null,
          version: null,
          items: [
            { kind: "tool", tool: "read_page", page: "合成の題名", ok: true },
            { kind: "tool", tool: "write_page", page: "合成の題名", ok: true },
          ],
          result: "done",
          resultCode: null,
          changes: [{ pageId: PAGE_ID, title: "合成の題名", change: "edited", chars: 12, delta: 3, undoneAt: null }],
        },
        page: { id: PAGE_ID, title: "合成の題名", blocks: CHAT_WRITTEN, revision, updatedAt: UPDATED_AT },
        usage: { nearLimit: false },
      });
    }
    if (url === `/api/pages/${PAGE_ID}/ai/chat/${MESSAGE_ID}/undo`) {
      if (options.undo) return options.undo(body, init);
      revision += 1;
      return json(200, { undone: [PAGE_ID], kept: [], page: { id: PAGE_ID, title: "合成の題名", blocks: BODY, revision, updatedAt: UPDATED_AT } });
    }
    if (url === `/api/pages/${PAGE_ID}/ai/adoptions`) {
      if (options.adoption) return options.adoption(body, init);
      revision = (body.baseRevision as number) + 1;
      return json(200, {
        page: { id: PAGE_ID, title: "合成の題名", blocks: ADOPTED, revision, updatedAt: UPDATED_AT },
        adopted: typeof body.messageId === "string" ? { messageId: body.messageId, version: 7 } : null,
      });
    }
    throw new Error(`unexpected request ${init.method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    proposals: () => calls.filter((call) => call.url.endsWith("/ai/proposals")),
    adoptions: () => calls.filter((call) => call.url.endsWith("/ai/adoptions")),
    saves: () => calls.filter((call) => call.method === "PATCH"),
    chats: () => calls.filter((call) => call.url.includes("/ai/conversations")),
    turns: () => calls.filter((call) => call.url.endsWith("/ai/chat")),
    deviceTurns: () => calls.filter((call) => call.url.endsWith("/ai/chat/turns")),
    undos: () => calls.filter((call) => call.url.endsWith("/undo")),
  };
}

/** 既定の AI チャットが書いた本文。 */
const CHAT_WRITTEN = [p("一つ目"), p("二つ目"), p("三つ目")];

const CONVERSATION_ID = "00000000-0000-4000-8000-0000000000c1";
const MESSAGE_ID = "00000000-0000-4000-8000-0000000000m1".replace("m", "a");

type ChatSummary = { id: string; updatedAt: string; messages: number; lastText: string | null };
type ChatMessage = { id: string; seq: number; role: "user" | "assistant"; text: string; preset: string | null; proposal?: unknown; version: number | null };
type ChatHistory = { conversations: ChatSummary[]; messages: Record<string, ChatMessage[]> };

/** 1 回のやりとりが残った会話（採用まで済んだもの）。 */
function savedChat(): ChatHistory {
  return {
    conversations: [{ id: CONVERSATION_ID, updatedAt: UPDATED_AT, messages: 2, lastText: "提案が 3 件あります" }],
    messages: {
      [CONVERSATION_ID]: [
        { id: "ask-1", seq: 1, role: "user", text: "整える", preset: "tidy", version: null },
        { id: "result-1", seq: 2, role: "assistant", text: "提案が 3 件あります", preset: null, proposal: PROPOSAL, version: 4 },
      ],
    },
  };
}

/** 既定の採用の応答の本文。 */
const ADOPTED = [p("要約（合成）"), p("一つ目。"), p("二つ目"), p("三つ目 です")];

/** TipTap の focus コマンドは requestAnimationFrame の中でフォーカスする。偽の時計で進められるようにする。 */
function fakeTimersWithFrames() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function renderPage(page: Partial<EditablePage> = {}, events: { onSaved?: () => void } = {}) {
  fakeTimersWithFrames();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const full = { id: PAGE_ID, title: "合成の題名", blocks: BODY, revision: 1, updatedAt: UPDATED_AT, ...page } as EditablePage;
  await act(async () => {
    root!.render(<PageEditor page={full} drafts={null} onSaved={events.onSaved} />);
  });
  await advance(0);
  return bodyEditor();
}

function bodyEditor(): Editor {
  return (container!.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
}

const entry = () => container!.querySelector<HTMLButtonElement>('button[aria-label="AI に頼む（ページ全体）"]')!;
const dialog = () => container!.querySelector<HTMLElement>('[role="dialog"][aria-label="AI に頼む"]');
const statusText = () => dialog()!.querySelector("[data-ai-status]")!.textContent;
const presetLabels = () => [...dialog()!.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="候補"] button')].map((button) => button.textContent);
const preset = (label: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="候補"] button')].find((button) => button.textContent === label)!;
const input = () => dialog()!.querySelector<HTMLInputElement>('input[aria-label="直したいこと・作りたいもの"]')!;
const buttonIn = (scope: Element, text: string | RegExp) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => (typeof text === "string" ? button.textContent === text : text.test(button.textContent ?? "")));
const adoptButton = () => buttonIn(dialog()!, /^反映する/)!;
const proposalBlocks = () => [...dialog()!.querySelectorAll<HTMLElement>(".es-prop .es-blk")];
const thread = () => dialog()!.querySelector<HTMLElement>("[data-ai-thread] [role=\"log\"]");
const threadLines = () => [...(thread()?.querySelectorAll<HTMLElement>(".es-msg") ?? [])].map((line) => [line.classList.contains("es-msg--me") ? "me" : "ai", line.textContent]);
const notice = () => container!.querySelector("[data-ai-notice]")!.textContent;

/** ブラウザと同じく、mousedown の既定の動作（止められていなければ）でボタンにフォーカスしてから押す（jsdom はフォーカスを動かさない）。 */
async function click(element: HTMLElement) {
  await act(async () => {
    const proceed = element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    if (proceed && !(element as HTMLButtonElement).disabled) element.focus();
    element.click();
  });
  await advance(20);
}

async function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
  await advance(20);
}

async function type(editor: Editor, text: string) {
  await act(async () => {
    editor.view.dispatch(editor.state.tr.insertText(text));
  });
  await advance(0);
}

function setInputValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openBox() {
  await click(entry());
  await advance(0);
  expect(dialog()).not.toBeNull();
}

/** 提案を頼んで結果を出す（既定は「整える」）。 */
async function askTidy() {
  await openBox();
  await click(preset("整える"));
  await advance(0);
}

describe("the AI box: opening, candidates and focus", () => {
  it("opens from the page's AI button as a dialog over the whole page, moves focus in, and closes on Esc back to the button", async () => {
    fakeServer();
    await renderPage();
    expect(dialog()).toBeNull();
    entry().focus();
    await openBox();
    const box = dialog()!;
    expect(box.closest(".es-root")?.closest("[data-docs-app-root][data-docs-shared-ui]")).not.toBeNull();
    expect(document.activeElement).toBe(box);
    expect(entry().getAttribute("aria-expanded")).toBe("true");
    expect(box.querySelector("[data-ai-target]")!.textContent).toBe("ページ全体");
    // 状態は aria-live="polite" で読み上げる
    expect(box.querySelector("[data-ai-status]")!.getAttribute("aria-live")).toBe("polite");
    await press(box, "Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(entry());
    expect(entry().getAttribute("aria-expanded")).toBe("false");
    // 開いているときにもう一度押すと閉じる
    await openBox();
    await click(entry());
    expect(dialog()).toBeNull();
  });

  it("shows the candidates of the page's kind and language, and only the free input for a kind without any", async () => {
    fakeServer();
    const cases = [
      { kind: "note", lang: "ja" },
      { kind: "article", lang: "ja" },
      { kind: "article", lang: "en" },
      { kind: "rec", lang: "ja" },
      { kind: "step", lang: "ja" },
    ] as const;
    for (const { kind, lang } of cases) {
      await renderPage({ kind, lang });
      await openBox();
      expect(presetLabels(), `${kind}/${lang}`).toEqual(presetsFor(kind, lang).map((item) => item.label));
      expect(input().placeholder).toBe("直したいこと・作りたいもの…");
      await act(async () => root?.unmount());
      container?.remove();
    }
    expect(presetsFor("step", "ja")).toEqual([]);
  });

  it("is a page without kind (a new page) treated as a Japanese note", async () => {
    fakeServer();
    await renderPage({ kind: undefined, lang: undefined });
    await openBox();
    expect(presetLabels()).toEqual(["整える", "要約", "見出しをつける", "英語にする"]);
  });
});

describe("the AI box: asking", () => {
  it("sends baseRevision and the preset for the whole page, and nothing changes in the page", async () => {
    const server = fakeServer();
    const editor = await renderPage();
    const before = JSON.stringify(editor.getJSON());
    await askTidy();
    expect(server.proposals().map((call) => call.body)).toEqual([{ baseRevision: 1, intent: { preset: "tidy" } }]);
    expect(JSON.stringify(editor.getJSON())).toBe(before);
    // 提案は保存しない
    await advance(5000);
    expect(server.saves()).toEqual([]);
  });

  it("saves the unsaved input first and asks on the revision that save returned", async () => {
    const server = fakeServer();
    const editor = await renderPage();
    await act(async () => {
      editor.commands.setTextSelection(4);
    });
    await type(editor, "の続き");
    await openBox();
    // 1 秒を待たずに、開いたときに保存し終える
    expect(server.saves().map((call) => call.body.baseRevision)).toEqual([1]);
    await click(preset("整える"));
    await advance(0);
    // 箱を開くと、保存のあとにこのページの会話を読む（履歴）。頼むのはそのあと
    expect(server.calls.map((call) => `${call.method} ${call.url.replace(`/api/pages/${PAGE_ID}`, "")}`)).toEqual([
      "PATCH ",
      "GET /ai/conversations",
      "POST /ai/proposals",
    ]);
    expect(server.proposals()[0]!.body).toEqual({ baseRevision: 2, intent: { preset: "tidy" } });
  });

  it("opens from the format bar's AI over the selected blocks and sends them as the scope", async () => {
    const server = fakeServer();
    const editor = await renderPage();
    // 「二つ目」の途中から「三つ目 です」の途中まで（最上位のブロック 1〜2）
    const second = 1 + editor.state.doc.child(0).nodeSize;
    const third = second + editor.state.doc.child(1).nodeSize;
    await act(async () => {
      editor.view.focus();
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, second + 1, third + 2)));
    });
    await advance(300);
    await click(container!.querySelector<HTMLButtonElement>('[data-page-chrome] button[aria-label="AI に頼む"]')!);
    await advance(0);
    expect(dialog()!.querySelector("[data-ai-target]")!.textContent).toBe("選んだ範囲");
    await click(preset("要約"));
    await advance(0);
    expect(server.proposals()[0]!.body).toEqual({ baseRevision: 1, intent: { preset: "summarize" }, scope: { fromIndex: 1, toIndex: 2 } });
    // 閉じたら本文へフォーカスを戻す
    await click(buttonIn(dialog()!, "閉じる")!);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("sends the free input to the chat on Enter, but not on the Enter that confirms a Japanese conversion", async () => {
    const server = fakeServer();
    await renderPage();
    await openBox();
    const field = input();
    expect(buttonIn(dialog()!, "送る")!.disabled).toBe(true);
    await act(async () => setInputValue(field, "  です・ます調にする  "));
    await press(field, "Enter", { isComposing: true });
    await press(field, "Enter", { keyCode: 229 });
    expect(server.turns()).toEqual([]);
    await press(field, "Enter");
    await advance(0);
    // 自由入力は提案ではなくチャット（AI がページを直接書き換える）
    expect(server.proposals()).toEqual([]);
    expect(server.turns().map((call) => call.body)).toEqual([{ text: "です・ます調にする" }]);
  });

  it("does not send an empty request, and keeps the input to the chat's limit", async () => {
    const server = fakeServer();
    await renderPage();
    await openBox();
    await act(async () => setInputValue(input(), "   "));
    await press(input(), "Enter");
    expect(server.turns()).toEqual([]);
    expect(input().maxLength).toBe(MAX_CHAT_INPUT_CHARS);
  });

  it("says it is thinking, and the stop button aborts the request and lets the user ask again", async () => {
    const server = fakeServer({
      proposal: (_body, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        }),
    });
    await renderPage();
    await askTidy();
    expect(statusText()).toBe(AI_TEXT.thinking);
    expect(preset("整える").disabled).toBe(true);
    const stop = buttonIn(dialog()!, "中止")!;
    expect(document.activeElement).toBe(stop);
    await click(stop);
    await advance(0);
    expect(server.proposals()[0]!.signal?.aborted).toBe(true);
    expect(statusText()).toBe(AI_ERROR_TEXT.aborted);
    expect(buttonIn(dialog()!, "中止")).toBeUndefined();
    expect(preset("整える").disabled).toBe(false);
  });

  it("aborts a request in flight when the box is closed", async () => {
    const server = fakeServer({ proposal: () => new Promise<Response>(() => undefined) });
    await renderPage();
    await askTidy();
    await press(dialog()!, "Escape");
    expect(dialog()).toBeNull();
    expect(server.proposals()[0]!.signal?.aborted).toBe(true);
  });
});

describe("the AI box: the proposal", () => {
  it("shows changes as a diff (struck red, green) and inserts in green only, in the page's order", async () => {
    fakeServer();
    await renderPage();
    await askTidy();
    expect(statusText()).toBe("提案が 3 件あります");
    const section = dialog()!.querySelector('section[aria-label="整える の提案"]');
    expect(section).not.toBeNull();
    const [insert, first, third] = proposalBlocks();
    expect(insert!.querySelector("ins")!.textContent).toBe("要約（合成）");
    expect(insert!.querySelector("del")).toBeNull();
    expect(first!.querySelector("ins")!.textContent).toBe("。");
    expect(third!.querySelector("del")!.textContent).toBe(" ");
    for (const block of proposalBlocks()) {
      expect(buttonIn(block, "採用")).toBeDefined();
      expect(buttonIn(block, "そのまま")).toBeDefined();
    }
  });

  it("toggles each item between 採用 and そのまま locally, counts the adopted ones, and can choose again", async () => {
    const server = fakeServer();
    await renderPage();
    await askTidy();
    expect(adoptButton().textContent).toBe("反映する（0 件）");
    expect(adoptButton().disabled).toBe(true);
    await click(buttonIn(proposalBlocks()[1]!, "採用")!);
    await click(buttonIn(proposalBlocks()[2]!, "そのまま")!);
    expect(proposalBlocks()[1]!.querySelector(".es-note")!.textContent).toBe("採用します");
    expect(proposalBlocks()[2]!.querySelector(".es-note")!.textContent).toBe("そのままにします");
    expect(adoptButton().textContent).toBe("反映する（1 件）");
    // 選んだだけでは何も送らない
    expect(server.adoptions()).toEqual([]);
    // フォーカスはまだ選んでいない項目の「採用」へ
    expect(document.activeElement).toBe(buttonIn(proposalBlocks()[0]!, "採用"));
    await click(buttonIn(dialog()!, "選び直す")!);
    expect(adoptButton().textContent).toBe("反映する（0 件）");
    expect(proposalBlocks().every((block) => block.querySelector(".es-note") === null)).toBe(true);
    await click(buttonIn(proposalBlocks()[2]!, "採用")!);
    expect(adoptButton().textContent).toBe("反映する（1 件）");
  });

  it("cannot adopt with nothing chosen as 採用 (only そのまま)", async () => {
    const server = fakeServer();
    await renderPage();
    await askTidy();
    for (const block of proposalBlocks()) await click(buttonIn(block, "そのまま")!);
    expect(adoptButton().disabled).toBe(true);
    await click(adoptButton());
    expect(server.adoptions()).toEqual([]);
  });

  it("sends only the items chosen as 採用, in one request, with the proposal's positions", async () => {
    const server = fakeServer();
    await renderPage();
    await askTidy();
    await click(buttonIn(proposalBlocks()[0]!, "採用")!);
    await click(buttonIn(proposalBlocks()[1]!, "そのまま")!);
    await click(buttonIn(proposalBlocks()[2]!, "採用")!);
    await click(adoptButton());
    await advance(0);
    expect(server.adoptions().map((call) => call.body)).toEqual([
      { baseRevision: 1, changes: [{ index: 2, text: "三つ目です" }], inserts: [{ afterIndex: -1, kind: "paragraph", text: "要約（合成）" }], messageId: MESSAGE_ID },
    ]);
  });

  it("adopts everything in one request on すべて採用", async () => {
    const server = fakeServer();
    await renderPage();
    await askTidy();
    await click(buttonIn(dialog()!, "すべて採用")!);
    await advance(0);
    expect(server.adoptions().map((call) => call.body)).toEqual([
      {
        baseRevision: 1,
        changes: [
          { index: 0, text: "一つ目。" },
          { index: 2, text: "三つ目です" },
        ],
        inserts: [{ afterIndex: -1, kind: "paragraph", text: "要約（合成）" }],
        messageId: MESSAGE_ID,
      },
    ]);
  });

  it("on 200, puts the saved body in the editor (not in Undo), advances the revision without an autosave, closes, and says it can be undone from history", async () => {
    const server = fakeServer();
    const onSaved = vi.fn();
    const editor = await renderPage({}, { onSaved });
    entry().focus();
    await askTidy();
    await click(buttonIn(proposalBlocks()[1]!, "採用")!);
    await click(adoptButton());
    await advance(0);
    expect(editor.getJSON().content).toEqual(ADOPTED);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(entry());
    expect(notice()).toBe(aiDoneText(7));
    expect(onSaved).toHaveBeenCalledTimes(1);
    // 載せ替えは自動保存を起こさず、Undo で採用前に戻らない
    await advance(5000);
    expect(server.saves()).toEqual([]);
    await act(async () => {
      editor.commands.undo();
    });
    expect(editor.getJSON().content).toEqual(ADOPTED);
    // 次の保存は、採用で進んだ revision から
    await act(async () => {
      editor.commands.setTextSelection(3);
    });
    await type(editor, "追記");
    await advance(1000);
    expect(server.saves().map((call) => call.body.baseRevision)).toEqual([2]);
    await advance(AI_NOTICE_MS);
    expect(notice()).toBe("");
  });

  it("closes the proposal without changing the page (back to the candidates), and the box without saving anything", async () => {
    const server = fakeServer();
    const editor = await renderPage();
    const before = JSON.stringify(editor.getJSON());
    await askTidy();
    await click(buttonIn(dialog()!.querySelector(".es-prop")!, "閉じる")!);
    expect(dialog()!.querySelector(".es-prop")).toBeNull();
    expect(presetLabels()).toContain("整える");
    await click(buttonIn(dialog()!, "閉じる")!);
    expect(dialog()).toBeNull();
    expect(JSON.stringify(editor.getJSON())).toBe(before);
    await advance(5000);
    expect(server.adoptions()).toEqual([]);
    expect(server.saves()).toEqual([]);
  });

  it("drops the proposal when the page is edited while it is shown, and asks to make a new one", async () => {
    const server = fakeServer();
    const editor = await renderPage();
    await askTidy();
    await act(async () => {
      editor.commands.setTextSelection(3);
    });
    await type(editor, "手で直した");
    expect(dialog()!.querySelector(".es-prop")).toBeNull();
    expect(statusText()).toBe(AI_TEXT.stale);
    expect(server.adoptions()).toEqual([]);
  });

  it("says when there is nothing to change", async () => {
    fakeServer({ proposal: () => json(200, { proposal: { ...PROPOSAL, changes: [], inserts: [], unchanged: 3 }, usage: USAGE }) });
    await renderPage();
    await askTidy();
    expect(statusText()).toBe(AI_TEXT.nothing);
    expect(dialog()!.querySelector(".es-prop")).toBeNull();
  });

  it("says the monthly usage is near the limit only when the response says so", async () => {
    fakeServer({ proposal: (body) => json(200, { proposal: { ...PROPOSAL, baseRevision: body.baseRevision }, usage: { ...USAGE, nearLimit: true } }) });
    await renderPage();
    await askTidy();
    expect(dialog()!.querySelector("[data-ai-near-limit]")!.textContent).toBe(AI_TEXT.nearLimit);
    await act(async () => root?.unmount());
    container?.remove();
    fakeServer();
    await renderPage();
    await askTidy();
    expect(dialog()!.querySelector("[data-ai-near-limit]")).toBeNull();
  });

  it("waits for a Japanese conversion in the body to end before putting the adopted body in", async () => {
    let respond: (response: Response) => void = () => undefined;
    fakeServer({ adoption: () => new Promise<Response>((resolve) => (respond = resolve)) });
    const editor = await renderPage();
    await askTidy();
    await click(buttonIn(proposalBlocks()[1]!, "採用")!);
    await click(adoptButton());
    expect(statusText()).toBe(AI_TEXT.adopting);
    await act(async () => {
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    respond(json(200, { page: { id: PAGE_ID, title: "合成の題名", blocks: ADOPTED, revision: 2, updatedAt: UPDATED_AT } }));
    await advance(500);
    expect(editor.getJSON().content).toEqual(BODY);
    await act(async () => {
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    await advance(200);
    expect(editor.getJSON().content).toEqual(ADOPTED);
  });
});

describe("the AI box: conflicts and errors", () => {
  const LATEST = { id: PAGE_ID, title: "別の画面の題名", blocks: [p("別の画面で書いた")], revision: 5, updatedAt: UPDATED_AT };

  it("on a 409 to the request, says the page was updated, puts the latest page on the screen, and saves on its revision", async () => {
    const server = fakeServer({ proposal: () => json(409, { error: "conflict", page: LATEST }) });
    const editor = await renderPage();
    await askTidy();
    expect(statusText()).toBe(AI_TEXT.conflict);
    expect(editor.getJSON().content).toEqual(LATEST.blocks);
    expect(container!.querySelector<HTMLTextAreaElement>("textarea.page-title")!.value).toBe(LATEST.title);
    await act(async () => {
      editor.commands.setTextSelection(2);
    });
    await type(editor, "続き");
    await advance(1000);
    expect(server.saves().map((call) => call.body.baseRevision)).toEqual([5]);
  });

  it("on a 409 to the adoption, drops the proposal and puts the latest page on the screen", async () => {
    fakeServer({ adoption: () => json(409, { error: "conflict", page: LATEST }) });
    const editor = await renderPage();
    await askTidy();
    await click(buttonIn(dialog()!, "すべて採用")!);
    await advance(0);
    expect(statusText()).toBe(AI_TEXT.conflict);
    expect(dialog()!.querySelector(".es-prop")).toBeNull();
    expect(editor.getJSON().content).toEqual(LATEST.blocks);
  });

  const ERRORS: Array<{ name: string; respond: () => Response | Promise<Response>; text: string }> = [
    { name: "401", respond: () => json(401, { error: "unauthorized" }), text: AI_ERROR_TEXT.signedOut },
    { name: "429 quota_exceeded", respond: () => json(429, { error: "quota_exceeded" }), text: AI_ERROR_TEXT.quota },
    { name: "502 ai_failed", respond: () => json(502, { error: "ai_failed" }), text: AI_ERROR_TEXT.aiFailed },
    { name: "413 too_large", respond: () => json(413, { error: "too_large" }), text: AI_ERROR_TEXT.tooLarge },
    { name: "400", respond: () => json(400, { error: "bad_request" }), text: AI_ERROR_TEXT.badRequest },
    { name: "500", respond: () => json(500, { error: "internal" }), text: AI_ERROR_TEXT.failed },
    { name: "a malformed 200", respond: () => json(200, { proposal: { label: "整える" } }), text: AI_ERROR_TEXT.failed },
    {
      name: "a network failure",
      respond: () => {
        throw new TypeError("Failed to fetch");
      },
      text: AI_ERROR_TEXT.network,
    },
  ];

  it.each(ERRORS)("says what happened on $name, without the body or internals, and lets the user ask again", async ({ respond, text }) => {
    const server = fakeServer({ proposal: respond });
    const editor = await renderPage();
    const before = JSON.stringify(editor.getJSON());
    await askTidy();
    expect(statusText()).toBe(text);
    expect(preset("整える").disabled).toBe(false);
    expect(input().disabled).toBe(false);
    expect(JSON.stringify(editor.getJSON())).toBe(before);
    expect(server.proposals()).toHaveLength(1);
  });

  it("turns the candidates and the input off with one line on 503 ai_unavailable", async () => {
    const server = fakeServer({ proposal: () => json(503, { error: "ai_unavailable" }) });
    await renderPage();
    await askTidy();
    expect(statusText()).toBe(AI_BLOCKED_TEXT.aiUnavailable);
    expect(preset("整える").disabled).toBe(true);
    expect(input().disabled).toBe(true);
    await click(preset("要約"));
    expect(server.proposals()).toHaveLength(1);
  });

  it("keeps the proposal for another try when the adoption fails, and drops it when the server refuses it (400)", async () => {
    let status = 502;
    const server = fakeServer({ adoption: () => json(status, { error: status === 400 ? "bad_request" : "ai_failed" }) });
    await renderPage();
    await askTidy();
    await click(buttonIn(proposalBlocks()[1]!, "採用")!);
    await click(adoptButton());
    await advance(0);
    expect(statusText()).toBe(AI_ERROR_TEXT.aiFailed);
    expect(adoptButton().disabled).toBe(false);
    status = 400;
    await click(adoptButton());
    await advance(0);
    expect(statusText()).toBe(AI_ADOPT_REFUSED_TEXT);
    expect(dialog()!.querySelector(".es-prop")).toBeNull();
    expect(server.adoptions()).toHaveLength(2);
  });
});

describe("the AI box: when it cannot ask", () => {
  it("cannot ask on a new page that is not created yet", async () => {
    const server = fakeServer();
    await renderPage({ id: null, revision: null, updatedAt: undefined, blocks: [] });
    await openBox();
    expect(statusText()).toBe(AI_BLOCKED_TEXT.new);
    expect(preset("整える").disabled).toBe(true);
    expect(input().disabled).toBe(true);
    await click(preset("整える"));
    expect(server.calls).toEqual([]);
  });

  const STATES: Array<{ name: string; save: Handler; text: string }> = [
    { name: "a conflict (409)", save: () => json(409, { error: "conflict", page: { id: PAGE_ID, title: "別", blocks: [p("別の本文")], revision: 3, updatedAt: UPDATED_AT } }), text: AI_BLOCKED_TEXT.conflict },
    {
      name: "offline",
      save: () => {
        throw new TypeError("Failed to fetch");
      },
      text: AI_BLOCKED_TEXT.offline,
    },
    { name: "a server error", save: () => json(500, { error: "internal" }), text: AI_BLOCKED_TEXT.error },
    { name: "a sign-out (401)", save: () => json(401, { error: "unauthorized" }), text: AI_BLOCKED_TEXT.signedOut },
  ];

  it.each(STATES)("cannot ask while the save is in $name, and says why in one line", async ({ save, text }) => {
    const server = fakeServer({ save });
    const editor = await renderPage();
    await act(async () => {
      editor.commands.setTextSelection(2);
    });
    await type(editor, "未保存");
    await advance(1000);
    await openBox();
    expect(statusText()).toBe(text);
    expect(preset("整える").disabled).toBe(true);
    expect(input().disabled).toBe(true);
    expect(server.proposals()).toEqual([]);
  });
});

describe("the AI box: the conversation of the page", () => {
  it("shows the saved conversation when the box opens, with the version an adoption left behind", async () => {
    const server = fakeServer({ chats: savedChat() });
    await renderPage();
    await openBox();
    await advance(0);
    expect(threadLines()).toEqual([
      ["me", "整える"],
      ["ai", `提案が 3 件あります${aiAdoptedText(4)}`],
    ]);
    // 読むのは一覧と、その最後の会話だけ
    expect(server.chats().map((call) => call.url.replace(`/api/pages/${PAGE_ID}`, ""))).toEqual([
      "/ai/conversations",
      `/ai/conversations/${CONVERSATION_ID}`,
    ]);
    expect(thread()!.getAttribute("aria-label")).toBe("AI との会話");
  });

  it("continues the same conversation and adds both the ask and the result to it", async () => {
    const server = fakeServer({ chats: savedChat() });
    await renderPage();
    await openBox();
    await advance(0);
    await click(preset("整える"));
    await advance(0);
    expect(server.proposals()[0]!.body.conversationId).toBe(CONVERSATION_ID);
    expect(threadLines()).toEqual([
      ["me", "整える"],
      ["ai", `提案が 3 件あります${aiAdoptedText(4)}`],
      ["me", "整える"],
      ["ai", "提案が 3 件あります"],
    ]);

    // 自由入力（チャット）も同じ会話に続く（提案を閉じると候補と入力欄に戻る）
    await click(buttonIn(dialog()!.querySelector(".es-prop")!, "閉じる")!);
    setInputValue(input(), "です・ます調にする");
    await press(input(), "Enter");
    await advance(0);
    expect(server.turns()[0]!.body.conversationId).toBe(CONVERSATION_ID);
    expect(threadLines().slice(-2)[0]).toEqual(["me", "です・ます調にする"]);
    expect(String(threadLines().slice(-1)[0]![1])).toContain("二段落目を短くしました。");
  });

  it("starts a new conversation on 新しい会話にする (the saved one stays on the server)", async () => {
    const server = fakeServer({ chats: savedChat() });
    await renderPage();
    await openBox();
    await advance(0);
    await click(buttonIn(dialog()!, AI_TEXT.fresh)!);
    expect(thread()).toBeNull();
    await click(preset("整える"));
    await advance(0);
    // 会話を指さずに頼む（サーバーが新しい会話を始める）
    expect(server.proposals()[0]!.body.conversationId).toBeUndefined();
    expect(threadLines()).toEqual([
      ["me", "整える"],
      ["ai", "提案が 3 件あります"],
    ]);
  });

  it("asks and shows the result even when the history cannot be read", async () => {
    const server = fakeServer({ chats: { conversations: [{ id: "missing", updatedAt: UPDATED_AT, messages: 2, lastText: null }], messages: {} } });
    await renderPage();
    await openBox();
    await advance(0);
    // 履歴が読めないことは出さない（頼めるので）
    expect(thread()).toBeNull();
    expect(statusText()).toBe("");
    await click(preset("整える"));
    await advance(0);
    expect(proposalBlocks()).toHaveLength(3);
    expect(server.proposals()[0]!.body.conversationId).toBeUndefined();
  });

  it("keeps the conversation when the server could not save the turn (no conversation in the answer)", async () => {
    const server = fakeServer({
      proposal: (body) => json(200, { proposal: { ...PROPOSAL, baseRevision: body.baseRevision }, usage: USAGE, conversation: null }),
    });
    await renderPage();
    await openBox();
    await click(preset("整える"));
    await advance(0);
    // 画面の会話には残る（提案は使える）。採用は会話に繋がない
    expect(threadLines()).toEqual([
      ["me", "整える"],
      ["ai", "提案が 3 件あります"],
    ]);
    await click(buttonIn(dialog()!, "すべて採用")!);
    await advance(0);
    expect(server.adoptions()[0]!.body.messageId).toBeUndefined();
    expect(notice()).toBe(AI_TEXT.done);
  });

  it("does not send on the Enter that confirms Japanese input (IME), in the conversation too", async () => {
    const server = fakeServer({ chats: savedChat() });
    await renderPage();
    await openBox();
    await advance(0);
    setInputValue(input(), "日本語の変換中");
    await press(input(), "Enter", { keyCode: 229 });
    await press(input(), "Enter", { isComposing: true } as KeyboardEventInit);
    expect(server.turns()).toEqual([]);
    expect(threadLines()).toHaveLength(2);
    // 変換が終わった Enter では送る
    await press(input(), "Enter");
    await advance(0);
    expect(server.turns()).toHaveLength(1);
  });
});

describe("the AI box: the chat edits the page itself", () => {
  const chatLine = () => String(threadLines().at(-1)?.[1] ?? "");
  const undoButton = () => buttonIn(dialog()!.querySelector("[data-ai-changes]")!, "元に戻す");

  async function sendChat(text = "二段落目を短くして") {
    await openBox();
    await advance(0);
    setInputValue(input(), text);
    await press(input(), "Enter");
    await advance(0);
  }

  it("saves the unsaved text first, then puts the body the AI wrote into the editor without an autosave", async () => {
    const server = fakeServer();
    const onSaved = vi.fn();
    const editor = await renderPage({}, { onSaved });
    await type(editor, "書きかけ");
    await sendChat();

    // 頼む前に保存し終える（AI は保存された本文を読む）
    expect(server.saves()).toHaveLength(1);
    expect(server.turns()).toHaveLength(1);
    // AI が書いた本文がそのまま画面に載る（採用のボタンは無い）
    expect(editor.getJSON().content).toEqual(CHAT_WRITTEN);
    expect(dialog()!.querySelector(".es-prop")).toBeNull();
    // 載せ替えは自動保存を起こさない
    await advance(2000);
    expect(server.saves()).toHaveLength(1);
    expect(onSaved).toHaveBeenCalled();
  });

  it("shows the work and the pages the turn changed, with the number of characters", async () => {
    fakeServer();
    await renderPage();
    await sendChat();
    expect(chatLine()).toContain("二段落目を短くしました。");
    const work = [...dialog()!.querySelectorAll("[data-ai-work] li")].map((line) => line.textContent);
    expect(work).toEqual(["合成の題名 を読みました", "合成の題名 を書き換えました"]);
    expect([...dialog()!.querySelectorAll("[data-ai-change]")].map((line) => line.textContent)).toEqual(["合成の題名 を直しました（+3 字）"]);
    expect(undoButton()).toBeDefined();
  });

  it("puts the body back on 元に戻す and says so", async () => {
    const server = fakeServer();
    const editor = await renderPage();
    await sendChat();
    expect(editor.getJSON().content).toEqual(CHAT_WRITTEN);

    await click(undoButton()!);
    await advance(0);
    expect(server.undos()).toHaveLength(1);
    expect(editor.getJSON().content).toEqual(BODY);
    expect(statusText()).toBe(AI_TEXT.undone);
    expect([...dialog()!.querySelectorAll("[data-ai-change]")].map((line) => line.textContent)).toEqual(["合成の題名 を直しました（+3 字）（元に戻しました）"]);
    // 戻したあとは、同じ依頼を二度は戻せない
    expect(undoButton()).toBeUndefined();
  });

  it("keeps a page the person changed afterwards, and says why", async () => {
    const server = fakeServer({ undo: () => json(200, { undone: [], kept: [{ pageId: PAGE_ID, reason: "changed" }], page: null }) });
    const editor = await renderPage();
    await sendChat();
    await click(undoButton()!);
    await advance(0);
    expect(server.undos()).toHaveLength(1);
    expect(statusText()).toBe(AI_TEXT.undoKept);
    // 画面の本文はそのまま（勝手に戻さない）
    expect(editor.getJSON().content).toEqual(CHAT_WRITTEN);
  });

  it("says it was cut off when the turn stopped, and keeps what was written", async () => {
    fakeServer({
      chat: () =>
        json(200, {
          conversation: { id: CONVERSATION_ID, messageId: MESSAGE_ID },
          message: {
            id: MESSAGE_ID,
            seq: 2,
            role: "assistant",
            text: "",
            preset: null,
            proposal: null,
            version: null,
            items: [{ kind: "tool", tool: "write_page", page: "合成の題名", ok: true }],
            result: "stopped",
            resultCode: "quota_exceeded",
            changes: [{ pageId: PAGE_ID, title: "合成の題名", change: "edited", chars: 12, delta: 3, undoneAt: null }],
          },
          page: null,
          usage: { nearLimit: true },
        }),
    });
    await renderPage();
    await sendChat();
    expect(statusText()).toBe(AI_TEXT.stopped);
    // 上限に近い一言も出る
    expect(dialog()!.querySelector("[data-ai-near-limit]")?.textContent).toBe(AI_TEXT.nearLimit);
    // 書いた分は会話に残り、元に戻せる
    expect(undoButton()).toBeDefined();
  });

  it("says what happened when the chat fails, without the body or internals, and lets the user ask again", async () => {
    const server = fakeServer({ chat: () => json(502, { error: "ai_failed" }) });
    const editor = await renderPage();
    const before = JSON.stringify(editor.getJSON());
    await sendChat();
    expect(statusText()).toBe(AI_ERROR_TEXT.aiFailed);
    expect(JSON.stringify(editor.getJSON())).toBe(before);
    expect(input().disabled).toBe(false);
    expect(server.turns()).toHaveLength(1);
  });

  it("stops the candidates and the input on 503 ai_unavailable from the chat", async () => {
    fakeServer({ chat: () => json(503, { error: "ai_unavailable" }) });
    await renderPage();
    await sendChat();
    expect(statusText()).toBe(AI_BLOCKED_TEXT.aiUnavailable);
    expect(input().disabled).toBe(true);
    expect(preset("整える").disabled).toBe(true);
  });

  it("says the month's limit was reached without touching the page", async () => {
    const server = fakeServer({ chat: () => json(429, { error: "quota_exceeded" }) });
    const editor = await renderPage();
    const before = JSON.stringify(editor.getJSON());
    await sendChat();
    expect(statusText()).toBe(AI_ERROR_TEXT.quota);
    expect(JSON.stringify(editor.getJSON())).toBe(before);
    expect(server.turns()).toHaveLength(1);
  });
});

describe("the AI box: Mac CLI subscription", () => {
  async function sendNativeChat(text: string) {
    await openBox();
    await advance(0);
    setInputValue(input(), text);
    await press(input(), "Enter");
    await advance(0);
  }

  it("records a native Done through device turns and keeps undo available", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const aiTurn = vi.fn().mockResolvedValue({
      finalEvent: { type: "Done", text: "短くしました", stop_reason: "EndTurn", session_id: "local-only",
        usage: { input_tokens: 1, output_tokens: 1, cost_usd: null, model_used: null, cost_known: false }, duration_ms: 1, continuations: 0 },
      page: { pageId: PAGE_ID, markdown: "変更後" }, pageRemoved: false, extraFiles: 0,
    });
    nativeMock.shell = {
      aiEngines: vi.fn().mockResolvedValue([{ engine: "cli:codex", installed: true, authenticated: true, reason: null, models: ["gpt-6"], effort: true, resume: true }]),
      aiTurn, aiStop: vi.fn().mockResolvedValue(true),
    };
    const server = fakeServer({ deviceTurn: (body) => {
      expect(body).toMatchObject({ engine: "cli:codex", input: "短くして", reply: "短くしました",
        writes: [{ pageId: PAGE_ID, markdown: "変更後", baseRevision: 1 }] });
      expect(body).not.toHaveProperty("resumeSession");
      return json(200, {
        conversation: { id: CONVERSATION_ID, messageId: MESSAGE_ID },
        message: { id: MESSAGE_ID, text: "短くしました", result: "done", resultCode: null,
          items: [{ kind: "tool", tool: "write_page", page: "合成の題名", ok: true }],
          changes: [{ pageId: PAGE_ID, title: "合成の題名", change: "edited", chars: 3, delta: -1, undoneAt: null }] },
        page: { id: PAGE_ID, title: "合成の題名", blocks: CHAT_WRITTEN, revision: 2, updatedAt: UPDATED_AT },
        usage: { nearLimit: false },
      });
    } });
    const editor = await renderPage();
    await openBox();
    await advance(0);
    expect((dialog()!.querySelector("#mac-ai-route") as HTMLSelectElement).value).toBe("cli:codex");
    setInputValue(input(), "短くして");
    await press(input(), "Enter");
    await advance(0);
    expect(aiTurn).toHaveBeenCalledTimes(1);
    expect(server.deviceTurns()).toHaveLength(1);
    expect(server.turns()).toHaveLength(0);
    expect(editor.getJSON().content).toEqual(CHAT_WRITTEN);
    expect(buttonIn(dialog()!.querySelector("[data-ai-changes]")!, "元に戻す")).toBeDefined();
  });

  it("keeps a recorded refusal visible instead of dropping the CLI turn", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    nativeMock.shell = {
      aiEngines: vi.fn().mockResolvedValue([{ engine: "cli:codex", installed: true, authenticated: true, reason: null, models: ["gpt-6"], effort: true, resume: true }]),
      aiTurn: vi.fn().mockResolvedValue({ finalEvent: { type: "Done", text: "直しました", stop_reason: "EndTurn", session_id: "local-only",
        usage: { input_tokens: 1, output_tokens: 1, cost_usd: null, model_used: null, cost_known: false }, duration_ms: 1, continuations: 0 },
        page: { pageId: PAGE_ID, markdown: "変更後" }, pageRemoved: false, extraFiles: 0 }),
      aiStop: vi.fn().mockResolvedValue(true),
    };
    const server = fakeServer({ deviceTurn: () => json(200, {
      conversation: { id: CONVERSATION_ID, messageId: MESSAGE_ID },
      message: { id: MESSAGE_ID, text: "直しました", result: "stopped", resultCode: "revision_conflict", items: [], changes: [] },
      page: null,
    }) });
    await renderPage();
    await sendNativeChat("短くして");
    expect(server.deviceTurns()).toHaveLength(1);
    expect(server.turns()).toHaveLength(0);
    expect(dialog()!.querySelector("[data-ai-thread]")!.textContent).toContain("直しました");
    expect(statusText()).toBe(AI_TEXT.conflict);
    expect(dialog()!.querySelector("[data-ai-changes]")).toBeNull();
  });

  it("refreshes a saved page if conversation history could not be recorded", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    nativeMock.shell = {
      aiEngines: vi.fn().mockResolvedValue([{ engine: "cli:codex", installed: true, authenticated: true, reason: null, models: ["gpt-6"], effort: true, resume: true }]),
      aiTurn: vi.fn().mockResolvedValue({ finalEvent: { type: "Done", text: "直しました", stop_reason: "EndTurn", session_id: "local-only",
        usage: { input_tokens: 1, output_tokens: 1, cost_usd: null, model_used: null, cost_known: false }, duration_ms: 1, continuations: 0 },
        page: { pageId: PAGE_ID, markdown: "変更後" }, pageRemoved: false, extraFiles: 0 }),
      aiStop: vi.fn().mockResolvedValue(true),
    };
    const server = fakeServer({ deviceTurn: () => json(200, {
      conversation: null,
      message: null,
      page: { id: PAGE_ID, title: "合成の題名", blocks: CHAT_WRITTEN, revision: 2, updatedAt: UPDATED_AT },
    }) });
    const editor = await renderPage();
    await sendNativeChat("短くして");
    expect(server.deviceTurns()).toHaveLength(1);
    expect(editor.getJSON().content).toEqual(CHAT_WRITTEN);
    expect(statusText()).toBe(AI_TEXT.nativeHistoryMissing);
  });

  it("allows an explicit server AI choice when CLI discovery fails", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    nativeMock.shell = { aiEngines: vi.fn().mockRejectedValue(new Error("synthetic bridge failure")) };
    const server = fakeServer();
    await renderPage();
    await openBox();
    await advance(0);
    const route = dialog()!.querySelector<HTMLSelectElement>("#mac-ai-route")!;
    expect(route.disabled).toBe(false);
    await act(async () => {
      route.value = "server";
      route.dispatchEvent(new Event("change", { bubbles: true }));
    });
    setInputValue(input(), "短くして");
    await press(input(), "Enter");
    expect(server.turns()).toHaveLength(1);
    expect(server.deviceTurns()).toHaveLength(0);
  });
});
