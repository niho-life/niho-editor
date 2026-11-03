import { describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "../auth/types";
import { getMacTranscriptionRoute, mutateMacTranscriptionRoute, type MacTranscriptionApiDeps, type MacTranscriptionStore } from "./mac-transcription-api";

const ORIGIN = "http://editor.test";
const PAGE = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const OPERATION = "00000000-0000-4000-8000-000000000003";
const CANDIDATE = "00000000-0000-4000-8000-000000000004";
const notUsed = async (): Promise<Response> => { throw new Error("not used"); };

function auth(userId: string | null): AuthProvider {
  return { mode: "stub", getSession: async () => userId ? { userId, mode: "stub" } : null, beginLogin: notUsed, completeLogin: notUsed, logout: notUsed };
}

function run(status: "created" | "existing" = "created") {
  return {
    status,
    run: { id: RUN, status: "running" as const, engine: "gemini-cli" as const, executor: "mac-cli" as const, language: "ja" as const, errorCode: null, createdAt: new Date(0).toISOString(), startedAt: new Date(0).toISOString(), finishedAt: null },
    generation: 1,
    operationId: OPERATION,
    settings: { model: "gemini-3.8-flash" as const, effort: "low" as const, targetSec: 600 as const },
    audioManifest: [{ partIndex: 0, bytes: 64, contentType: "audio/mp4", sha256: "a".repeat(64), durationSec: 600, offsetSec: 0 }],
    candidateId: null,
  };
}

function setup(userId: string | null = "owner-a") {
  const calls: unknown[][] = [];
  const store: MacTranscriptionStore = {
    getRecording: async () => null,
    listCandidates: async () => [],
    addCandidate: async () => null,
    start: async (...args) => { calls.push(["start", ...args]); return run(); },
    status: async (owner, pageId) => { calls.push(["status", owner, pageId]); return run("existing"); },
    finish: async (...args) => { calls.push(["finish", ...args]); return "succeeded"; },
    resume: async (...args) => { calls.push(["resume", ...args]); return run("existing"); },
    fail: async (...args) => { calls.push(["fail", ...args]); return true; },
  };
  const deps: MacTranscriptionApiDeps = { auth: () => auth(userId), store: () => store, env: {} };
  return { deps, calls, store };
}

function request(method: "GET" | "POST", body?: unknown, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/pages/${PAGE}/recording/transcription/mac`, {
    method,
    headers: { host: "editor.test", ...(method === "POST" ? { origin, "content-type": "application/json" } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Mac Gemini CLI transcription API", () => {
  it("starts for the authenticated owner without a provider key and returns the fixed settings/audio manifest", async () => {
    const { deps, calls } = setup();
    const response = await mutateMacTranscriptionRoute(request("POST", { action: "start", operationId: OPERATION }), PAGE, deps);
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({ run: { id: RUN, engine: "gemini-cli", executor: "mac-cli" }, settings: { model: "gemini-3.8-flash", effort: "low", targetSec: 600 } });
    expect(calls[0]).toEqual(["start", "owner-a", PAGE, { operationId: OPERATION, terms: [] }]);
  });

  it("requires owner and same origin, and never calls the store for a rejected mutation", async () => {
    const signedOut = setup(null);
    expect((await mutateMacTranscriptionRoute(request("POST", { action: "start", operationId: OPERATION }), PAGE, signedOut.deps)).status).toBe(401);
    const cross = setup();
    expect((await mutateMacTranscriptionRoute(request("POST", { action: "start", operationId: OPERATION }, "https://other.invalid"), PAGE, cross.deps)).status).toBe(403);
    expect(cross.calls).toEqual([]);
  });

  it("creates a separate candidate when canonical transcript text already exists", async () => {
    const { deps, store } = setup();
    store.start = vi.fn()
      .mockResolvedValueOnce({ status: "has_transcript" })
      .mockResolvedValueOnce({ ...run(), candidateId: CANDIDATE });
    store.getRecording = async () => ({ language: "ja", engine: "deepgram" }) as never;
    store.listCandidates = async () => [];
    store.addCandidate = vi.fn().mockResolvedValue({ status: "created", candidate: { id: CANDIDATE, name: "Gemini（このMacのCLI）" }, candidates: [] });
    const response = await mutateMacTranscriptionRoute(request("POST", { action: "start", operationId: OPERATION }), PAGE, deps);
    expect(response.status).toBe(202);
    expect(store.addCandidate).toHaveBeenCalledWith("owner-a", PAGE, expect.objectContaining({ engine: "gemini-cli" }));
    expect(store.start).toHaveBeenLastCalledWith("owner-a", PAGE, { operationId: OPERATION, candidate: CANDIDATE, terms: [] });
    expect(await response.json()).toMatchObject({ candidateId: CANDIDATE });
  });

  it("normalizes and completes only the matching run, supports idempotent completion and rejects stale results", async () => {
    const { deps, calls, store } = setup();
    const complete = { action: "complete", operationId: OPERATION, runId: RUN, generation: 1, segments: [{ start: 2, end: 3, text: " 合成の発言 ", speaker: 0 }], durationSec: 600 };
    expect((await mutateMacTranscriptionRoute(request("POST", complete), PAGE, deps)).status).toBe(200);
    const output = calls.find((call) => call[0] === "finish")?.at(-1) as { segments: Array<{ speaker: number; text: string }> };
    expect(output.segments).toEqual([{ start: 2, end: 3, text: "合成の発言", speaker: 1 }]);
    vi.spyOn(store, "finish").mockResolvedValueOnce("succeeded");
    expect((await mutateMacTranscriptionRoute(request("POST", complete), PAGE, deps)).status).toBe(200);
    vi.spyOn(store, "finish").mockResolvedValueOnce("stale");
    expect((await mutateMacTranscriptionRoute(request("POST", complete), PAGE, deps)).status).toBe(409);
  });

  it("reads only the owner's latest Mac run and resumes/stops with operation and generation guards", async () => {
    const { deps, calls } = setup();
    expect((await getMacTranscriptionRoute(request("GET"), PAGE, deps)).status).toBe(200);
    expect((await mutateMacTranscriptionRoute(request("POST", { action: "resume", operationId: OPERATION, runId: RUN, generation: 1 }), PAGE, deps)).status).toBe(200);
    expect((await mutateMacTranscriptionRoute(request("POST", { action: "stop", operationId: OPERATION, runId: RUN, generation: 2 }), PAGE, deps)).status).toBe(200);
    expect(calls).toContainEqual(["status", "owner-a", PAGE]);
    expect(calls).toContainEqual(["resume", "owner-a", PAGE, RUN, OPERATION, 1]);
    expect(calls).toContainEqual(["fail", "owner-a", PAGE, RUN, OPERATION, 2, "stopped"]);
  });
});
