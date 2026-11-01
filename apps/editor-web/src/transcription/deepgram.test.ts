import { afterEach, describe, expect, it, vi } from "vitest";
import { DEEPGRAM_RESPONSE_MAX_BYTES, createDeepgramEngine, deepgramListenUrl, parseDeepgramResponse } from "./deepgram";
import { EngineError, type EngineInput } from "./engine";

// 値は明らかなダミーだけ（実際の鍵・音声・会話ではない）
const KEY = "test-key-not-secret";
const AUDIO = new Uint8Array([9, 8, 7, 6]);

type Call = { url: string; init: RequestInit & { duplex?: string } };

function fakeFetch(...responses: Array<Response | Error | ((call: Call) => Response | Promise<Response>)>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: (init ?? {}) as Call["init"] };
    calls.push(call);
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(call) : next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function audioStream(bytes: Uint8Array = AUDIO): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function input(extra: Partial<EngineInput> = {}): EngineInput {
  return {
    audio: { stream: audioStream(), contentType: "audio/mp4", sizeBytes: AUDIO.byteLength },
    language: "ja",
    diarize: true,
    terms: [],
    signal: new AbortController().signal,
    ...extra,
  };
}

const okBody = {
  metadata: { duration: 12.5, request_id: "synthetic-request" },
  results: {
    channels: [{ alternatives: [{ transcript: "合成の全文" }] }],
    utterances: [
      { start: 0.5, end: 3, speaker: 0, transcript: "合成の一つ目です。" },
      { start: 3.2, end: 4, speaker: 1, transcript: " " },
      { start: 4.1, end: 9, speaker: 1, transcript: "合成の二つ目です。" },
      { start: 9.5, end: 10, transcript: "話者なし" },
    ],
  },
};

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

/** エラーの見える部分（メッセージ・文字列・JSON・stack）に鍵・URL・本文が入っていないこと。 */
function expectNoSecrets(error: unknown, extra: string[] = []) {
  expect(error).toBeInstanceOf(EngineError);
  const visible = [String(error), (error as Error).message, JSON.stringify(error), (error as Error).stack ?? "", JSON.stringify(Object.entries(error as object))].join("\n");
  for (const secret of [KEY, "api.deepgram.com", "listen", "合成", ...extra]) expect(visible).not.toContain(secret);
}

async function failureOf(promise: Promise<unknown>, extra: string[] = []): Promise<EngineError> {
  try {
    await promise;
  } catch (error) {
    expectNoSecrets(error, extra);
    return error as EngineError;
  }
  throw new Error("expected a failure");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deepgramListenUrl", () => {
  it("copies the settings of the Mac app and repeats the keyterms within the budget", () => {
    const url = new URL(deepgramListenUrl({ language: "ja", diarize: true, terms: ["合成鎌倉", "合成浜", "合成鎌倉", ""] }));
    expect(`${url.origin}${url.pathname}`).toBe("https://api.deepgram.com/v1/listen");
    const get = (key: string) => url.searchParams.getAll(key);
    expect(get("model")).toEqual(["nova-3"]);
    expect(get("language")).toEqual(["ja"]);
    expect(get("smart_format")).toEqual(["false"]);
    expect(get("punctuate")).toEqual(["true"]);
    expect(get("diarize")).toEqual([]);
    expect(get("diarize_model")).toEqual(["latest"]);
    expect(get("utterances")).toEqual(["true"]);
    expect(get("paragraphs")).toEqual(["false"]);
    expect(get("keyterm")).toEqual(["合成鎌倉", "合成浜"]);
    expect(get("callback")).toEqual([]);
    expect(url.search).not.toContain(KEY);

    const solo = new URL(deepgramListenUrl({ language: "en", diarize: false, terms: [] }));
    expect(solo.searchParams.get("language")).toBe("en");
    expect(solo.searchParams.has("diarize")).toBe(false);
    expect(solo.searchParams.has("diarize_model")).toBe(false);
    expect(solo.searchParams.has("keyterm")).toBe(false);

    // 500 バイトの予算（docs-core の deepgramKeyterms）を超える分は渡さない
    const many = Array.from({ length: 100 }, (_, index) => `合成の固有名詞${index}`);
    const budgeted = new URL(deepgramListenUrl({ language: "ja", diarize: true, terms: many })).searchParams.getAll("keyterm");
    expect(budgeted.length).toBeGreaterThan(0);
    expect(budgeted.length).toBeLessThan(many.length);
    expect(budgeted.reduce((sum, term) => sum + new TextEncoder().encode(term).byteLength, 0)).toBeLessThanOrEqual(500);
  });
});

describe("Deepgram engine", () => {
  it("POSTs the audio stream as it is with the token, the content type, the length and duplex: half, and reads the utterances", async () => {
    const { fetch, calls } = fakeFetch(json(okBody));
    const stream = audioStream();
    const engine = createDeepgramEngine({ apiKey: () => KEY, fetch });
    expect(engine.name).toBe("deepgram");
    const result = await engine.transcribe(input({ audio: { stream, contentType: "audio/mp4", sizeBytes: 4 }, terms: ["合成語"] }));
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(new URL(call.url).searchParams.getAll("keyterm")).toEqual(["合成語"]);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toEqual({ Authorization: `Token ${KEY}`, "Content-Type": "audio/mp4", "Content-Length": "4" });
    expect(call.init.body).toBe(stream);
    expect(call.init.duplex).toBe("half");
    expect(call.init.redirect).toBe("error");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      durationSec: 12.5,
      segments: [
        { start: 0.5, end: 3, speaker: 0, text: "合成の一つ目です。" },
        { start: 3.2, end: 4, speaker: 1, text: " " },
        { start: 4.1, end: 9, speaker: 1, text: "合成の二つ目です。" },
        { start: 9.5, end: 10, speaker: null, text: "話者なし" },
      ],
    });
  });

  it("reads the key every time and refuses a missing or malformed key before sending anything", async () => {
    let key = KEY;
    const { fetch, calls } = fakeFetch(json(okBody), json(okBody));
    const engine = createDeepgramEngine({ apiKey: () => key, fetch });
    await engine.transcribe(input());
    key = "test-key-rotated";
    await engine.transcribe(input());
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Token test-key-rotated");
    for (const bad of ["", "has space", "line\nbreak"]) {
      key = bad;
      expect((await failureOf(engine.transcribe(input()))).code).toBe("unavailable");
    }
    const throwing = createDeepgramEngine({
      apiKey: () => {
        throw new Error(KEY);
      },
      fetch,
    });
    expect((await failureOf(throwing.transcribe(input()))).code).toBe("unavailable");
    expect(calls).toHaveLength(2);
  });

  it("maps HTTP failures without reading or exposing the body", async () => {
    const cases: Array<[number, string]> = [
      [400, "rejected"],
      [413, "rejected"],
      [415, "rejected"],
      [422, "rejected"],
      [401, "unavailable"],
      [402, "unavailable"],
      [403, "unavailable"],
      [429, "unavailable"],
      [500, "unavailable"],
      [503, "unavailable"],
      [408, "timeout"],
    ];
    for (const [status, code] of cases) {
      const body = `failure echoing ${KEY} and https://api.deepgram.com/v1/listen and 合成の音声`;
      const engine = createDeepgramEngine({ apiKey: () => KEY, fetch: fakeFetch(new Response(body, { status })).fetch });
      expect((await failureOf(engine.transcribe(input()))).code, String(status)).toBe(code);
    }
  });

  it("maps network failures to unavailable and an abort or its own timeout to timeout", async () => {
    const network = createDeepgramEngine({ apiKey: () => KEY, fetch: fakeFetch(new TypeError(`fetch failed ${KEY} https://api.deepgram.com/v1/listen`)).fetch });
    expect((await failureOf(network.transcribe(input()))).code).toBe("unavailable");

    const hanging = (call: Call) =>
      new Promise<Response>((_, reject) => {
        call.init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const own = createDeepgramEngine({ apiKey: () => KEY, fetch: fakeFetch(hanging).fetch, timeoutMs: 20 });
    expect((await failureOf(own.transcribe(input()))).code).toBe("timeout");

    const controller = new AbortController();
    const caller = createDeepgramEngine({ apiKey: () => KEY, fetch: fakeFetch(hanging).fetch });
    const pending = caller.transcribe(input({ signal: controller.signal }));
    controller.abort();
    expect((await failureOf(pending)).code).toBe("timeout");
  });

  it("answers bad_response for JSON it cannot read, and missing or empty utterances", async () => {
    for (const response of [
      new Response("not json", { status: 200 }),
      new Response(new Uint8Array([0xff, 0xfe]), { status: 200 }),
      json({ results: { channels: [{ alternatives: [{ transcript: "合成の全文" }] }] } }),
      json({ results: { utterances: [] } }),
      json({ results: { utterances: [{ start: 0, end: 1, speaker: 0 }] } }),
      json({ results: { utterances: "nope" } }),
      json([]),
    ]) {
      const engine = createDeepgramEngine({ apiKey: () => KEY, fetch: fakeFetch(response).fetch });
      expect((await failureOf(engine.transcribe(input()))).code).toBe("bad_response");
    }
  });

  it("stops reading a response over 64 MiB as too_large", async () => {
    const declared = createDeepgramEngine({
      apiKey: () => KEY,
      fetch: fakeFetch(new Response("{}", { status: 200, headers: { "content-length": String(DEEPGRAM_RESPONSE_MAX_BYTES + 1) } })).fetch,
    });
    expect((await failureOf(declared.transcribe(input()))).code).toBe("too_large");

    // 長さを申告しない応答も、読みながら上限で止める（1 MiB ずつ 65 回）
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk);
      },
    });
    const streaming = createDeepgramEngine({ apiKey: () => KEY, fetch: fakeFetch(new Response(endless, { status: 200 })).fetch });
    expect((await failureOf(streaming.transcribe(input()))).code).toBe("too_large");
    expect(pulled).toBeLessThan(70);
  });

  it("refuses audio with a malformed type or size before sending", async () => {
    const { fetch, calls } = fakeFetch();
    const engine = createDeepgramEngine({ apiKey: () => KEY, fetch });
    expect((await failureOf(engine.transcribe(input({ audio: { stream: audioStream(), contentType: "audio/mp4\r\nX: y", sizeBytes: 4 } })))).code).toBe("rejected");
    expect((await failureOf(engine.transcribe(input({ audio: { stream: audioStream(), contentType: "audio/mp4", sizeBytes: 0 } })))).code).toBe("rejected");
    expect(calls).toHaveLength(0);
  });

  it("writes nothing to the console", async () => {
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    await createDeepgramEngine({ apiKey: () => KEY, fetch: fakeFetch(json(okBody)).fetch }).transcribe(input());
    await failureOf(createDeepgramEngine({ apiKey: () => KEY, fetch: fakeFetch(new Response("x", { status: 500 })).fetch }).transcribe(input()));
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("parseDeepgramResponse", () => {
  it("keeps Deepgram's speaker numbers, drops malformed utterances and reads a non-negative duration", () => {
    const parsed = parseDeepgramResponse({
      metadata: { duration: -1 },
      results: { utterances: [{ start: "0", end: null, speaker: -1, transcript: "合成" }, { transcript: 3 }, "x", { start: 1, end: 2, speaker: 2.5, transcript: "合成2" }] },
    });
    expect(parsed).toEqual({
      durationSec: null,
      segments: [
        { start: null, end: null, speaker: null, text: "合成" },
        { start: 1, end: 2, speaker: null, text: "合成2" },
      ],
    });
  });
});
