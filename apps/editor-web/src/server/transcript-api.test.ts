import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { recordingDataProblem, type Transcript, type TranscriptVersion, type TranscriptionRunView } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { VTT_IMPORT_MAX_BYTES } from "../recording/vtt-import";
import { RECORDING_PATCH_BODY_MAX_BYTES } from "./recordings-api";
import {
  TRANSCRIPT_RESTORE_BODY_MAX_BYTES,
  getTranscriptRoute,
  getTranscriptVersionRoute,
  listTranscriptVersionsRoute,
  patchTranscriptRoute,
  restoreTranscriptVersionRoute,
  type TranscriptApiDeps,
  type TranscriptStore,
} from "./transcript-api";

// 合成のユーザー ID・段落だけを使う
const ORIGIN = "http://editor.test";
const REC = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

type Row = { id: string; owner: string; deleted: boolean; transcript: Transcript; versions: TranscriptVersion[]; run: TranscriptionRunView | null };

function transcriptOf(extra: Partial<Transcript> = {}): Transcript {
  const now = new Date(0).toISOString();
  return {
    revision: 1,
    recordingPageId: REC,
    engine: "fake",
    language: "ja",
    durationSec: 9,
    segments: [
      { start: 0, end: 4, text: "合成の一つ目", speaker: 1 },
      { start: 4, end: 9, text: "合成の二つ目", speaker: 2 },
    ],
    speakerNames: { "1": "司会役" },
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

/** メモリの中だけの合成の store（packages/editor-store と同じ約束: 自分の・ゴミ箱でないタブだけ、revision を見る、直す前の本文を版に残す）。 */
function memoryStore(rows: Row[] = []) {
  const calls: string[] = [];
  const find = (owner: string, id: string) => rows.find((row) => row.id === id && row.owner === owner && !row.deleted) ?? null;
  const save = (row: Row, reason: TranscriptVersion["reason"]) => {
    const { transcript } = row;
    row.versions.unshift({ version: row.versions.length + 1, reason, engine: transcript.engine, language: transcript.language, segments: transcript.segments, speakerNames: transcript.speakerNames, durationSec: transcript.durationSec, segmentCount: transcript.segments.length, createdAt: transcript.updatedAt });
  };
  const store: TranscriptStore = {
    get: async (owner, id) => {
      calls.push(`get:${owner}`);
      return find(owner, id)?.transcript ?? null;
    },
    update: async (owner, id, baseRevision, mutate) => {
      calls.push(`update:${owner}`);
      const row = find(owner, id);
      if (!row) return null;
      if (row.transcript.revision !== baseRevision) return { status: "conflict", transcript: row.transcript };
      const next = mutate(structuredClone({ segments: row.transcript.segments, speakerNames: row.transcript.speakerNames, durationSec: row.transcript.durationSec }));
      if ("rejected" in next) return { status: "rejected", reason: next.rejected };
      const problem = recordingDataProblem(next);
      if (problem) throw new Error(problem);
      save(row, "edit");
      row.transcript = { ...row.transcript, segments: next.segments, speakerNames: next.speakerNames, durationSec: next.durationSec === undefined ? row.transcript.durationSec : next.durationSec, revision: row.transcript.revision + 1 };
      return { status: "ok", transcript: row.transcript };
    },
    listVersions: async (owner, id) => find(owner, id)?.versions.map(({ version, reason, engine, segmentCount, createdAt }) => ({ version, reason, engine, segmentCount, createdAt })) ?? [],
    getVersion: async (owner, id, version) => find(owner, id)?.versions.find((item) => item.version === version) ?? null,
    restoreVersion: async (owner, id, version, baseRevision) => {
      const row = find(owner, id);
      if (!row) return null;
      const target = row.versions.find((item) => item.version === version);
      if (!target) return { status: "rejected", reason: "version_missing" };
      if (row.transcript.revision !== baseRevision) return { status: "conflict", transcript: row.transcript };
      save(row, "restore");
      row.transcript = { ...row.transcript, segments: target.segments, speakerNames: target.speakerNames, durationSec: target.durationSec, revision: row.transcript.revision + 1 };
      return { status: "ok", transcript: row.transcript };
    },
    run: async (owner, id) => find(owner, id)?.run ?? null,
  };
  return { store, rows, calls };
}

function row(extra: Partial<Row> = {}): Row {
  return { id: randomUUID(), owner: "user-a", deleted: false, transcript: transcriptOf(), versions: [], run: null, ...extra };
}

const notUsed = async (): Promise<Response> => {
  throw new Error("the transcript API never calls the login routes");
};

function authAs(userId: string | null): AuthProvider {
  return { mode: "stub", getSession: async () => (userId ? { userId, mode: "stub" } : null), beginLogin: notUsed, completeLogin: notUsed, logout: notUsed };
}

function deps(userId: string | null, store: TranscriptStore | null): TranscriptApiDeps {
  return { auth: () => authAs(userId), store: () => store, env: {} };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const sameOrigin: Record<string, string> = method === "GET" ? {} : { origin: ORIGIN };
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { host: "editor.test", "content-type": "application/json", ...sameOrigin, ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

const get = (id: string, d: TranscriptApiDeps) => getTranscriptRoute(request("GET", `/api/pages/${id}/transcript`), id, d);
const patch = (id: string, body: unknown, d: TranscriptApiDeps, headers: Record<string, string> = {}) => patchTranscriptRoute(request("PATCH", `/api/pages/${id}/transcript`, body, headers), id, d);
const versions = (id: string, d: TranscriptApiDeps) => listTranscriptVersionsRoute(request("GET", `/api/pages/${id}/transcript/versions`), id, d);
const version = (id: string, v: string, d: TranscriptApiDeps) => getTranscriptVersionRoute(request("GET", `/api/pages/${id}/transcript/versions/${v}`), id, v, d);
const restore = (id: string, v: string, body: unknown, d: TranscriptApiDeps) => restoreTranscriptVersionRoute(request("POST", `/api/pages/${id}/transcript/versions/${v}/restore`, body), id, v, d);

async function snapshot(response: Response) {
  return { status: response.status, headers: [...response.headers.entries()].sort(), body: await response.text() };
}

describe("GET /api/pages/{tab}/transcript", () => {
  it("answers the transcript of the signed-in owner's tab with the speakers, the engine label and the latest run (only the documented fields)", async () => {
    const run: TranscriptionRunView = { id: randomUUID(), status: "succeeded", engine: "fake", language: "ja", errorCode: null, createdAt: new Date(0).toISOString(), startedAt: new Date(0).toISOString(), finishedAt: new Date(0).toISOString(), tab: null };
    const target = row({ run: { ...run, tab: "ignored" } as TranscriptionRunView });
    const { store } = memoryStore([target]);
    const response = await get(target.id, deps("user-a", store));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["run", "speakers", "transcript"]);
    expect(Object.keys(body.transcript).sort()).toEqual(["createdAt", "durationSec", "engine", "engineLabel", "language", "recording", "revision", "segments", "speakerNames", "updatedAt"]);
    expect(body.transcript).toMatchObject({ revision: 1, recording: REC, engine: "fake", engineLabel: "開発の偽物", language: "ja", durationSec: 9 });
    expect(body.speakers).toEqual([
      { speaker: 1, name: "司会役", count: 1 },
      { speaker: 2, name: null, count: 1 },
    ]);
    expect(Object.keys(body.run).sort()).toEqual(["createdAt", "engine", "errorCode", "finishedAt", "id", "language", "startedAt", "status", "tab"]);
    expect(body.run.id).toBe(run.id);
  });

  it("answers run: null when nothing wrote the tab, and the same 404 for another owner's tab, the trash, unknown and malformed ids", async () => {
    const mine = row();
    const theirs = row({ owner: "user-b" });
    const trashed = row({ deleted: true });
    const { store, calls } = memoryStore([mine, theirs, trashed]);
    expect((await (await get(mine.id, deps("user-a", store))).json()).run).toBeNull();
    const results = [];
    for (const id of [theirs.id, trashed.id, randomUUID(), "not-a-uuid"]) results.push(await snapshot(await get(id, deps("user-a", store))));
    expect(results[0]?.status).toBe(404);
    expect(results[0]?.body).toBe('{"error":"not_found"}');
    for (const result of results.slice(1)) expect(result).toEqual(results[0]);
    calls.length = 0;
    expect((await get(mine.id, deps(null, store))).status).toBe(401);
    expect((await get(mine.id, deps("user-a", null))).status).toBe(503);
    expect(calls).toEqual([]);
  });
});

describe("PATCH /api/pages/{tab}/transcript", () => {
  it("edits paragraphs, renames and merges speakers with baseRevision (one operation at a time), and keeps a version of the text before", async () => {
    const target = row();
    const { store } = memoryStore([target]);
    const d = deps("user-a", store);
    const edited = await patch(target.id, { baseRevision: 1, edits: [{ index: 0, text: "直した" }] }, d);
    expect(edited.status).toBe(200);
    const body = await edited.json();
    expect(Object.keys(body).sort()).toEqual(["speakers", "transcript"]);
    expect(body.transcript.revision).toBe(2);
    expect(body.transcript.segments[0].text).toBe("直した");
    const renamed = await patch(target.id, { baseRevision: 2, renameSpeaker: { speaker: 2, name: "記録役" } }, d);
    expect((await renamed.json()).speakers).toEqual([
      { speaker: 1, name: "司会役", count: 1 },
      { speaker: 2, name: "記録役", count: 1 },
    ]);
    const merged = await patch(target.id, { baseRevision: 3, mergeSpeakers: { from: 2, into: 1 } }, d);
    expect((await merged.json()).speakers).toEqual([{ speaker: 1, name: "司会役", count: 2 }]);
    const list = await versions(target.id, d);
    expect((await list.json()).versions.map((item: { version: number; reason: string; engineLabel: string }) => [item.version, item.reason, item.engineLabel])).toEqual([[3, "edit", "開発の偽物"], [2, "edit", "開発の偽物"], [1, "edit", "開発の偽物"]]);
  });

  it("answers 409 with the latest when the revision is old, 400 with the reason for a refused change or a malformed body, and touches nothing", async () => {
    const target = row();
    const { store } = memoryStore([target]);
    const d = deps("user-a", store);
    const stale = await patch(target.id, { baseRevision: 9, edits: [{ index: 0, text: "x" }] }, d);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "conflict", transcript: { revision: 1 } });
    const refused = await patch(target.id, { baseRevision: 1, renameSpeaker: { speaker: 2, name: "話者1" } }, d);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe('{"error":"bad_request","reason":"name"}');
    for (const body of ["not json", {}, { baseRevision: 0, edits: [] }, { baseRevision: 1 }, { baseRevision: 1, edits: [], renameSpeaker: { speaker: 1, name: "x" } }, { baseRevision: 1, nope: 1 }]) {
      const response = await patch(target.id, body, d);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).toBe('{"error":"bad_request","reason":"body"}');
    }
    expect(target.transcript.revision).toBe(1);
    expect(target.versions).toEqual([]);
  });

  it("checks 401, 403 (other origin), 503, and the same 404 as GET; appends a .vtt with the time shifted by the length", async () => {
    const target = row();
    const theirs = row({ owner: "user-b" });
    const { store, calls } = memoryStore([target, theirs]);
    expect((await patch(target.id, {}, deps(null, store))).status).toBe(401);
    expect((await patch(target.id, {}, deps("user-a", store), { origin: "https://evil.example" })).status).toBe(403);
    expect((await patch(target.id, { baseRevision: 1, edits: [{ index: 0, text: "x" }] }, deps("user-a", null))).status).toBe(503);
    expect(calls).toEqual([]);
    expect((await patch(theirs.id, { baseRevision: 1, edits: [{ index: 0, text: "x" }] }, deps("user-a", store))).status).toBe(404);
    const vtt = ["WEBVTT", "", "00:00:00.000 --> 00:00:03.000", "<v 司会役>続きです", ""].join("\n");
    const appended = await patch(target.id, { baseRevision: 1, appendVtt: { name: "2.vtt", vtt } }, deps("user-a", store));
    expect(appended.status).toBe(200);
    const body = await appended.json();
    expect(body.transcript.segments.at(-1)).toEqual({ start: 9, end: 12, text: "続きです", speaker: 1 });
    expect(body.transcript.durationSec).toBe(12);
  });
});

describe("PATCH /api/pages/{tab}/transcript: the request body", () => {
  it("answers 400 body to a request without exactly one well-formed operation, before touching the store", async () => {
    const target = row();
    const { store, calls } = memoryStore([target]);
    const edits = [{ index: 0, text: "x" }];
    for (const body of [
      "{",
      [],
      { edits },
      { baseRevision: 0, edits },
      { baseRevision: 1.5, edits },
      { baseRevision: "1", edits },
      { baseRevision: 1, edits, renameSpeaker: { speaker: 1, name: "x" } },
      { baseRevision: 1, edits, extra: 1 },
      { baseRevision: 1, edits: "x" },
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
      const response = await patch(target.id, body, deps("user-a", store));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).toBe('{"error":"bad_request","reason":"body"}');
    }
    expect((await patch(target.id, "baseRevision=1", deps("user-a", store), { "content-type": "text/plain" })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("answers 400 with the reason the change was refused, and writes nothing", async () => {
    const target = row();
    const { store } = memoryStore([target]);
    const d = deps("user-a", store);
    for (const [body, reason] of [
      [{ baseRevision: 1, edits: [{ index: 2, text: "x" }] }, "index"],
      [{ baseRevision: 1, edits: [{ index: -1, text: "x" }] }, "index"],
      [{ baseRevision: 1, edits: [{ index: 0, text: "x" }, { index: 0, text: "y" }] }, "index"],
      [{ baseRevision: 1, edits: [{ index: 0, text: "あ".repeat(5001) }] }, "text"],
      [{ baseRevision: 1, edits: [{ index: 0, text: "a\u0000b" }] }, "text"],
      [{ baseRevision: 1, renameSpeaker: { speaker: 9, name: "x" } }, "speaker"],
      [{ baseRevision: 1, renameSpeaker: { speaker: 2, name: "司会役" } }, "name"],
      [{ baseRevision: 1, renameSpeaker: { speaker: 1, name: "話者2" } }, "name"],
      [{ baseRevision: 1, renameSpeaker: { speaker: 1, name: "長".repeat(61) } }, "name"],
      [{ baseRevision: 1, mergeSpeakers: { from: 1, into: 1 } }, "merge"],
      [{ baseRevision: 1, mergeSpeakers: { from: 1, into: 3 } }, "speaker"],
    ] as const) {
      const response = await patch(target.id, body, d);
      expect(response.status, reason).toBe(400);
      expect(await response.text(), reason).toBe(JSON.stringify({ error: "bad_request", reason }));
    }
    expect(target.transcript).toEqual(transcriptOf());
    expect(target.versions).toEqual([]);
  });

  it("normalises line breaks of an edited paragraph", async () => {
    const target = row();
    const { store } = memoryStore([target]);
    const edited = await (await patch(target.id, { baseRevision: 1, edits: [{ index: 0, text: "はじめます。\r\n直しました" }] }, deps("user-a", store))).json();
    expect(edited.transcript.segments[0]).toEqual({ start: 0, end: 4, text: "はじめます。\n直しました", speaker: 1 });
  });
});

describe("PATCH /api/pages/{tab}/transcript: appending a .vtt (#36 段 3b-3)", () => {
  const SECOND_VTT = ["WEBVTT", "", "00:00:00.000 --> 00:00:02.000", "<v 司会役>続きです", "", "00:00:02.000 --> 00:00:05.000", "<v 新しい人>はい", "", ""].join("\n");

  it("shifts the added paragraphs by the length so far, keeps a speaker of the same name, and shifts again by the new length next time", async () => {
    const target = row();
    const { store } = memoryStore([target]);
    const d = deps("user-a", store);
    const first = await (await patch(target.id, { baseRevision: 1, appendVtt: { name: "2.vtt", vtt: SECOND_VTT } }, d)).json();
    expect(first.transcript.revision).toBe(2);
    expect(first.transcript.segments.slice(2).map((item: { start: number; end: number; text: string; speaker: number }) => [item.start, item.end, item.text, item.speaker])).toEqual([
      [9, 11, "続きです", 1],
      [11, 14, "はい", 3],
    ]);
    expect(first.transcript.speakerNames).toEqual({ "1": "司会役", "3": "新しい人" });
    expect(first.transcript.durationSec).toBe(14);
    const second = await (await patch(target.id, { baseRevision: 2, appendVtt: { name: "3.vtt", vtt: SECOND_VTT } }, d)).json();
    expect(second.transcript.segments.at(-1).start).toBe(16);
    expect(second.transcript.durationSec).toBe(19);
  });

  it("answers 400 for a .vtt it cannot read, one without speech, or a malformed request, and writes nothing", async () => {
    const target = row();
    const { store } = memoryStore([target]);
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
      const response = await patch(target.id, body, d);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request", reason });
    }
    expect(target.transcript.revision).toBe(1);
  });

  it("answers 409 with the latest when the tab was changed first, 404 for another owner's tab", async () => {
    const target = row();
    const { store } = memoryStore([target]);
    const append = { appendVtt: { name: "2.vtt", vtt: SECOND_VTT } };
    await patch(target.id, { baseRevision: 1, edits: [{ index: 0, text: "先に直した" }] }, deps("user-a", store));
    const conflict = await patch(target.id, { baseRevision: 1, ...append }, deps("user-a", store));
    expect(conflict.status).toBe(409);
    const body = await conflict.json();
    expect(body.error).toBe("conflict");
    expect(body.transcript.segments).toHaveLength(2);
    expect((await patch(target.id, { baseRevision: 2, ...append }, deps("user-b", store))).status).toBe(404);
  });

  it("answers 413 to a body above the limit, while a .vtt near the limit goes in; a .vtt above its own limit is 400 vtt_too_large", async () => {
    const target = row();
    const { store } = memoryStore([target]);
    const d = deps("user-a", store);
    const big = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${"あ".repeat(1000)}\n`;
    expect((await patch(target.id, { baseRevision: 1, appendVtt: { name: "2.vtt", vtt: big } }, d)).status).toBe(200);
    const overBody = JSON.stringify({ baseRevision: 2, appendVtt: { name: "2.vtt", vtt: "x" } }).padEnd(RECORDING_PATCH_BODY_MAX_BYTES + 1, " ");
    expect((await patch(target.id, overBody, d)).status).toBe(413);
    const tooLarge = `WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n${"あ".repeat(VTT_IMPORT_MAX_BYTES / 3 + 10)}\n`;
    const response = await patch(target.id, { baseRevision: 2, appendVtt: { name: "2.vtt", vtt: tooLarge } }, d);
    expect(response.status).toBe(400);
    expect((await response.json()).reason).toBe("vtt_too_large");
  });
});

describe("versions of a transcript tab", () => {
  it("lists, reads one, restores with baseRevision (409 when old), and answers 404 for a version or tab that is not there", async () => {
    const target = row();
    const { store } = memoryStore([target]);
    const d = deps("user-a", store);
    await patch(target.id, { baseRevision: 1, edits: [{ index: 0, text: "直した" }] }, d);
    const one = await version(target.id, "1", d);
    expect(one.status).toBe(200);
    const body = await one.json();
    expect(Object.keys(body.version).sort()).toEqual(["createdAt", "durationSec", "engine", "engineLabel", "language", "reason", "segmentCount", "segments", "speakerNames", "version"]);
    expect(body.version.segments[0].text).toBe("合成の一つ目");
    expect((await version(target.id, "2", d)).status).toBe(404);
    expect((await version(target.id, "x", d)).status).toBe(404);
    expect((await version(randomUUID(), "1", d)).status).toBe(404);
    expect((await versions(randomUUID(), d)).status).toBe(404);

    const stale = await restore(target.id, "1", { baseRevision: 1 }, d);
    expect(stale.status).toBe(409);
    const restored = await restore(target.id, "1", { baseRevision: 2 }, d);
    expect(restored.status).toBe(200);
    expect((await restored.json()).transcript).toMatchObject({ revision: 3, segments: [{ text: "合成の一つ目" }, { text: "合成の二つ目" }] });
    expect((await restore(target.id, "9", { baseRevision: 3 }, d)).status).toBe(404);
    for (const body of ["not json", {}, { baseRevision: 0 }, { baseRevision: 3, extra: 1 }]) {
      const response = await restore(target.id, "1", body, d);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await restore(target.id, "1", JSON.stringify({ baseRevision: 3, pad: "x".repeat(TRANSCRIPT_RESTORE_BODY_MAX_BYTES) }), d)).status).toBe(413);
    expect((await restore(target.id, "1", { baseRevision: 3 }, deps("user-a", store), )).status).toBe(200);
  });

  it("answers 500 with a generic body and logs only the route, the name and the code when the store fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing: TranscriptStore = {
      get: async () => {
        throw Object.assign(new Error("relation page_transcripts at synthetic detail"), { code: "XX000" });
      },
      update: async () => null,
      listVersions: async () => [],
      getVersion: async () => null,
      restoreVersion: async () => null,
    };
    const response = await get(randomUUID(), deps("user-a", failing));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"internal"}');
    expect(errors).toHaveBeenCalledWith("editor-web: request failed", { route: "GET /api/pages/[id]/transcript", name: "Error", code: "XX000" });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("synthetic detail");
    errors.mockRestore();
  });
});
