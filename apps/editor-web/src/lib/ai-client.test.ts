import { afterEach, describe, expect, it, vi } from "vitest";
import { AiConflictError, AiRequestError, streamAiChat, type AiChatEvent } from "./ai-client";

const PAGE_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

const DONE = {
  conversation: { id: "conversation-1", messageId: "message-2" },
  message: {
    text: "段落を短くしました。",
    result: "done",
    resultCode: null,
    items: [{ kind: "narration", text: "本文を読みます。" }, { kind: "tool", tool: "read_page", page: "合成ページ", ok: true }],
    changes: [{ pageId: PAGE_ID, title: "合成ページ", change: "edited", version: 4, revision: 7, chars: 120, delta: -18, undoneAt: null }],
  },
  page: null,
  usage: { nearLimit: false },
};

/** SSE の本文を、区切りの途中で切った chunk で流す Response。 */
function sseResponse(chunks: string[], options: { close?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (options.close !== false) controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function stubFetch(response: Response | ((init: RequestInit) => Promise<Response>)) {
  const fetchMock = vi.fn(async (_path: string, init: RequestInit) => (typeof response === "function" ? response(init) : response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamAiChat", () => {
  it("asks for an event stream, passes text and tool events in order, and returns the done body", async () => {
    const body = [sse("text", { text: "本文を" }), ": ping\n\n", sse("text", { text: "読みます。" }), sse("tool", { tool: "read_page", page: null, ok: null, phase: "start" }),
      sse("tool", { tool: "read_page", page: "合成ページ", ok: true, phase: "end" }), sse("done", DONE)].join("");
    // 区切りの途中で切って流す
    const fetchMock = stubFetch(sseResponse([body.slice(0, 13), body.slice(13, 70), body.slice(70)]));
    const events: AiChatEvent[] = [];
    const result = await streamAiChat(PAGE_ID, { text: "短くして", conversationId: "conversation-1" }, { onEvent: (event) => events.push(event) });
    expect(events).toEqual([
      { type: "text", text: "本文を" },
      { type: "text", text: "読みます。" },
      { type: "tool", tool: "read_page", page: null, ok: null, phase: "start" },
      { type: "tool", tool: "read_page", page: "合成ページ", ok: true, phase: "end" },
    ]);
    expect(result.reply).toBe("段落を短くしました。");
    expect(result.changes).toEqual([{ pageId: PAGE_ID, title: "合成ページ", change: "edited", version: 4, revision: 7, chars: 120, delta: -18, undoneAt: null }]);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe(`/api/pages/${PAGE_ID}/ai/chat`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).accept).toBe("text/event-stream");
    expect(JSON.parse(String(init.body))).toEqual({ text: "短くして", conversationId: "conversation-1" });
  });

  it("reads a JSON response the same way as sendAiChat", async () => {
    stubFetch(new Response(JSON.stringify(DONE), { status: 200, headers: { "content-type": "application/json" } }));
    const onEvent = vi.fn();
    const result = await streamAiChat(PAGE_ID, { text: "短くして" }, { onEvent });
    expect(result.result).toBe("done");
    expect(result.items).toHaveLength(2);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("keeps the status handling of sendAiChat (401, 429 quota, 409 conflict)", async () => {
    stubFetch(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } }));
    await expect(streamAiChat(PAGE_ID, { text: "x" }, { onEvent: vi.fn() })).rejects.toMatchObject({ code: "signedOut" });
    stubFetch(new Response(JSON.stringify({ error: "quota_exceeded" }), { status: 429, headers: { "content-type": "application/json" } }));
    await expect(streamAiChat(PAGE_ID, { text: "x" }, { onEvent: vi.fn() })).rejects.toMatchObject({ code: "quota" });
    const page = { id: PAGE_ID, title: "合成ページ", blocks: [], revision: 3, updatedAt: "2026-01-01T00:00:00.000Z" };
    stubFetch(new Response(JSON.stringify({ error: "conflict", page }), { status: 409, headers: { "content-type": "application/json" } }));
    await expect(streamAiChat(PAGE_ID, { text: "x" }, { onEvent: vi.fn() })).rejects.toBeInstanceOf(AiConflictError);
  });

  it("fails on an error event", async () => {
    stubFetch(sseResponse([sse("text", { text: "途中" }), sse("error", { error: "internal" })]));
    const onEvent = vi.fn();
    const error = await streamAiChat(PAGE_ID, { text: "x" }, { onEvent }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiRequestError);
    expect(error).toMatchObject({ code: "failed" });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("fails when the stream ends without done", async () => {
    stubFetch(sseResponse([sse("text", { text: "途中" })]));
    await expect(streamAiChat(PAGE_ID, { text: "x" }, { onEvent: vi.fn() })).rejects.toMatchObject({ code: "failed" });
  });

  it("reports aborted when the request is stopped mid-stream", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    stubFetch(async (init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(encoder.encode(sse("text", { text: "途中" })));
          init.signal?.addEventListener("abort", () => streamController.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const promise = streamAiChat(PAGE_ID, { text: "x" }, { signal: controller.signal, onEvent: () => controller.abort() });
    await expect(promise).rejects.toMatchObject({ code: "aborted" });
  });

  it("reports aborted when fetch itself is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    stubFetch(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    await expect(streamAiChat(PAGE_ID, { text: "x" }, { signal: controller.signal, onEvent: vi.fn() })).rejects.toMatchObject({ code: "aborted" });
  });
});
