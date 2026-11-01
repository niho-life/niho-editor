import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnqueueTranscriptionInput, Recording, TranscriptionRunView } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import type { TranscriptionDispatcher } from "../transcription/dispatch";
import { getRecordingRoute, type RecordingsStore } from "./recordings-api";
import {
  TRANSCRIBE_BODY_MAX_BYTES,
  getTranscriptionRoute,
  startTranscriptionRoute,
  type TranscriptionApiDeps,
  type TranscriptionRunnerDeps,
  type TranscriptionStore,
} from "./transcription-api";

// 合成のユーザー ID・段落だけを使う

const ORIGIN = "http://editor.test";

type Page = { id: string; owner: string; deleted: boolean; audio: "none" | "uploading" | "uploaded"; expired: boolean; segments: number; language: "ja" | "en" };
type Run = TranscriptionRunView & { pageId: string; generation: number; input: EnqueueTranscriptionInput };

/** メモリの中だけの合成の store（packages/editor-store と同じ約束: 自分の・ゴミ箱でない録音だけ、前提の順、有効な run は 1 つ）。 */
function memoryStore(pages: Page[] = []) {
  const runs: Run[] = [];
  const calls: string[] = [];
  const find = (owner: string, id: string) => pages.find((page) => page.id === id && page.owner === owner && !page.deleted) ?? null;
  const view = ({ id, status, engine, language, errorCode, createdAt, startedAt, finishedAt }: Run): TranscriptionRunView => ({
    id,
    status,
    engine,
    language,
    errorCode,
    createdAt,
    startedAt,
    finishedAt,
  });
  const store: TranscriptionStore = {
    enqueue: async (owner, id, input) => {
      calls.push(`enqueue:${owner}`);
      const page = find(owner, id);
      if (!page) return null;
      if (page.audio !== "uploaded") return { status: "audio_not_ready" };
      if (page.expired) return { status: "audio_expired" };
      const active = runs.find((run) => run.pageId === id && (run.status === "queued" || run.status === "running"));
      if (active) return { status: "existing", run: view(active), candidate: active.input.candidate ?? null };
      if (page.segments > 0 && !input.replace) return { status: "has_transcript" };
      const run: Run = {
        id: randomUUID(),
        status: "queued",
        engine: input.engine,
        language: input.language ?? page.language,
        errorCode: null,
        createdAt: new Date(runs.length * 1000).toISOString(),
        startedAt: null,
        finishedAt: null,
        pageId: id,
        generation: 0,
        input,
      };
      runs.push(run);
      return { status: "created", run: view(run) };
    },
    status: async (owner, id) => {
      calls.push(`status:${owner}`);
      if (!find(owner, id)) return null;
      const latest = runs.filter((run) => run.pageId === id).at(-1);
      return { run: latest ? view(latest) : null };
    },
    failRun: async (runId, generation, code) => {
      calls.push(`fail:${generation}:${code}`);
      const run = runs.find((item) => item.id === runId && item.generation === generation && (item.status === "queued" || item.status === "running"));
      if (!run) return false;
      run.status = "failed";
      run.errorCode = code;
      run.finishedAt = new Date(0).toISOString();
      return true;
    },
  };
  return { store, runs, calls, pages };
}

function page(extra: Partial<Page> = {}): Page {
  return { id: randomUUID(), owner: "user-a", deleted: false, audio: "uploaded", expired: false, segments: 0, language: "ja", ...extra };
}

const notUsed = async (): Promise<Response> => {
  throw new Error("the transcription API never calls the login routes");
};

function authAs(userId: string | null): AuthProvider {
  return { mode: "stub", getSession: async () => (userId ? { userId, mode: "stub" } : null), beginLogin: notUsed, completeLogin: notUsed, logout: notUsed };
}

function dispatcher(fail = false) {
  const dispatched: string[] = [];
  const value: TranscriptionDispatcher = {
    kind: "inline",
    dispatch: async (runId) => {
      dispatched.push(runId);
      if (fail) throw new Error("synthetic dispatch failure");
    },
  };
  return { dispatcher: value, dispatched };
}

function deps(userId: string | null, store: TranscriptionStore | null, runner: TranscriptionRunnerDeps | null, extra: Partial<TranscriptionApiDeps> = {}): TranscriptionApiDeps {
  return { auth: () => authAs(userId), store: () => store, runner: () => runner, env: {}, ...extra };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const sameOrigin: Record<string, string> = method === "GET" ? {} : { origin: ORIGIN };
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { host: "editor.test", "content-type": "application/json", ...sameOrigin, ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

const start = (id: string, body: unknown, d: TranscriptionApiDeps, headers: Record<string, string> = {}) =>
  startTranscriptionRoute(request("POST", `/api/pages/${id}/recording/transcribe`, body, headers), id, d);
const status = (id: string, d: TranscriptionApiDeps) => getTranscriptionRoute(request("GET", `/api/pages/${id}/recording/transcription`), id, d);

async function snapshot(response: Response) {
  return { status: response.status, headers: [...response.headers.entries()].sort(), body: await response.text() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/pages/{id}/recording/transcribe", () => {
  it("creates a run for the signed-in owner with the configured engine, answers 202, and dispatches it once", async () => {
    const target = page({ language: "en" });
    const { store, runs } = memoryStore([target]);
    const { dispatcher: d, dispatched } = dispatcher();
    const response = await start(target.id, { terms: [" 合成語 ", "Synthetic"], diarize: false }, deps("user-a", store, { engine: "deepgram", engines: ["deepgram"], dispatcher: d }));
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["run"]);
    expect(Object.keys(body.run).sort()).toEqual(["createdAt", "engine", "errorCode", "finishedAt", "id", "language", "startedAt", "status"]);
    expect(body.run.status).toBe("queued");
    expect(body.run.engine).toBe("deepgram");
    expect(body.run.language).toBe("en");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.input).toEqual({ engine: "deepgram", diarize: false, replace: false, terms: ["合成語", "Synthetic"] });
    expect(dispatched).toEqual([body.run.id]);
  });

  it("starts with the engine the screen asked for (when its key is set)", async () => {
    const target = page();
    const { store, runs } = memoryStore([target]);
    const runner = { engine: "deepgram" as const, engines: ["deepgram" as const, "gemini" as const], dispatcher: dispatcher().dispatcher };
    expect((await start(target.id, { engine: "gemini" }, deps("user-a", store, runner))).status).toBe(202);
    expect(runs[0]!.input).toEqual({ engine: "gemini", diarize: true, replace: false, terms: [] });
  });

  it("uses the defaults for an empty body and passes the asked language", async () => {
    const target = page();
    const { store, runs } = memoryStore([target]);
    expect((await start(target.id, {}, deps("user-a", store, { engine: "fake", engines: ["fake"], dispatcher: dispatcher().dispatcher }))).status).toBe(202);
    expect(runs[0]!.input).toEqual({ engine: "fake", diarize: true, replace: false, terms: [] });
    const other = page();
    const second = memoryStore([other]);
    expect((await start(other.id, { lang: "en", replace: true }, deps("user-a", second.store, { engine: "fake", engines: ["fake"], dispatcher: dispatcher().dispatcher }))).status).toBe(202);
    expect(second.runs[0]!.input).toEqual({ engine: "fake", language: "en", diarize: true, replace: true, terms: [] });
  });

  it("returns an active run with 200 without dispatching again", async () => {
    const target = page();
    const { store, runs } = memoryStore([target]);
    const { dispatcher: d, dispatched } = dispatcher();
    const first = await (await start(target.id, {}, deps("user-a", store, { engine: "fake", engines: ["fake"], dispatcher: d }))).json();
    const again = await start(target.id, { replace: true }, deps("user-a", store, { engine: "fake", engines: ["fake"], dispatcher: d }));
    expect(again.status).toBe(200);
    expect((await again.json()).run).toEqual(first.run);
    expect(runs).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
  });

  it("fails the run when it cannot be dispatched, and still answers 202 with that run so that it can be tried again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const target = page();
    const { store, runs, calls } = memoryStore([target]);
    const response = await start(target.id, {}, deps("user-a", store, { engine: "fake", engines: ["fake"], dispatcher: dispatcher(true).dispatcher }));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.run.status).toBe("failed");
    expect(body.run.errorCode).toBe("internal");
    expect(runs[0]!.status).toBe("failed");
    expect(calls).toContain("fail:0:internal");
    // もう一度は新しい run
    const retry = await start(target.id, {}, deps("user-a", store, { engine: "fake", engines: ["fake"], dispatcher: dispatcher().dispatcher }));
    expect(retry.status).toBe(202);
    expect(runs).toHaveLength(2);
    expect(JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls)).not.toContain("synthetic dispatch failure");
  });

  it("answers 409 cannot_start with the reason for audio that is not ready, expired audio, and an existing transcript", async () => {
    const uploading = page({ audio: "uploading" });
    const vtt = page({ audio: "none" });
    const expired = page({ expired: true });
    const transcribed = page({ segments: 3 });
    const { store, runs } = memoryStore([uploading, vtt, expired, transcribed]);
    const { dispatcher: d, dispatched } = dispatcher();
    const runner = { engine: "fake" as const, engines: ["fake" as const], dispatcher: d };
    for (const [target, reason] of [
      [uploading, "audio_not_ready"],
      [vtt, "audio_not_ready"],
      [expired, "audio_expired"],
      [transcribed, "has_transcript"],
    ] as const) {
      const response = await start(target.id, {}, deps("user-a", store, runner));
      expect(response.status).toBe(409);
      expect(await response.text()).toBe(`{"error":"cannot_start","reason":"${reason}"}`);
    }
    expect(runs).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
    // replace なら段落があっても作る
    expect((await start(transcribed.id, { replace: true }, deps("user-a", store, runner))).status).toBe(202);
  });

  it("answers the same 404 (body and headers) for another owner's page, an unknown id, a malformed id, a page in the trash, and a page without a recording", async () => {
    const theirs = page({ owner: "user-b" });
    const trashed = page({ deleted: true });
    const { store, runs } = memoryStore([theirs, trashed]);
    const runner = { engine: "fake" as const, engines: ["fake" as const], dispatcher: dispatcher().dispatcher };
    const results = [];
    for (const id of [theirs.id, trashed.id, randomUUID(), "not-a-uuid"]) results.push(await snapshot(await start(id, {}, deps("user-a", store, runner))));
    expect(results[0]?.status).toBe(404);
    expect(results[0]?.body).toBe('{"error":"not_found"}');
    for (const result of results.slice(1)) expect(result).toEqual(results[0]);
    expect(runs).toHaveLength(0);
  });

  it("checks 401, then 403, then 503 transcription_unavailable, before reading the body or touching the store", async () => {
    const target = page();
    const { store, calls } = memoryStore([target]);
    const runner = { engine: "fake" as const, engines: ["fake" as const], dispatcher: dispatcher().dispatcher };
    const anonymous = await start(target.id, "not json", deps(null, store, null));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).toBe('{"error":"unauthorized"}');
    for (const origin of ["https://evil.example", "null"]) {
      expect((await start(target.id, "not json", deps("user-a", store, null), { origin })).status).toBe(403);
    }
    const noOrigin = startTranscriptionRoute(
      new Request(`${ORIGIN}/api/pages/${target.id}/recording/transcribe`, { method: "POST", headers: { host: "editor.test", "content-type": "application/json" }, body: "{}" }),
      target.id,
      deps("user-a", store, runner),
    );
    expect((await noOrigin).status).toBe(403);
    const off = await start(target.id, "not json", deps("user-a", store, null));
    expect(off.status).toBe(503);
    expect(await off.text()).toBe('{"error":"transcription_unavailable"}');
    expect(off.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const noDb = await start(target.id, {}, deps("user-a", null, runner));
    expect(noDb.status).toBe(503);
    expect(await noDb.text()).toBe('{"error":"unavailable"}');
    expect(calls).toEqual([]);
  });

  it("answers 400 with a reason for a malformed body, before looking up the page, and 413 for an oversized body", async () => {
    const { store, calls } = memoryStore();
    const runner = { engine: "fake" as const, engines: ["fake" as const], dispatcher: dispatcher().dispatcher };
    const id = randomUUID();
    const cases: Array<[unknown, string]> = [
      ["not json", "body"],
      [[], "body"],
      // engine は項目として受けるが、鍵の無いエンジンは選べない（この server は fake だけ）
      [{ engine: "deepgram" }, "engine"],
      [{ engine: 7 }, "engine"],
      [{ model: "gemini-3.8-flash" }, "body"],
      [{ lang: "fr" }, "lang"],
      [{ diarize: "yes" }, "diarize"],
      [{ replace: 1 }, "replace"],
      [{ terms: "語" }, "terms"],
      [{ terms: Array.from({ length: 101 }, (_, index) => `語${index}`) }, "terms"],
      [{ terms: ["a".repeat(65)] }, "terms"],
      [{ terms: ["   "] }, "terms"],
      [{ terms: ["改\n行"] }, "terms"],
      [{ terms: [3] }, "terms"],
    ];
    for (const [body, reason] of cases) {
      const response = await start(id, body, deps("user-a", store, runner));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).toBe(`{"error":"bad_request","reason":"${reason}"}`);
    }
    const plain = await start(id, "{}", deps("user-a", store, runner), { "content-type": "text/plain" });
    expect(await plain.text()).toBe('{"error":"bad_request","reason":"body"}');
    const large = await start(id, JSON.stringify({ terms: ["x".repeat(TRANSCRIBE_BODY_MAX_BYTES)] }), deps("user-a", store, runner));
    expect(large.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("answers 500 with a generic body and logs only the route, the name and the code when the store fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing: TranscriptionStore = {
      enqueue: async () => {
        throw Object.assign(new Error("relation transcription_runs at synthetic detail"), { code: "XX000" });
      },
      status: async () => null,
      failRun: async () => false,
    };
    const response = await start(randomUUID(), {}, deps("user-a", failing, { engine: "fake", engines: ["fake"], dispatcher: dispatcher().dispatcher }));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"internal"}');
    expect(errors).toHaveBeenCalledWith("editor-web: request failed", { route: "POST /api/pages/[id]/recording/transcribe", name: "Error", code: "XX000" });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("synthetic detail");
  });
});

describe("GET /api/pages/{id}/recording/transcription", () => {
  it("answers the latest run, or run: null before the first one", async () => {
    const target = page();
    const { store } = memoryStore([target]);
    const d = deps("user-a", store, { engine: "fake", engines: ["fake"], dispatcher: dispatcher().dispatcher });
    const empty = await status(target.id, d);
    expect(empty.status).toBe(200);
    expect(empty.headers.get("cache-control")).toBe("private, no-store");
    expect(await empty.json()).toEqual({ run: null });
    const created = await (await start(target.id, {}, d)).json();
    const read = await status(target.id, d);
    expect(await read.json()).toEqual({ run: created.run });
  });

  it("answers the same 404 for others, the trash, unknown and malformed ids; 401 and 503 before the store", async () => {
    const theirs = page({ owner: "user-b" });
    const trashed = page({ deleted: true });
    const { store, calls } = memoryStore([theirs, trashed]);
    const results = [];
    for (const id of [theirs.id, trashed.id, randomUUID(), "not-a-uuid"]) results.push(await snapshot(await status(id, deps("user-a", store, null))));
    expect(results[0]?.status).toBe(404);
    for (const result of results.slice(1)) expect(result).toEqual(results[0]);
    calls.length = 0;
    expect((await status(theirs.id, deps(null, store, null))).status).toBe(401);
    expect((await status(theirs.id, deps("user-a", null, null))).status).toBe(503);
    expect(calls).toEqual([]);
  });
});

describe("GET /api/pages/{id}/recording with the transcription", () => {
  const recording: Recording = {
    revision: 1,
    source: "audio",
    language: "ja",
    engine: null,
    durationSec: null,
    sourceName: "合成.m4a",
    sourceSha256: null,
    segments: [],
    speakerNames: {},
    audio: { status: "uploaded", bytes: 3, contentType: "audio/mp4", expiresAt: null },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const run: TranscriptionRunView = {
    id: randomUUID(),
    status: "failed",
    engine: "fake",
    language: "ja",
    errorCode: "engine_unavailable",
    createdAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
  };
  const recordingsStore = (latest: TranscriptionRunView | null): RecordingsStore => ({
    createRecordingPage: async () => {
      throw new Error("not used");
    },
    getRecording: async (owner) => (owner === "user-a" ? recording : null),
    updateRecording: async () => null,
    latestTranscription: async () => (latest ? ({ ...latest, internal: "x" } as TranscriptionRunView) : null),
  });
  const get = (store: RecordingsStore, userId = "user-a") =>
    getRecordingRoute(request("GET", `/api/pages/${randomUUID()}/recording`), randomUUID(), { auth: () => authAs(userId), store: () => store });

  it("adds the latest run (only the documented fields), or null", async () => {
    const withRun = await (await get(recordingsStore(run))).json();
    // 音声の列・文字起こしの案・使えるエンジン（#36 段 3b-4）も同じ応答に入る
    expect(Object.keys(withRun).sort()).toEqual(["audios", "candidates", "defaultEngine", "engines", "recording", "speakers", "transcription"]);
    expect(withRun.defaultEngine).toBeNull();
    expect(withRun.transcription).toEqual(run);
    expect((await (await get(recordingsStore(null))).json()).transcription).toBeNull();
    expect((await get(recordingsStore(run), "user-b")).status).toBe(404);
  });
});
