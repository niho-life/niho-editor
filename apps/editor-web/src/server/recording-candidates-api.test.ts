import { randomUUID } from "node:crypto";
import type { Recording, RecordingCandidate, RecordingCandidateView, TranscriptionRunView } from "@niho/editor-store";
import { describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "../auth/types";
import type { TranscriptionDispatcher } from "../transcription/dispatch";
import {
  addCandidateRoute,
  adoptCandidateRoute,
  deleteCandidateRoute,
  getCandidateRoute,
  retryCandidateRoute,
  type CandidatesApiDeps,
  type CandidatesStore,
} from "./recording-candidates-api";

// 合成のユーザー ID・段落だけを使う

const ORIGIN = "http://editor.test";
const PAGE = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

const recording = (extra: Partial<Recording> = {}): Recording => ({
  revision: 2,
  source: "audio",
  language: "ja",
  engine: "deepgram",
  durationSec: 600,
  sourceName: "合成の会議.m4a",
  sourceSha256: null,
  segments: [{ start: 0, end: 4, text: "合成のはじめの段落", speaker: 1 }],
  speakerNames: { "1": "司会役" },
  audio: { status: "uploaded", bytes: 64, contentType: "audio/mp4", expiresAt: "2030-02-01T00:00:00.000Z" },
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
  ...extra,
});

const view = (extra: Partial<RecordingCandidateView> = {}): RecordingCandidateView => ({
  id: randomUUID(),
  name: "Deepgram",
  engine: "deepgram",
  language: "ja",
  durationSec: 600,
  adopted: true,
  state: "ready",
  segmentCount: 1,
  preview: ["合成のはじめの段落"],
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
  ...extra,
});

const run: TranscriptionRunView = {
  id: "7a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  status: "queued",
  engine: "fake",
  language: "ja",
  errorCode: null,
  createdAt: "2030-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
};

type Behaviour = {
  recording?: Recording | null;
  remove?: Awaited<ReturnType<CandidatesStore["deleteCandidate"]>>;
  candidates?: RecordingCandidateView[];
  full?: RecordingCandidate | null;
  add?: Awaited<ReturnType<CandidatesStore["addCandidate"]>>;
  adopt?: Awaited<ReturnType<CandidatesStore["adoptCandidate"]>>;
  enqueue?: Awaited<ReturnType<CandidatesStore["enqueue"]>>;
};

function memoryStore(behaviour: Behaviour = {}) {
  const calls: string[] = [];
  const names: string[] = [];
  // 作った案は一覧にも出る（route は作ったあとに読み直す）
  let listed: RecordingCandidateView[] = behaviour.candidates ?? [];
  const store: CandidatesStore = {
    getRecording: async () => {
      calls.push("getRecording");
      return behaviour.recording === undefined ? recording() : behaviour.recording;
    },
    listCandidates: async () => listed,
    getCandidate: async () => (behaviour.full === undefined ? null : behaviour.full),
    addCandidate: async (_owner, _pageId, input) => {
      calls.push("addCandidate");
      names.push(`${input.primaryName}/${input.name}/${input.engine}`);
      if (behaviour.add !== undefined) return behaviour.add;
      const candidate = view({ name: input.name, engine: input.engine, adopted: false, state: "pending", segmentCount: 0, preview: [], durationSec: null });
      listed = [...(listed.length > 0 ? listed : [view({ name: input.primaryName })]), candidate];
      return { status: "created", candidate, candidates: listed };
    },
    adoptCandidate: async () => {
      calls.push("adoptCandidate");
      return behaviour.adopt === undefined ? { status: "ok", recording: recording({ revision: 3 }), candidates: [view({ adopted: false }), view({ name: "Fake", adopted: true })] } : behaviour.adopt;
    },
    deleteCandidate: async (_owner, _pageId, candidateId) => {
      calls.push("deleteCandidate");
      if (behaviour.remove !== undefined) return behaviour.remove;
      listed = listed.filter((item) => item.id !== candidateId);
      return { status: "ok", candidates: listed };
    },
    enqueue: async (_owner, _pageId, input) => {
      calls.push(`enqueue:${input.candidate ?? "none"}`);
      return behaviour.enqueue === undefined ? { status: "created", run } : behaviour.enqueue;
    },
    failRun: async () => {
      calls.push("failRun");
      return true;
    },
  };
  return { store, calls, names };
}

const notUsed = async (): Promise<Response> => {
  throw new Error("the candidates API never calls the login routes");
};

function authAs(userId: string | null): AuthProvider {
  return { mode: "stub", getSession: async () => (userId ? { userId, mode: "stub" } : null), beginLogin: notUsed, completeLogin: notUsed, logout: notUsed };
}

function dispatcher(fail = false): TranscriptionDispatcher {
  return {
    kind: "inline",
    dispatch: async () => {
      if (fail) throw new Error("synthetic dispatch failure");
    },
  };
}

function deps(userId: string | null, store: CandidatesStore | null, extra: { runner?: CandidatesApiDeps["runner"] } = {}): CandidatesApiDeps {
  return {
    auth: () => authAs(userId),
    store: () => store,
    runner: extra.runner ?? (() => ({ engine: "fake", engines: ["fake"], dispatcher: dispatcher() })),
    env: {},
  };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const sameOrigin: Record<string, string> = method === "GET" ? {} : { origin: ORIGIN };
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { host: "editor.test", "content-type": "application/json", ...sameOrigin, ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

const add = (d: CandidatesApiDeps, body: unknown = {}, headers: Record<string, string> = {}) =>
  addCandidateRoute(request("POST", `/api/pages/${PAGE}/recording/candidates`, body, headers), PAGE, d);
const get = (d: CandidatesApiDeps, candidateId: string) =>
  getCandidateRoute(request("GET", `/api/pages/${PAGE}/recording/candidates/${candidateId}`), PAGE, candidateId, d);
const adopt = (d: CandidatesApiDeps, candidateId: string, headers: Record<string, string> = {}) =>
  adoptCandidateRoute(request("POST", `/api/pages/${PAGE}/recording/candidates/${candidateId}/adopt`, undefined, headers), PAGE, candidateId, d);
const remove = (d: CandidatesApiDeps, candidateId: string, headers: Record<string, string> = {}) =>
  deleteCandidateRoute(request("DELETE", `/api/pages/${PAGE}/recording/candidates/${candidateId}`, undefined, headers), PAGE, candidateId, d);
const retry = (d: CandidatesApiDeps, candidateId: string, headers: Record<string, string> = {}) =>
  retryCandidateRoute(request("POST", `/api/pages/${PAGE}/recording/candidates/${candidateId}/transcribe`, undefined, headers), PAGE, candidateId, d);

describe("POST /api/pages/{id}/recording/candidates", () => {
  it("案を作って実行を積み、名前はエンジンの名前（同じ名前があれば数を足す）", async () => {
    const { store, calls, names } = memoryStore();
    const response = await add(deps("user-a", store));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.candidate).toEqual({
      id: expect.any(String),
      name: "開発の偽物",
      engine: "fake",
      engineLabel: "開発の偽物",
      language: "ja",
      durationSec: null,
      adopted: false,
      state: "pending",
      segmentCount: 0,
      preview: [],
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(body.run).toEqual(run);
    expect(body.cannotStart).toBeNull();
    expect(body.candidates).toHaveLength(2);
    // 1 つ目の案には、いまの文字起こしのエンジンの名前を付ける
    expect(names).toEqual(["Deepgram/開発の偽物/fake"]);
    expect(calls).toEqual(["getRecording", "addCandidate", `enqueue:${body.candidate.id}`]);

    // 同じ名前の案があれば数を足す
    const second = memoryStore({ candidates: [view(), view({ name: "開発の偽物", adopted: false })] });
    await add(deps("user-a", second.store));
    expect(second.names).toEqual(["Deepgram/開発の偽物 2/fake"]);
  });

  it("実行を積めない事情のときも案は残し、理由を返す（画面は「もう一度」で積み直せる）", async () => {
    const { store } = memoryStore({ enqueue: { status: "audio_not_ready" } });
    const response = await add(deps("user-a", store));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.run).toBeNull();
    expect(body.cannotStart).toBe("audio_not_ready");
    expect(body.candidate.state).toBe("pending");
  });

  it("別の案・正本に書く実行が走っているときは、新しい案の実行は始まっていないと返す（案は残る）", async () => {
    const run = { id: "11111111-1111-4111-8111-111111111111", status: "running", engine: "fake", language: "ja", errorCode: null, createdAt: "2030-01-01T00:00:00.000Z", startedAt: null, finishedAt: null } as const;
    for (const elsewhere of [null, "33333333-3333-4333-8333-333333333333"]) {
      const { store } = memoryStore({ enqueue: { status: "existing", run, candidate: elsewhere } });
      const response = await add(deps("user-a", store));
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.run).toBeNull();
      expect(body.cannotStart).toBe("other_run_active");
      expect(body.candidate.state).toBe("pending");
    }
  });

  it("積み込みが失敗したら run を失敗にする（案は残る）", async () => {
    const { store, calls } = memoryStore();
    const response = await add(deps("user-a", store, { runner: () => ({ engine: "fake", engines: ["fake"], dispatcher: dispatcher(true) }) }));
    expect(response.status).toBe(202);
    expect(calls).toContain("failRun");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    log.mockRestore();
  });

  it("案の数の上限は 409、録音が無ければ 404、文字起こしが使えなければ 503", async () => {
    const tooMany = memoryStore({ add: { status: "too_many" } });
    const over = await add(deps("user-a", tooMany.store));
    expect(over.status).toBe(409);
    expect(await over.json()).toEqual({ error: "too_many" });

    const { store } = memoryStore({ recording: null });
    expect((await add(deps("user-a", store))).status).toBe(404);
    const missing = memoryStore({ add: null });
    expect((await add(deps("user-a", missing.store))).status).toBe(404);
    expect((await add(deps("user-a", memoryStore().store, { runner: () => null }))).status).toBe(503);
    expect((await add(deps("user-a", null))).status).toBe(503);
  });

  it("未認証は 401、別の origin は 403、知らない項目・使えないエンジンは 400", async () => {
    const { store, calls } = memoryStore();
    expect((await add(deps(null, store))).status).toBe(401);
    expect((await add(deps("user-a", store), {}, { origin: "http://evil.test" })).status).toBe(403);
    // 鍵の無いエンジンは選べない（この server は fake だけ）
    const wrongEngine = await add(deps("user-a", store), { engine: "deepgram" });
    expect(wrongEngine.status).toBe(400);
    expect(await wrongEngine.json()).toEqual({ error: "bad_request", reason: "engine" });
    const unknownKey = await add(deps("user-a", store), { lang: "ja" });
    expect(unknownKey.status).toBe(400);
    expect(await unknownKey.json()).toEqual({ error: "bad_request", reason: "body" });
    expect(calls).toEqual([]);
  });

  it("使えるエンジンを選べる（案と run に記録する）", async () => {
    const { store, calls, names } = memoryStore();
    const runner = () => ({ engine: "deepgram" as const, engines: ["deepgram" as const, "gemini" as const], dispatcher: dispatcher() });
    const response = await add(deps("user-a", store, { runner }), { engine: "gemini" });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.candidate.engine).toBe("gemini");
    expect(body.candidate.name).toBe("Gemini");
    expect(body.candidate.engineLabel).toBe("Gemini");
    // 1 つ目の案は、いまの文字起こしのエンジン（Deepgram）の名前
    expect(names).toEqual(["Deepgram/Gemini/gemini"]);
    expect(calls).toContain(`enqueue:${body.candidate.id}`);
  });
});

describe("GET・採用・もう一度（/recording/candidates/{candidateId}）", () => {
  const id = "8b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

  it("案 1 つを本文つきで返す（無ければ 404）", async () => {
    const full: RecordingCandidate = {
      ...view({ id, name: "Fake", adopted: false }),
      segments: [{ start: 0, end: 5, text: "別のエンジンの段落", speaker: 1 }],
      speakerNames: { "1": "話し手" },
    };
    const { store } = memoryStore({ full });
    const response = await get(deps("user-a", store), id);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.candidate.segments).toEqual([{ start: 0, end: 5, text: "別のエンジンの段落", speaker: 1 }]);
    expect(body.candidate.speakerNames).toEqual({ "1": "話し手" });
    expect(body.candidate.engineLabel).toBe("Deepgram");
    expect((await get(deps("user-a", memoryStore({ full: null }).store), id)).status).toBe(404);
    expect((await get(deps(null, store), id)).status).toBe(401);
  });

  it("採用すると録音と話者と案の一覧を返す（本文のできていない案は 409）", async () => {
    const { store, calls } = memoryStore();
    const response = await adopt(deps("user-a", store), id);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recording.revision).toBe(3);
    expect(body.speakers).toEqual([{ speaker: 1, name: "司会役", count: 1 }]);
    expect(body.candidates.map((item: { name: string; adopted: boolean }) => [item.name, item.adopted])).toEqual([
      ["Deepgram", false],
      ["Fake", true],
    ]);
    expect(calls).toEqual(["adoptCandidate"]);

    const notReady = memoryStore({ adopt: { status: "not_ready" } });
    const refused = await adopt(deps("user-a", notReady.store), id);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "not_ready" });
    expect((await adopt(deps("user-a", memoryStore({ adopt: null }).store), id)).status).toBe(404);
    expect((await adopt(deps(null, store), id)).status).toBe(401);
    expect((await adopt(deps("user-a", store), id, { origin: "http://evil.test" })).status).toBe(403);
  });

  it("案を消すと、残った案を返す（採用中・実行中は 409）", async () => {
    const { store, calls } = memoryStore({ candidates: [view(), view({ id, name: "Fake", adopted: false })] });
    const response = await remove(deps("user-a", store), id);
    expect(response.status).toBe(200);
    expect((await response.json()).candidates.map((item: { name: string }) => item.name)).toEqual(["Deepgram"]);
    expect(calls).toEqual(["deleteCandidate"]);

    for (const status of ["adopted", "running"] as const) {
      const refused = await remove(deps("user-a", memoryStore({ remove: { status } }).store), id);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: status });
    }
    expect((await remove(deps("user-a", memoryStore({ remove: null }).store), id)).status).toBe(404);
    expect((await remove(deps(null, store), id)).status).toBe(401);
    expect((await remove(deps("user-a", store), id, { origin: "http://evil.test" })).status).toBe(403);
  });

  it("「もう一度」はその案の実行を積む（始められない理由は 409）", async () => {
    const full: RecordingCandidate = { ...view({ id, adopted: false, state: "failed", segmentCount: 0, preview: [] }), segments: [], speakerNames: {} };
    const { store, calls } = memoryStore({ full });
    const response = await retry(deps("user-a", store), id);
    expect(response.status).toBe(202);
    expect((await response.json()).run).toEqual(run);
    expect(calls).toEqual([`enqueue:${id}`]);

    const busy = memoryStore({ full, enqueue: { status: "audio_expired" } });
    const refused = await retry(deps("user-a", busy.store), id);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "cannot_start", reason: "audio_expired" });
    // この案の実行が既に走っているなら、そのまま返す
    const existing = memoryStore({ full, enqueue: { status: "existing", run, candidate: id } });
    expect((await retry(deps("user-a", existing.store), id)).status).toBe(202);
    // 走っているのが別の案・正本に書く実行なら、この案の実行は始まっていない（始まったと言わない）
    for (const other of [null, "33333333-3333-4333-8333-333333333333"]) {
      const elsewhere = memoryStore({ full, enqueue: { status: "existing", run, candidate: other } });
      const blocked = await retry(deps("user-a", elsewhere.store), id);
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toEqual({ error: "cannot_start", reason: "other_run_active" });
    }
    // 案が無い
    expect((await retry(deps("user-a", memoryStore({ full: null }).store), id)).status).toBe(404);
    expect((await retry(deps(null, store), id)).status).toBe(401);
    expect((await retry(deps("user-a", store), id, { origin: "http://evil.test" })).status).toBe(403);
  });
});
