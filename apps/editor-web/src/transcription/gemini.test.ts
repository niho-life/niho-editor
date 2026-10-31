import { describe, expect, it, vi } from "vitest";
import { EngineError } from "./engine";
import { GEMINI_API_BASE, createGeminiEngine, geminiReplyText, parseGeminiTranscript } from "./gemini";

// 鍵は明らかなダミーだけ。音声は数バイト、返事は合成の文字起こし
const KEY = "test-key-not-secret";
const FILE = "files/abc123";
const UPLOAD_URL = `${GEMINI_API_BASE}/upload/v1beta/files?upload_id=u1`;
const FILE_URI = `${GEMINI_API_BASE}/v1beta/files/abc123`;
const REPLY = ["[00:00] 話者0: はじめます", "", "[00:04] 話者1: よろしくお願いします", "", "[01:05] 話者0: 本題です"].join("\n");

function audio(bytes = [1, 2, 3]) {
  return {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
    contentType: "audio/mp4",
    sizeBytes: bytes.length,
  };
}

const input = (extra: { diarize?: boolean; terms?: string[] } = {}) => ({
  audio: audio(),
  language: "ja" as const,
  diarize: extra.diarize ?? true,
  terms: extra.terms ?? ["合成語"],
  signal: new AbortController().signal,
});

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** Gemini の偽物（開始 → 本体 → 状態 → 返事 → 削除）。 */
function fakeGemini(options: { state?: string[]; reply?: unknown; replyStatus?: number; uploadStatus?: number } = {}) {
  const calls: Call[] = [];
  const states = [...(options.state ?? ["ACTIVE"])];
  const fetchMock = vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
    const url = String(resource);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    else if (body instanceof ReadableStream) body = "stream";
    calls.push({ url, method, headers, body });
    if (url === `${GEMINI_API_BASE}/upload/v1beta/files` && method === "POST") {
      return new Response(null, { status: 200, headers: { "x-goog-upload-url": UPLOAD_URL } });
    }
    if (url === UPLOAD_URL) {
      if (options.uploadStatus) return json(options.uploadStatus, { error: {} });
      return json(200, { file: { name: FILE, uri: FILE_URI, state: states[0] ?? "ACTIVE" } });
    }
    if (url === `${GEMINI_API_BASE}/v1beta/${FILE}` && method === "GET") {
      states.shift();
      return json(200, { name: FILE, uri: FILE_URI, state: states[0] ?? "ACTIVE" });
    }
    if (url.includes(":generateContent")) {
      if (options.replyStatus) return json(options.replyStatus, { error: {} });
      return json(200, options.reply ?? { candidates: [{ content: { parts: [{ text: REPLY }] } }] });
    }
    if (url === `${GEMINI_API_BASE}/v1beta/${FILE}` && method === "DELETE") return new Response(null, { status: 200 });
    throw new Error(`unexpected ${method} ${url}`);
  });
  const engine = createGeminiEngine({
    apiKey: () => KEY,
    model: "gemini-3.8-flash",
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async () => undefined,
  });
  return { engine, calls, fetchMock };
}

describe("parseGeminiTranscript（返事 → 段落）", () => {
  it("[mm:ss] 話者N: 本文 を段落にし、終わりは次の段落の始まりにする", () => {
    const result = parseGeminiTranscript(REPLY, { diarize: true, language: "ja" });
    expect(result.segments).toEqual([
      { start: 0, end: 4, text: "はじめます", speaker: 1 },
      { start: 4, end: 65, text: "よろしくお願いします", speaker: 2 },
      // 最後の段落は終わりが始まりと同じ（返事に終わりの時刻が無い）
      { start: 65, end: 65, text: "本題です", speaker: 1 },
    ]);
    expect(result.durationSec).toBe(65);
  });

  it("話者を分けないときはラベルを外す", () => {
    const result = parseGeminiTranscript("[00:00] こんにちは\n\n[00:03] どうも", { diarize: false, language: "ja" });
    expect(result.segments.map((segment) => segment.speaker)).toEqual([null, null]);
  });

  it("時刻が戻る返事でも、段落の時刻は戻さない", () => {
    const result = parseGeminiTranscript("[00:10] あと\n\n[00:05] まえ", { diarize: false, language: "ja" });
    expect(result.segments.map((segment) => segment.start)).toEqual([10, 10]);
  });

  it("段落が取れない返事は bad_response", () => {
    for (const text of ["", "   ", "```\n```"]) {
      expect(() => parseGeminiTranscript(text, { diarize: true, language: "ja" })).toThrow(EngineError);
    }
  });

  it("返事の本文は候補の text をつなぐ（考えている途中の文は入れない）", () => {
    expect(geminiReplyText({ candidates: [{ content: { parts: [{ text: "あ" }, { text: "い", thought: true }, { text: "う" }] } }] })).toBe("あう");
    for (const value of [null, {}, { candidates: [] }, { candidates: [{ content: { parts: [] } }] }, { candidates: [{ content: { parts: [{ text: " " }] } }] }]) {
      expect(() => geminiReplyText(value)).toThrow(EngineError);
    }
  });
});

describe("createGeminiEngine", () => {
  it("音声を上げてから、指示文と一緒に渡し、終わったら消す（鍵は header だけ）", async () => {
    const { engine, calls } = fakeGemini();
    const result = await engine.transcribe(input());
    expect(result.segments).toHaveLength(3);
    expect(engine.name).toBe("gemini");

    // 1. 開始（大きさと種類を header で申告。鍵は x-goog-api-key）
    expect(calls[0]!.url).toBe(`${GEMINI_API_BASE}/upload/v1beta/files`);
    expect(calls[0]!.headers["X-Goog-Upload-Header-Content-Length"]).toBe("3");
    expect(calls[0]!.headers["X-Goog-Upload-Header-Content-Type"]).toBe("audio/mp4");
    expect(calls[0]!.headers["x-goog-api-key"]).toBe(KEY);
    // 2. 本体（stream をそのまま流す。鍵は付けない）
    expect(calls[1]!.url).toBe(UPLOAD_URL);
    expect(calls[1]!.headers["X-Goog-Upload-Command"]).toBe("upload, finalize");
    expect(calls[1]!.headers["x-goog-api-key"]).toBeUndefined();
    expect(calls[1]!.body).toBe("stream");
    // 3. 返事（指示文は docs-core のもの。音声は fileData で指す）
    const ask = calls.find((call) => call.url.includes(":generateContent"))!;
    expect(ask.url).toBe(`${GEMINI_API_BASE}/v1beta/models/gemini-3.8-flash:generateContent`);
    const parts = (ask.body as { contents: { parts: { text?: string; fileData?: { fileUri: string } }[] }[] }).contents[0]!.parts;
    expect(parts[0]!.text).toContain("話された内容を省略・要約・言い換えしないでください");
    expect(parts[0]!.text).toContain("合成語");
    expect(parts[1]!.fileData).toEqual({ mimeType: "audio/mp4", fileUri: FILE_URI });
    // 4. 後片付け（Gemini 側に音声を残さない）
    expect(calls.at(-1)).toMatchObject({ url: `${GEMINI_API_BASE}/v1beta/${FILE}`, method: "DELETE" });
    // URL に鍵を入れない
    expect(calls.every((call) => !call.url.includes(KEY))).toBe(true);
  });

  it("使えるようになるまで待つ（PROCESSING → ACTIVE）", async () => {
    const { engine, calls } = fakeGemini({ state: ["PROCESSING", "PROCESSING", "ACTIVE"] });
    await engine.transcribe(input());
    expect(calls.filter((call) => call.method === "GET" && call.url.endsWith(FILE))).toHaveLength(2);
  });

  it("上げられなかった音声は FAILED で断り、消してから返す", async () => {
    const { engine, calls } = fakeGemini({ state: ["PROCESSING", "FAILED"] });
    await expect(engine.transcribe(input())).rejects.toMatchObject({ code: "rejected" });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  it("失敗の状態を短い code に写す（本文は読まない）", async () => {
    for (const [status, code] of [
      [400, "rejected"],
      [413, "rejected"],
      [429, "unavailable"],
      [500, "unavailable"],
      [408, "timeout"],
    ] as const) {
      const { engine } = fakeGemini({ replyStatus: status });
      await expect(engine.transcribe(input())).rejects.toMatchObject({ code });
    }
    const { engine } = fakeGemini({ uploadStatus: 401 });
    await expect(engine.transcribe(input())).rejects.toMatchObject({ code: "unavailable" });
  });

  it("上げ先の URL が Gemini の外なら送らない", async () => {
    const fetchMock = vi.fn(async (resource: RequestInfo | URL) => {
      const url = String(resource);
      if (url === `${GEMINI_API_BASE}/upload/v1beta/files`) {
        return new Response(null, { status: 200, headers: { "x-goog-upload-url": "https://evil.test/upload" } });
      }
      throw new Error(`must not call ${url}`);
    });
    const engine = createGeminiEngine({ apiKey: () => KEY, model: "gemini-3.8-flash", fetch: fetchMock as unknown as typeof fetch, sleep: async () => undefined });
    await expect(engine.transcribe(input())).rejects.toMatchObject({ code: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("鍵の形が不正なら、何も送らずに unavailable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const engine = createGeminiEngine({ apiKey: () => "鍵 に 空白", model: "gemini-3.8-flash", fetch: fetchMock as unknown as typeof fetch });
    await expect(engine.transcribe(input())).rejects.toMatchObject({ code: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
