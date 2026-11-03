import { describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "../auth/types";
import { getMacLocalTranscriptionRoute, mutateMacLocalTranscriptionRoute, type MacLocalTranscriptionApiDeps, type MacLocalTranscriptionStore } from "./mac-local-transcription-api";

const ORIGIN = "http://editor.test";
const PAGE = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const OPERATION = "00000000-0000-4000-8000-000000000003";
const CANDIDATE = "00000000-0000-4000-8000-000000000004";
const notUsed = async (): Promise<Response> => { throw new Error("not used"); };

function auth(userId: string | null): AuthProvider {
  return { mode: "stub", getSession: async () => userId ? { userId, mode: "stub" } : null, beginLogin: notUsed, completeLogin: notUsed, logout: notUsed };
}

function localRun(status: "created" | "existing" = "created") {
  return {
    status,
    run: { id: RUN, status: "running" as const, engine: "apple-local" as const, executor: "mac-local" as const, language: "ja" as const, errorCode: null, createdAt: new Date(0).toISOString(), startedAt: new Date(0).toISOString(), finishedAt: null },
    generation: 1,
    operationId: OPERATION,
    settings: { engine: "apple-speech" as const, speakerMode: "auto" as const },
    audioManifest: [{ partIndex: 0, bytes: 64, contentType: "audio/mp4", sha256: "a".repeat(64), durationSec: 60, offsetSec: 0 }],
    candidateId: null,
  };
}

function setup(userId: string | null = "owner-a") {
  const calls: unknown[][] = [];
  const store: MacLocalTranscriptionStore = {
    getRecording: async () => null,
    start: async (...args) => { calls.push(["start", ...args]); return localRun(); },
    status: async (...args) => { calls.push(["status", ...args]); return localRun("existing"); },
    finish: async (...args) => { calls.push(["finish", ...args]); return "succeeded"; },
    resume: async (...args) => { calls.push(["resume", ...args]); return localRun("existing"); },
    fail: async (...args) => { calls.push(["fail", ...args]); return true; },
  };
  return { calls, store, deps: { auth: () => auth(userId), store: () => store, env: {} } satisfies MacLocalTranscriptionApiDeps };
}

function request(method: "GET" | "POST", body?: unknown, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/pages/${PAGE}/recording/transcription/mac-local`, {
    method,
    headers: { host: "editor.test", ...(method === "POST" ? { origin, "content-type": "application/json" } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Apple on-device transcription API", () => {
  it("starts a dedicated mac-local/apple-local run with fixed settings", async () => {
    const { deps, calls } = setup();
    const response = await mutateMacLocalTranscriptionRoute(request("POST", { action: "start", operationId: OPERATION }), PAGE, deps);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ run: { engine: "apple-local", executor: "mac-local" }, settings: { engine: "apple-speech", speakerMode: "auto" } });
    expect(calls[0]).toEqual(["start", "owner-a", PAGE, { operationId: OPERATION }]);
  });

  it("requires authentication and same origin before touching the store", async () => {
    const signedOut = setup(null);
    expect((await mutateMacLocalTranscriptionRoute(request("POST", { action: "start", operationId: OPERATION }), PAGE, signedOut.deps)).status).toBe(401);
    const cross = setup();
    expect((await mutateMacLocalTranscriptionRoute(request("POST", { action: "start", operationId: OPERATION }, "https://other.invalid"), PAGE, cross.deps)).status).toBe(403);
    expect(cross.calls).toEqual([]);
  });

  it("delegates candidate and run creation to one atomic store start", async () => {
    const { deps, store } = setup();
    store.start = vi.fn().mockResolvedValueOnce({ ...localRun(), candidateId: CANDIDATE });
    const response = await mutateMacLocalTranscriptionRoute(request("POST", { action: "start", operationId: OPERATION }), PAGE, deps);
    expect(response.status).toBe(202);
    expect(store.start).toHaveBeenCalledOnce();
    expect(store.start).toHaveBeenCalledWith("owner-a", PAGE, { operationId: OPERATION });
  });

  it("normalizes output, accepts saved-response replay, and rejects stale/changed late results", async () => {
    const { deps, calls, store } = setup();
    const complete = { action: "complete", operationId: OPERATION, runId: RUN, generation: 1, segments: [{ start: 2, end: 3, text: " 合成の発言 ", speaker: 1 }], durationSec: 60 };
    expect((await mutateMacLocalTranscriptionRoute(request("POST", complete), PAGE, deps)).status).toBe(200);
    expect((calls.find((call) => call[0] === "finish")?.at(-1) as { segments: unknown[] }).segments).toEqual([{ start: 2, end: 3, text: "合成の発言", speaker: 1 }]);
    vi.spyOn(store, "finish").mockResolvedValueOnce("succeeded");
    expect((await mutateMacLocalTranscriptionRoute(request("POST", complete), PAGE, deps)).status).toBe(200);
    vi.spyOn(store, "finish").mockResolvedValueOnce("superseded");
    const changed = await mutateMacLocalTranscriptionRoute(request("POST", complete), PAGE, deps);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: "recording_changed" });
  });

  it("scopes status/resume/stop to owner, page, operation and generation", async () => {
    const { deps, calls } = setup();
    expect((await getMacLocalTranscriptionRoute(request("GET"), PAGE, deps)).status).toBe(200);
    expect((await mutateMacLocalTranscriptionRoute(request("POST", { action: "resume", operationId: OPERATION, runId: RUN, generation: 1 }), PAGE, deps)).status).toBe(200);
    expect((await mutateMacLocalTranscriptionRoute(request("POST", { action: "stop", operationId: OPERATION, runId: RUN, generation: 2 }), PAGE, deps)).status).toBe(200);
    expect(calls).toContainEqual(["status", "owner-a", PAGE]);
    expect(calls).toContainEqual(["resume", "owner-a", PAGE, RUN, OPERATION, 1]);
    expect(calls).toContainEqual(["fail", "owner-a", PAGE, RUN, OPERATION, 2, "stopped"]);
  });

  it("returns 404 for another owner's page and 200/null for an owned page without a run", async () => {
    const other = setup();
    other.store.status = async () => null;
    other.store.getRecording = async () => null;
    expect((await getMacLocalTranscriptionRoute(request("GET"), PAGE, other.deps)).status).toBe(404);

    const owned = setup();
    owned.store.status = async () => null;
    owned.store.getRecording = async () => ({ id: PAGE }) as never;
    const response = await getMacLocalTranscriptionRoute(request("GET"), PAGE, owned.deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ run: null });
  });
});
