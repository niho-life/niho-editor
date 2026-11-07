import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { recordingDataProblem, type Recording } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { VTT_IMPORT_MAX_BYTES } from "../recording/vtt-import";
import {
  VTT_IMPORT_BODY_MAX_BYTES,
  getRecordingRoute,
  importVttRoute,
  readRecordingSeconds,
  type RecordingsApiDeps,
  type RecordingsStore,
} from "./recordings-api";

// 合成の VTT・話者名・ユーザー ID だけを使う

const ORIGIN = "http://editor.test";
const SAMPLE_VTT = [
  "WEBVTT",
  "",
  "00:00:01.000 --> 00:00:02.500",
  "<v 司会役>はじめます",
  "",
  "00:00:02.500 --> 00:00:04.000",
  "<v 記録役>お願いします",
  "",
  "00:00:04.000 --> 00:00:06.000",
  "<v 司会役>一つ目の議題です",
  "",
].join("\n");

type Row = { id: string; owner: string; deleted: boolean; recording: Recording | null };

/** owner ごとに分けた、メモリの中だけの合成の store（packages/editor-store と同じ約束: 自分の・ゴミ箱でない行だけ）。 */
function memoryStore(rows: Row[] = []) {
  const calls: string[] = [];
  const find = (owner: string, id: string) => rows.find((row) => row.id === id && row.owner === owner && !row.deleted && row.recording) ?? null;
  const store: RecordingsStore = {
    createRecordingPage: async (owner, input) => {
      calls.push(`create:${owner}`);
      const problem = recordingDataProblem({ segments: input.segments, speakerNames: input.speakerNames ?? {} });
      if (problem) throw new Error(problem);
      const now = new Date(0).toISOString();
      const recording: Recording = {
        revision: 1,
        source: input.source,
        language: input.lang,
        engine: input.engine ?? null,
        durationSec: input.durationSec ?? null,
        sourceName: input.sourceName ?? null,
        sourceSha256: input.sourceSha256 ?? null,
        audio: null,
        createdAt: now,
        updatedAt: now,
      };
      const id = randomUUID();
      rows.push({ id, owner, deleted: false, recording });
      return { page: { id, kind: "rec", title: input.title ?? "", lang: input.lang, page: null, createdAt: now, updatedAt: now }, recording, transcript: randomUUID() };
    },
    getRecording: async (owner, id) => {
      calls.push(`get:${owner}`);
      return find(owner, id)?.recording ?? null;
    },
  };
  return { store, rows, calls };
}

/** 録音の API が呼ぶのは getSession だけ。ログインの経路（AuthProvider の残り）は使わない。 */
const notUsed = async (): Promise<Response> => {
  throw new Error("the recordings API never calls the login routes");
};

function authAs(userId: string | null): AuthProvider {
  return {
    mode: "stub",
    getSession: async () => (userId ? { userId, mode: "stub" } : null),
    beginLogin: notUsed,
    completeLogin: notUsed,
    logout: notUsed,
  };
}

function deps(userId: string | null, store: RecordingsStore | null, env: Record<string, string | undefined> = {}): RecordingsApiDeps {
  return { auth: () => authAs(userId), store: () => store, env };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const sameOrigin: Record<string, string> = method === "GET" ? {} : { origin: ORIGIN };
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { host: "editor.test", "content-type": "application/json", ...sameOrigin, ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

const importRequest = (body: unknown, headers: Record<string, string> = {}) => request("POST", "/api/recordings/import-vtt", body, headers);
const get = (id: string, d: RecordingsApiDeps) => getRecordingRoute(request("GET", `/api/pages/${id}/recording`), id, d);

async function snapshot(response: Response) {
  return { status: response.status, headers: [...response.headers.entries()].sort(), body: await response.text() };
}

async function imported(store: RecordingsStore, userId = "user-a") {
  const response = await importVttRoute(importRequest({ name: "合成の会議.vtt", vtt: SAMPLE_VTT }), deps(userId, store));
  expect(response.status).toBe(201);
  return (await response.json()) as { page: { id: string }; recording: Recording };
}

describe("POST /api/recordings/import-vtt", () => {
  it("creates a recording page for the signed-in owner and answers 201 with the page, the transcript tab and the recording (no paragraphs)", async () => {
    const { store, rows, calls } = memoryStore();
    const response = await importVttRoute(importRequest({ name: "C:\\fakepath\\合成の会議.vtt", vtt: SAMPLE_VTT, lang: "en" }), deps("user-a", store));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["page", "recording", "transcript"]);
    expect(body.transcript).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.page).toMatchObject({ kind: "rec", title: "合成の会議", lang: "en" });
    expect(Object.keys(body.recording).sort()).toEqual(
      ["audio", "createdAt", "durationSec", "engine", "language", "revision", "source", "sourceName", "sourceSha256", "updatedAt"].sort(),
    );
    expect(body.recording).toMatchObject({ revision: 1, source: "vtt", language: "en", engine: "vtt-import", durationSec: 6, sourceName: "合成の会議.vtt" });
    expect(body.recording.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    // 段落・話者は録音に載らない（文字起こしのタブ `transcript` が持つ。GET /api/pages/{tab}/transcript）
    expect(body.recording).not.toHaveProperty("segments");
    expect(body.recording).not.toHaveProperty("speakerNames");
    expect(body).not.toHaveProperty("speakers");
    expect(rows[0]?.owner).toBe("user-a");
    expect(calls).toEqual(["create:user-a"]);
    // 言語を省くと ja
    const ja = await (await importVttRoute(importRequest({ name: "a.vtt", vtt: SAMPLE_VTT }), deps("user-a", store))).json();
    expect(ja.page.lang).toBe("ja");
  });

  it("answers 401, 403, and 503 before reading the body or touching the store", async () => {
    const { store, calls } = memoryStore();
    expect((await importVttRoute(importRequest({ name: "a.vtt", vtt: SAMPLE_VTT }), deps(null, store))).status).toBe(401);
    expect((await importVttRoute(importRequest({ name: "a.vtt", vtt: SAMPLE_VTT }, { origin: "https://evil.example" }), deps("user-a", store))).status).toBe(403);
    const noOrigin = new Request(`${ORIGIN}/api/recordings/import-vtt`, { method: "POST", headers: { host: "editor.test", "content-type": "application/json" }, body: "{}" });
    expect((await importVttRoute(noOrigin, deps("user-a", store))).status).toBe(403);
    expect((await importVttRoute(importRequest({ name: "a.vtt", vtt: SAMPLE_VTT }), deps("user-a", null))).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("answers 400 with a short reason for bodies and files it cannot take, without creating anything", async () => {
    const { store, calls } = memoryStore();
    const cases: Array<[unknown, string, Record<string, string>?]> = [
      ["{", "body"],
      ["name=a", "body", { "content-type": "text/plain" }],
      [[], "body"],
      [{ name: "a.vtt" }, "body"],
      [{ name: "a.vtt", vtt: 1 }, "body"],
      [{ name: "a.vtt", vtt: SAMPLE_VTT, extra: true }, "body"],
      [{ vtt: SAMPLE_VTT }, "name"],
      [{ name: null, vtt: SAMPLE_VTT }, "name"],
      [{ name: "a\u0000.vtt", vtt: SAMPLE_VTT }, "name"],
      [{ name: "a.vtt", vtt: SAMPLE_VTT, lang: "fr" }, "lang"],
      [{ name: "a.vtt", vtt: SAMPLE_VTT, lang: null }, "lang"],
      [{ name: "a.vtt", vtt: "" }, "vtt_empty"],
      [{ name: "a.vtt", vtt: "WEBVTT\n\nNOTE だけ\n" }, "vtt_empty"],
      [{ name: "a.vtt", vtt: "合成のただの文字" }, "vtt_invalid"],
      [{ name: "a.vtt", vtt: "WEBVTT\n\n00:05.000 --> 00:04.000\n逆転\n" }, "vtt_invalid"],
      [{ name: "a.vtt", vtt: `WEBVTT\n\nNOTE ${"x".repeat(VTT_IMPORT_MAX_BYTES)}\n` }, "vtt_too_large"],
    ];
    for (const [body, reason, headers] of cases) {
      const response = await importVttRoute(importRequest(body, headers), deps("user-a", store));
      expect(response.status, reason).toBe(400);
      expect(await response.text(), reason).toBe(JSON.stringify({ error: "bad_request", reason }));
    }
    expect(calls).toEqual([]);
  });

  it("answers 413 to a body above the import limit, whether or not it says its length", async () => {
    const { store, calls } = memoryStore();
    const big = JSON.stringify({ name: "a.vtt", vtt: `WEBVTT\n\nNOTE ${"x".repeat(VTT_IMPORT_BODY_MAX_BYTES)}\n` });
    expect((await importVttRoute(importRequest(big), deps("user-a", store))).status).toBe(413);
    expect((await importVttRoute(importRequest(big, { "content-length": String(big.length) }), deps("user-a", store))).status).toBe(413);
    expect(await (await importVttRoute(importRequest(big), deps("user-a", store))).text()).toBe('{"error":"payload_too_large"}');
    expect(calls).toEqual([]);
  });

  it("answers 500 without internal details when the store fails", async () => {
    const { store } = memoryStore();
    const failing: RecordingsStore = {
      ...store,
      createRecordingPage: async () => {
        throw Object.assign(new Error(`relation page_recordings violates "secret detail" 司会役`), { code: "23514" });
      },
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await importVttRoute(importRequest({ name: "a.vtt", vtt: SAMPLE_VTT }), deps("user-a", failing));
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"error":"internal"}');
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret detail|司会役|page_recordings/);
      expect(log.mock.calls[0]?.[1]).toEqual({ route: "POST /api/recordings/import-vtt", name: "Error", code: "23514" });
    } finally {
      log.mockRestore();
    }
  });
});

describe("GET /api/pages/{id}/recording", () => {
  it("answers the recording of the owner's page", async () => {
    const { store } = memoryStore();
    const created = await imported(store);
    const response = await get(created.page.id, deps("user-a", store));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["recording"]);
    expect(body.recording).toEqual(created.recording);
  });

  it("returns available transcription engines and only the default provider name", async () => {
    const { store } = memoryStore();
    const created = await imported(store);
    const d: RecordingsApiDeps = {
      ...deps("user-a", store),
      engines: () => ["deepgram", "gemini"],
      defaultEngine: () => "gemini",
    };
    const body = await (await get(created.page.id, d)).json();
    expect(body.engines).toEqual(["deepgram", "gemini"]);
    expect(body.defaultEngine).toBe("gemini");
    expect(JSON.stringify(body)).not.toMatch(/apiKey|secret|gemini-3\./i);
  });

  it("answers 401 and 503 before touching the store", async () => {
    const { store, calls } = memoryStore();
    expect((await get(randomUUID(), deps(null, store))).status).toBe(401);
    expect((await get(randomUUID(), deps("user-a", null))).status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("answers the same 404 (body and headers) for another owner's page, an unknown id, a malformed id, a page in the trash, and a page without a recording", async () => {
    const { store, rows } = memoryStore();
    const theirs = (await imported(store, "user-b")).page.id;
    const trashed = (await imported(store)).page.id;
    rows.find((row) => row.id === trashed)!.deleted = true;
    const plain = randomUUID();
    rows.push({ id: plain, owner: "user-a", deleted: false, recording: null });
    const results = [];
    for (const id of [theirs, trashed, plain, randomUUID(), "not-a-uuid"]) results.push(await snapshot(await get(id, deps("user-a", store))));
    expect(results[0]?.status).toBe(404);
    expect(results[0]?.body).toBe('{"error":"not_found"}');
    for (const result of results.slice(1)) expect(result).toEqual(results[0]);
  });
});

describe("recording data from the API", () => {
  it("passes only the documented recording fields through", async () => {
    const { store, rows } = memoryStore();
    const { page } = await imported(store);
    const row = rows.find((item) => item.id === page.id)!;
    row.recording = { ...row.recording!, extra: "internal", segments: [{ text: "hidden" }] } as unknown as Recording;
    const body = await (await get(page.id, deps("user-a", store))).text();
    expect(body).not.toMatch(/internal|hidden/);
    expect(Object.keys(JSON.parse(body).recording).sort()).toEqual(
      ["audio", "createdAt", "durationSec", "engine", "language", "revision", "source", "sourceName", "sourceSha256", "updatedAt"].sort(),
    );
  });
});

describe("readRecordingSeconds (the 録音 row of the info panel when a page opens)", () => {
  it("reads only the length of the owner's recording, and null when there is none, no length, no DB or a failure", async () => {
    const { store, rows } = memoryStore();
    const { page } = await imported(store);
    // 合成の VTT の最後の段落の終わり（6 秒）
    expect(await readRecordingSeconds(store, "user-a", page.id)).toBe(6);
    // 別の人のページ・録音の無いページ
    expect(await readRecordingSeconds(store, "user-b", page.id)).toBeNull();
    expect(await readRecordingSeconds(store, "user-a", randomUUID())).toBeNull();
    const row = rows.find((item) => item.id === page.id)!;
    for (const durationSec of [null, 0, Number.NaN]) {
      row.recording = { ...row.recording!, durationSec };
      expect(await readRecordingSeconds(store, "user-a", page.id)).toBeNull();
    }
    expect(await readRecordingSeconds(null, "user-a", page.id)).toBeNull();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failing = { getRecording: vi.fn(async () => Promise.reject(new Error("synthetic page_recordings failure 司会役"))) };
      expect(await readRecordingSeconds(failing, "user-a", page.id)).toBeNull();
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/page_recordings|司会役/);
    } finally {
      log.mockRestore();
    }
  });
});
