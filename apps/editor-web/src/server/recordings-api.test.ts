import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { recordingDataProblem, type Recording, type RecordingData } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { VTT_IMPORT_MAX_BYTES } from "../recording/vtt-import";
import {
  RECORDING_PATCH_BODY_MAX_BYTES,
  VTT_IMPORT_BODY_MAX_BYTES,
  getRecordingRoute,
  importVttRoute,
  patchRecordingRoute,
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

/** owner ごとに分けた、メモリの中だけの合成の store（packages/editor-store と同じ約束: 自分の・ゴミ箱でない行だけ、revision を見る）。 */
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
        segments: input.segments,
        speakerNames: input.speakerNames ?? {},
        audio: null,
        createdAt: now,
        updatedAt: now,
      };
      const id = randomUUID();
      rows.push({ id, owner, deleted: false, recording });
      return { page: { id, kind: "rec", title: input.title ?? "", lang: input.lang, createdAt: now, updatedAt: now }, recording };
    },
    getRecording: async (owner, id) => {
      calls.push(`get:${owner}`);
      return find(owner, id)?.recording ?? null;
    },
    updateRecording: async (owner, id, baseRevision, mutate) => {
      calls.push(`update:${owner}`);
      const row = find(owner, id);
      if (!row?.recording) return null;
      if (row.recording.revision !== baseRevision) return { status: "conflict", recording: row.recording };
      // 本物の store と同じく、長さも渡し、書き換えが返したときだけ入れ替える（packages/editor-store の copyData・updateRecording）
      const next = mutate(structuredClone({ segments: row.recording.segments, speakerNames: row.recording.speakerNames, durationSec: row.recording.durationSec }));
      if ("rejected" in next) return { status: "rejected", reason: next.rejected };
      const problem = recordingDataProblem(next);
      if (problem) throw new Error(problem);
      row.recording = {
        ...row.recording,
        segments: next.segments,
        speakerNames: next.speakerNames,
        durationSec: next.durationSec === undefined ? row.recording.durationSec : next.durationSec,
        revision: row.recording.revision + 1,
      };
      return { status: "ok", recording: row.recording };
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
const patch = (id: string, body: unknown, d: RecordingsApiDeps, headers: Record<string, string> = {}) =>
  patchRecordingRoute(request("PATCH", `/api/pages/${id}/recording`, body, headers), id, d);

async function snapshot(response: Response) {
  return { status: response.status, headers: [...response.headers.entries()].sort(), body: await response.text() };
}

async function imported(store: RecordingsStore, userId = "user-a") {
  const response = await importVttRoute(importRequest({ name: "合成の会議.vtt", vtt: SAMPLE_VTT }), deps(userId, store));
  expect(response.status).toBe(201);
  return (await response.json()) as { page: { id: string }; recording: Recording; speakers: unknown };
}

describe("POST /api/recordings/import-vtt", () => {
  it("creates a recording page for the signed-in owner and answers 201 with the page, the recording, and the speakers", async () => {
    const { store, rows, calls } = memoryStore();
    const response = await importVttRoute(importRequest({ name: "C:\\fakepath\\合成の会議.vtt", vtt: SAMPLE_VTT, lang: "en" }), deps("user-a", store));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["page", "recording", "speakers"]);
    expect(body.page).toMatchObject({ kind: "rec", title: "合成の会議", lang: "en" });
    expect(Object.keys(body.recording).sort()).toEqual(
      ["audio", "createdAt", "durationSec", "engine", "language", "revision", "segments", "source", "sourceName", "sourceSha256", "speakerNames", "updatedAt"].sort(),
    );
    expect(body.recording).toMatchObject({ revision: 1, source: "vtt", language: "en", engine: "vtt-import", durationSec: 6, sourceName: "合成の会議.vtt" });
    expect(body.recording.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.recording.segments).toEqual([
      { start: 1, end: 2.5, text: "はじめます", speaker: 1 },
      { start: 2.5, end: 4, text: "お願いします", speaker: 2 },
      { start: 4, end: 6, text: "一つ目の議題です", speaker: 1 },
    ]);
    expect(body.recording.speakerNames).toEqual({ "1": "司会役", "2": "記録役" });
    expect(body.speakers).toEqual([
      { speaker: 1, name: "司会役", count: 2 },
      { speaker: 2, name: "記録役", count: 1 },
    ]);
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
  it("answers the recording and the speakers of the owner's page", async () => {
    const { store } = memoryStore();
    const created = await imported(store);
    const response = await get(created.page.id, deps("user-a", store));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["recording", "speakers"]);
    expect(body.recording).toEqual(created.recording);
    expect(body.speakers).toEqual(created.speakers);
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

describe("PATCH /api/pages/{id}/recording", () => {
  it("edits paragraphs, renames a speaker for every paragraph, and merges speakers, one revision at a time", async () => {
    const { store } = memoryStore();
    const { page } = await imported(store);
    const d = deps("user-a", store);

    const edited = await patch(page.id, { baseRevision: 1, edits: [{ index: 0, text: "はじめます。\r\n直しました" }] }, d);
    expect(edited.status).toBe(200);
    const first = await edited.json();
    expect(first.recording.revision).toBe(2);
    expect(first.recording.segments[0]).toEqual({ start: 1, end: 2.5, text: "はじめます。\n直しました", speaker: 1 });

    const renamed = await (await patch(page.id, { baseRevision: 2, renameSpeaker: { speaker: 1, name: "進行役" } }, d)).json();
    expect(renamed.recording.revision).toBe(3);
    expect(renamed.recording.speakerNames).toEqual({ "1": "進行役", "2": "記録役" });
    expect(renamed.speakers).toEqual([
      { speaker: 1, name: "進行役", count: 2 },
      { speaker: 2, name: "記録役", count: 1 },
    ]);
    // 名前は表に 1 つ: 話者 1 の全ての段落が新しい名前で引ける
    const shown = renamed.recording.segments.map((item: { speaker: number }) => renamed.recording.speakerNames[String(item.speaker)]);
    expect(shown).toEqual(["進行役", "記録役", "進行役"]);

    const merged = await (await patch(page.id, { baseRevision: 3, mergeSpeakers: { from: 2, into: 1 } }, d)).json();
    expect(merged.recording.revision).toBe(4);
    expect(merged.recording.segments.map((item: { speaker: number }) => item.speaker)).toEqual([1, 1, 1]);
    expect(merged.recording.speakerNames).toEqual({ "1": "進行役" });
    expect(merged.speakers).toEqual([{ speaker: 1, name: "進行役", count: 3 }]);

    const cleared = await (await patch(page.id, { baseRevision: 4, renameSpeaker: { speaker: 1, name: null } }, d)).json();
    expect(cleared.recording.speakerNames).toEqual({});
    expect((await (await get(page.id, d)).json()).recording).toEqual(cleared.recording);
  });

  it("answers 409 with the latest recording to an old revision and writes nothing", async () => {
    const { store } = memoryStore();
    const { page } = await imported(store);
    const d = deps("user-a", store);
    const saved = await (await patch(page.id, { baseRevision: 1, edits: [{ index: 1, text: "別の画面で先に直した" }] }, d)).json();
    const stale = await patch(page.id, { baseRevision: 1, edits: [{ index: 1, text: "古い画面の文" }] }, d);
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(Object.keys(body).sort()).toEqual(["error", "recording", "speakers"]);
    expect(body.error).toBe("conflict");
    expect(body.recording).toEqual(saved.recording);
    expect(body.speakers).toEqual(saved.speakers);
    expect((await (await get(page.id, d)).json()).recording.segments[1].text).toBe("別の画面で先に直した");
    expect((await patch(page.id, { baseRevision: 9, renameSpeaker: { speaker: 1, name: "先" } }, d)).status).toBe(409);
  });

  it("answers 400 body to a request without exactly one well-formed operation", async () => {
    const { store, calls } = memoryStore();
    const { page } = await imported(store);
    calls.length = 0;
    const edits = [{ index: 0, text: "x" }];
    for (const body of [
      "{",
      [],
      {},
      { edits },
      { baseRevision: 1 },
      { baseRevision: 0, edits },
      { baseRevision: 1.5, edits },
      { baseRevision: "1", edits },
      { baseRevision: 1, edits, renameSpeaker: { speaker: 1, name: "x" } },
      { baseRevision: 1, edits, extra: 1 },
      { baseRevision: 1, edits: "x" },
      { baseRevision: 1, edits: [] },
      { baseRevision: 1, edits: Array.from({ length: 201 }, (_, index) => ({ index, text: "x" })) },
      { baseRevision: 1, edits: [{ index: 0 }] },
      { baseRevision: 1, edits: [{ index: "0", text: "x" }] },
      { baseRevision: 1, edits: [{ index: 0, text: "x", speaker: 2 }] },
      { baseRevision: 1, renameSpeaker: { speaker: 1 } },
      { baseRevision: 1, renameSpeaker: { speaker: "1", name: "x" } },
      { baseRevision: 1, renameSpeaker: { speaker: 1, name: 2 } },
      { baseRevision: 1, renameSpeaker: [1, "x"] },
      { baseRevision: 1, mergeSpeakers: { from: 1 } },
      { baseRevision: 1, mergeSpeakers: { from: 1, into: "2" } },
    ]) {
      const response = await patch(page.id, body, deps("user-a", store));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).toBe('{"error":"bad_request","reason":"body"}');
    }
    expect((await patch(page.id, "baseRevision=1", deps("user-a", store), { "content-type": "text/plain" })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("answers 400 with the reason the change was refused, and writes nothing", async () => {
    const { store } = memoryStore();
    const { page, recording } = await imported(store);
    const d = deps("user-a", store);
    for (const [body, reason] of [
      [{ baseRevision: 1, edits: [{ index: 3, text: "x" }] }, "index"],
      [{ baseRevision: 1, edits: [{ index: -1, text: "x" }] }, "index"],
      [{ baseRevision: 1, edits: [{ index: 0, text: "x" }, { index: 0, text: "y" }] }, "index"],
      [{ baseRevision: 1, edits: [{ index: 0, text: "あ".repeat(5001) }] }, "text"],
      [{ baseRevision: 1, edits: [{ index: 0, text: "a\u0000b" }] }, "text"],
      [{ baseRevision: 1, renameSpeaker: { speaker: 9, name: "x" } }, "speaker"],
      [{ baseRevision: 1, renameSpeaker: { speaker: 1, name: "記録役" } }, "name"],
      [{ baseRevision: 1, renameSpeaker: { speaker: 1, name: "話者2" } }, "name"],
      [{ baseRevision: 1, renameSpeaker: { speaker: 1, name: "長".repeat(61) } }, "name"],
      [{ baseRevision: 1, mergeSpeakers: { from: 1, into: 1 } }, "merge"],
      [{ baseRevision: 1, mergeSpeakers: { from: 1, into: 3 } }, "speaker"],
    ] as const) {
      const response = await patch(page.id, body, d);
      expect(response.status, reason).toBe(400);
      expect(await response.text(), reason).toBe(JSON.stringify({ error: "bad_request", reason }));
    }
    expect((await (await get(page.id, d)).json()).recording).toEqual(recording);
  });

  it("answers 401, 403, 503 before reading the body, and the same 404 for pages that are not the owner's", async () => {
    const { store, rows, calls } = memoryStore();
    const theirs = (await imported(store, "user-b")).page.id;
    const trashed = (await imported(store)).page.id;
    rows.find((row) => row.id === trashed)!.deleted = true;
    calls.length = 0;
    const body = { baseRevision: 1, renameSpeaker: { speaker: 1, name: "書き換え" } };
    expect((await patch(theirs, body, deps(null, store))).status).toBe(401);
    expect((await patch(theirs, body, deps("user-a", store), { origin: "https://evil.example" })).status).toBe(403);
    expect((await patch(theirs, body, deps("user-a", null))).status).toBe(503);
    expect(calls).toEqual([]);

    const results = [];
    for (const id of [theirs, trashed, randomUUID(), "not-a-uuid"]) results.push(await snapshot(await patch(id, body, deps("user-a", store))));
    expect(results[0]?.status).toBe(404);
    for (const result of results.slice(1)) expect(result).toEqual(results[0]);
    expect(rows.find((row) => row.id === theirs)?.recording?.speakerNames).toEqual({ "1": "司会役", "2": "記録役" });
    expect(rows.find((row) => row.id === theirs)?.recording?.revision).toBe(1);
  });

  it("answers 413 above the edit limit and 500 without details when the store fails", async () => {
    const { store } = memoryStore();
    const { page } = await imported(store);
    const big = JSON.stringify({ baseRevision: 1, edits: [{ index: 0, text: "a".repeat(RECORDING_PATCH_BODY_MAX_BYTES) }] });
    expect((await patch(page.id, big, deps("user-a", store))).status).toBe(413);

    const failing: RecordingsStore = {
      ...store,
      updateRecording: async () => {
        throw Object.assign(new Error("deadlock detected on page_recordings 進行役"), { code: "40P01" });
      },
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await patch(page.id, { baseRevision: 1, renameSpeaker: { speaker: 1, name: "進行役" } }, deps("user-a", failing));
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"error":"internal"}');
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/deadlock|page_recordings|進行役/);
    } finally {
      log.mockRestore();
    }
  });
});

describe("recording data from the API", () => {
  it("passes only the documented recording fields through", async () => {
    const { store, rows } = memoryStore();
    const { page } = await imported(store);
    const row = rows.find((item) => item.id === page.id)!;
    row.recording = { ...row.recording!, extra: "internal" } as Recording & { extra: string };
    (row.recording.segments[0] as unknown as Record<string, unknown>).hidden = "x";
    const body = await (await get(page.id, deps("user-a", store))).text();
    expect(body).not.toMatch(/internal|hidden/);
    const data: RecordingData = JSON.parse(body).recording;
    expect(Object.keys(data.segments[0]!)).toEqual(["start", "end", "text", "speaker"]);
  });
});

describe("PATCH /api/pages/{id}/recording（あとの .vtt を足す）", () => {
  const SECOND_VTT = ["WEBVTT", "", "00:00:00.000 --> 00:00:02.000", "<v 司会役>続きです", "", "00:00:02.000 --> 00:00:05.000", "<v 新しい人>はい", "", ""].join("\n");

  it("足した段落の時刻を、前の音声の長さだけずらして 1 本につなぐ", async () => {
    const { store, rows } = memoryStore();
    const { page } = await imported(store);
    const d = deps("user-a", store);
    // 1 本目は 6 秒の字幕（合成の VTT）。音声の長さを 10 秒として、そのあとに足す
    const row = rows.find((item) => item.id === page.id)!;
    row.recording = { ...row.recording!, durationSec: 10 };

    const response = await patch(page.id, { baseRevision: 1, appendVtt: { name: "合成の会議 2.vtt", vtt: SECOND_VTT } }, d);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recording.revision).toBe(2);
    expect(body.recording.segments.map((item: { start: number; end: number; text: string; speaker: number }) => [item.start, item.end, item.text, item.speaker])).toEqual([
      [1, 2.5, "はじめます", 1],
      [2.5, 4, "お願いします", 2],
      [4, 6, "一つ目の議題です", 1],
      // 10 秒（1 本目の音声の長さ）だけ後ろへ。同じ名前の「司会役」は話者 1 のまま
      [10, 12, "続きです", 1],
      [12, 15, "はい", 3],
    ]);
    expect(body.recording.speakerNames).toEqual({ "1": "司会役", "2": "記録役", "3": "新しい人" });
    // 録音の長さは 10 + 5（次に足すときのずらす量）
    expect(body.recording.durationSec).toBe(15);
    expect(body.speakers).toEqual([
      { speaker: 1, name: "司会役", count: 3 },
      { speaker: 2, name: "記録役", count: 1 },
      { speaker: 3, name: "新しい人", count: 1 },
    ]);
  });

  it("続けて足すと、そのつど前までの長さだけずらす", async () => {
    const { store } = memoryStore();
    const { page } = await imported(store);
    const d = deps("user-a", store);
    const first = await (await patch(page.id, { baseRevision: 1, appendVtt: { name: "2.vtt", vtt: SECOND_VTT } }, d)).json();
    expect(first.recording.durationSec).toBe(11);
    const second = await (await patch(page.id, { baseRevision: 2, appendVtt: { name: "3.vtt", vtt: SECOND_VTT } }, d)).json();
    expect(second.recording.segments.at(-1).start).toBe(13);
    expect(second.recording.durationSec).toBe(16);
  });

  it("読めない .vtt・発言のない .vtt・形の違う要求は 400（何も書かない）", async () => {
    const { store } = memoryStore();
    const { page } = await imported(store);
    const d = deps("user-a", store);
    const reasons: [unknown, string][] = [
      [{ baseRevision: 1, appendVtt: { name: "x.vtt", vtt: "これは字幕ではありません" } }, "vtt_invalid"],
      [{ baseRevision: 1, appendVtt: { name: "x.vtt", vtt: "WEBVTT\n" } }, "vtt_empty"],
      [{ baseRevision: 1, appendVtt: { name: "x\u0000.vtt", vtt: SECOND_VTT } }, "name"],
      [{ baseRevision: 1, appendVtt: { name: "x.vtt", vtt: SECOND_VTT, lang: "ja" } }, "body"],
      [{ baseRevision: 1, appendVtt: { name: "x.vtt" } }, "body"],
      [{ baseRevision: 1, appendVtt: { name: 7, vtt: SECOND_VTT } }, "name"],
      [{ baseRevision: 1, appendVtt: { name: "x.vtt", vtt: SECOND_VTT }, edits: [{ index: 0, text: "x" }] }, "body"],
    ];
    for (const [body, reason] of reasons) {
      const response = await patch(page.id, body, d);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request", reason });
    }
    // 1 件も書いていない
    expect((await (await get(page.id, d)).json()).recording.revision).toBe(1);
  });

  it("先に直されていたら足さずに 409（最新を返す）。別の人・存在しないページは 404、未認証は 401、別の origin は 403", async () => {
    const { store } = memoryStore();
    const { page } = await imported(store);
    const append = { appendVtt: { name: "2.vtt", vtt: SECOND_VTT } };
    await patch(page.id, { baseRevision: 1, edits: [{ index: 0, text: "先に直した" }] }, deps("user-a", store));

    const conflict = await patch(page.id, { baseRevision: 1, ...append }, deps("user-a", store));
    expect(conflict.status).toBe(409);
    const body = await conflict.json();
    expect(body.error).toBe("conflict");
    expect(body.recording.segments).toHaveLength(3);

    expect((await patch(page.id, { baseRevision: 2, ...append }, deps("user-b", store))).status).toBe(404);
    expect((await patch(randomUUID(), { baseRevision: 2, ...append }, deps("user-a", store))).status).toBe(404);
    expect((await patch(page.id, { baseRevision: 2, ...append }, deps(null, store))).status).toBe(401);
    expect((await patch(page.id, { baseRevision: 2, ...append }, deps("user-a", store), { origin: "http://evil.test" })).status).toBe(403);
  });

  it("本文が大きすぎたら 413（4 MiB の .vtt は入る）", async () => {
    const { store } = memoryStore();
    const { page } = await imported(store);
    const d = deps("user-a", store);
    const big = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${"あ".repeat(1000)}\n`;
    expect((await patch(page.id, { baseRevision: 1, appendVtt: { name: "2.vtt", vtt: big } }, d)).status).toBe(200);
    const overBody = JSON.stringify({ baseRevision: 2, appendVtt: { name: "2.vtt", vtt: "x" } }).padEnd(RECORDING_PATCH_BODY_MAX_BYTES + 1, " ");
    expect((await patch(page.id, overBody, d)).status).toBe(413);
    // VTT そのものの上限を超えるものは 400（vtt_too_large）
    const tooLarge = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${"あ".repeat(VTT_IMPORT_MAX_BYTES / 3 + 10)}\n`;
    const response = await patch(page.id, { baseRevision: 2, appendVtt: { name: "2.vtt", vtt: tooLarge } }, d);
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe("vtt_too_large");
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
