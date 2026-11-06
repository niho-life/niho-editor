import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { recordingDataProblem, type Transcript, type TranscriptVersion, type TranscriptionRunView } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
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
