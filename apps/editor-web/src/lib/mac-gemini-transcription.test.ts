import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellBridge } from "niho-desktop-bridge/shell-bridge";
import type { ShellAiEvent } from "niho-desktop-bridge/shell-contract";
import { MacGeminiTranscriptionError, runMacGeminiTranscription, type MacGeminiCheckpoint } from "./mac-gemini-transcription";

const PAGE = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const OP = "00000000-0000-4000-8000-000000000003";
const manifest = [
  { partIndex: 0, bytes: 4, contentType: "audio/mp4", sha256: "a".repeat(64), durationSec: 600, offsetSec: 0 },
  { partIndex: 1, bytes: 4, contentType: "audio/mp4", sha256: "b".repeat(64), durationSec: 300, offsetSec: 600 },
];

function runBody(status: "running" | "failed" | "succeeded" = "running", generation = 1) {
  return {
    run: { id: RUN, status, engine: "gemini-cli", executor: "mac-cli", language: "ja", errorCode: status === "failed" ? "stopped" : null },
    generation,
    operationId: OP,
    settings: { model: "gemini-3.8-flash", effort: "low", targetSec: 600 },
    audioManifest: manifest,
    candidateId: null,
  };
}

function runFingerprint(): string {
  const value = runBody();
  return JSON.stringify({
    pageId: PAGE,
    runId: RUN,
    operationId: OP,
    language: value.run.language,
    candidateId: value.candidateId,
    settings: value.settings,
    audioManifest: manifest,
  });
}

function done(text: string, stop_reason: "EndTurn" | "MaxTokens" | "Stopped" = "EndTurn"): ShellAiEvent {
  return { type: "Done", text, stop_reason, session_id: null, usage: { input_tokens: 10, output_tokens: 20, cost_usd: null, model_used: "gemini-3.8-flash", cost_known: false }, duration_ms: 1, continuations: 0 };
}

function setup(options: {
  checkpoint?: MacGeminiCheckpoint | Record<string, unknown> | null;
  checkpointReadFailure?: boolean;
  turns?: ShellAiEvent[];
  completeConflict?: boolean;
  completeNetworkFailure?: boolean;
  resumeConflict?: boolean;
  startStatus?: "running" | "failed" | "succeeded";
  unavailable?: boolean;
  afterTurn?: () => void;
  gappedParts?: boolean;
  overflowingAudio?: boolean;
} = {}) {
  let stored = options.checkpoint ?? null;
  const calls: Array<[string, ...unknown[]]> = [];
  const turns = [...(options.turns ?? [done("[00:02] 話者A: 一つ目の発言です。十分な長さの合成文です。"), done("[00:03] 話者A: 二つ目の発言です。十分な長さの合成文です。")])];
  const shell = {
    capabilities: async () => ({ version: "test", dev: true, features: { recording: true, localTranscription: true, cliAi: true, geminiCliTranscription: true } }),
    aiEngines: async () => [{ engine: "cli:antigravity", installed: !options.unavailable, authenticated: !options.unavailable, reason: null, models: options.unavailable ? [] : ["gemini-3.8-flash"], effort: true, resume: false }],
    geminiAudioBegin: async (...args: unknown[]) => { calls.push(["begin", ...args]); return { receivedBytes: 0, complete: false }; },
    geminiAudioChunk: async (_job: string, part: number, offset: number, chunk: Uint8Array) => { calls.push(["chunk", part, offset, chunk.byteLength]); return offset + chunk.byteLength; },
    geminiAudioFinish: async (...args: unknown[]) => { calls.push(["finish", ...args]); },
    geminiPrepare: async (...args: unknown[]) => {
      calls.push(["prepare", ...args.slice(0, 2)]);
      return [
        { durationSec: 600, parts: [{ startSec: 0, endSec: 600, soundSec: 50 }] },
        { durationSec: 300, parts: [{ startSec: 0, endSec: 300, soundSec: 40 }] },
      ];
    },
    geminiTranscribePart: async (...args: unknown[]) => {
      calls.push(["turn", args[2], args[3], args[5]]);
      const result = { finalEvent: turns.shift() ?? done("[00:01] 予備の発言です。") };
      options.afterTurn?.();
      return result;
    },
    geminiCheckpointRead: async () => {
      if (options.checkpointReadFailure) throw new Error("synthetic checkpoint read failure");
      return stored;
    },
    geminiCheckpointWrite: async (_job: string, value: unknown) => { stored = value as MacGeminiCheckpoint; calls.push(["checkpoint"]); },
    geminiStop: async () => true,
    geminiDiscard: async () => { calls.push(["discard"]); },
  } as unknown as ShellBridge;
  const completed: unknown[] = [];
  const failed: unknown[] = [];
  const rangeCancelled = vi.fn();
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/recording/audio?part=")) {
      const range = String(new Headers(init?.headers).get("range"));
      const match = /bytes=(\d+)-(\d+)/.exec(range)!;
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = options.overflowingAudio
        ? new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new Uint8Array(end - start + 2)); },
          cancel() { rangeCancelled(); },
        }, { highWaterMark: 0 })
        : Uint8Array.from({ length: end - start + 1 }, () => 1);
      return new Response(body, {
        status: 206,
        headers: { "content-type": "audio/mp4", "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/4` },
      });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body?.action === "complete") {
      completed.push(body);
      if (options.completeNetworkFailure) throw new TypeError("synthetic network failure");
      return options.completeConflict
        ? Response.json({ error: "recording_changed" }, { status: 409 })
        : Response.json({ status: "succeeded" });
    }
    if (body?.action === "fail" || body?.action === "stop") { failed.push(body); return Response.json({ status: "failed" }); }
    if (body?.action === "resume") {
      return options.resumeConflict
        ? Response.json({ error: "stale_run" }, { status: 409 })
        : Response.json(runBody("running", 2));
    }
    const run = runBody(options.startStatus ?? (options.resumeConflict ? "failed" : "running"));
    if (options.gappedParts) run.audioManifest = manifest.map((part, index) => ({ ...part, partIndex: index === 1 ? 3 : 0 }));
    return Response.json(run);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { shell, calls, completed, failed, fetchMock, rangeCancelled, get checkpoint() { return stored; } };
}

afterEach(() => vi.unstubAllGlobals());

describe("Mac Gemini CLI transcription orchestration", () => {
  it("uses actual server part numbers and dense native file indices after a cancelled upload leaves a gap", async () => {
    const f = setup({ gappedParts: true });
    await runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined });
    expect(f.fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/recording/audio?")))
      .toEqual([`/api/pages/${PAGE}/recording/audio?part=0`, `/api/pages/${PAGE}/recording/audio?part=3`]);
    expect(f.calls.filter(([name]) => name === "begin").map((call) => call[2])).toEqual([0, 1]);
    expect((f.completed[0] as { segments: Array<{ start: number }> }).segments.map((segment) => segment.start)).toEqual([2, 603]);
  });

  it("cancels an oversized audio stream before forwarding any chunk to native", async () => {
    const f = setup({ overflowingAudio: true });
    await expect(runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "changed" });
    expect(f.rangeCancelled).toHaveBeenCalledOnce();
    expect(f.calls.some(([name]) => name === "chunk" || name === "turn")).toBe(false);
  });

  it("streams bounded authenticated ranges, keeps the original multi-audio offsets, passes reference lines and saves once", async () => {
    const f = setup();
    await runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined });
    expect(f.calls.filter(([name]) => name === "chunk")).toEqual([["chunk", 0, 0, 4], ["chunk", 1, 0, 4]]);
    const turnCalls = f.calls.filter(([name]) => name === "turn");
    expect(turnCalls).toHaveLength(2);
    expect(String(turnCalls[1]?.[3])).toContain("話者A: 一つ目の発言です");
    expect(f.completed).toHaveLength(1);
    const saved = f.completed[0] as { segments: Array<{ start: number; speaker: number; text: string }>; durationSec: number };
    expect(saved.segments.map((item) => item.start)).toEqual([2, 603]);
    expect(saved.segments.map((item) => item.speaker)).toEqual([0, 0]);
    expect(saved.durationSec).toBe(900);
    expect(f.calls.at(-1)).toEqual(["discard"]);
  });

  it("resumes after the last completed part and does not rerun it", async () => {
    const fingerprint = runFingerprint();
    const previous: MacGeminiCheckpoint = {
      schemaVersion: 1, pageId: PAGE, runId: RUN, operationId: OP, generation: 1, revision: 1, previousRevision: 0, fingerprint,
      completed: [{ file: 0, part: 0, text: "[00:02] 話者A: すでに終わった区切りです。", startSec: 0, endSec: 600, referenceLines: [] }],
      pendingOutput: null, state: "failed",
    };
    const f = setup({ checkpoint: previous, turns: [done("[00:03] 話者A: 再開した後半の発言です。十分な長さです。")] });
    await runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, operationId: OP, signal: new AbortController().signal, onProgress: () => undefined });
    expect(f.calls.filter(([name]) => name === "turn")).toHaveLength(1);
    expect((f.completed[0] as { segments: unknown[] }).segments).toHaveLength(2);
  });

  it("retries only saving when a pending result exists", async () => {
    const fingerprint = runFingerprint();
    const pendingOutput = { segments: [{ start: 2, end: 2, text: "保存待ち", speaker: 0 }], durationSec: 900 };
    const f = setup({ checkpoint: { schemaVersion: 1, pageId: PAGE, runId: RUN, operationId: OP, generation: 1, revision: 1, previousRevision: 0, fingerprint, completed: [], pendingOutput, state: "saving" } });
    await runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, operationId: OP, signal: new AbortController().signal, onProgress: () => undefined });
    expect(f.completed).toHaveLength(1);
    expect(f.calls.some(([name]) => name === "begin" || name === "prepare" || name === "turn")).toBe(false);
  });

  it("finishes an already-succeeded start response without probing or starting the CLI", async () => {
    const f = setup({ startStatus: "succeeded", unavailable: true });
    await runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, operationId: OP, signal: new AbortController().signal, onProgress: () => undefined });
    expect(f.calls).toEqual([["discard"]]);
  });

  it("retries a pending server save even when the CLI is unavailable", async () => {
    const fingerprint = runFingerprint();
    const pendingOutput = { segments: [{ start: 2, end: 2, text: "保存待ち", speaker: 0 }], durationSec: 900 };
    const f = setup({ unavailable: true, checkpoint: { schemaVersion: 1, pageId: PAGE, runId: RUN, operationId: OP, generation: 1, revision: 1, previousRevision: 0, fingerprint, completed: [], pendingOutput, state: "saving" } });
    await expect(runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, operationId: OP, signal: new AbortController().signal, onProgress: () => undefined })).resolves.toBeUndefined();
    expect(f.completed).toHaveLength(1);
    expect(f.calls.some(([name]) => name === "prepare" || name === "turn")).toBe(false);
  });

  it("keeps a failed save as saving and does not fail the possibly-completed server run", async () => {
    const f = setup({ completeNetworkFailure: true });
    await expect(runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "saving" } satisfies Partial<MacGeminiTranscriptionError>);
    expect(f.failed).toHaveLength(0);
    expect(f.checkpoint).toMatchObject({ state: "saving", pendingOutput: { durationSec: 900 } });
  });

  it("rejects a malformed pending checkpoint without overwriting it or rerunning the CLI", async () => {
    const fingerprint = runFingerprint();
    const malformed = { schemaVersion: 1, pageId: PAGE, runId: RUN, operationId: OP, generation: 1, revision: 1, previousRevision: 0, fingerprint, completed: [], pendingOutput: { segments: [{ start: -1, end: 2, text: "残す", speaker: 0 }], durationSec: 900 }, state: "saving" };
    const f = setup({ checkpoint: malformed });
    await expect(runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "checkpoint" } satisfies Partial<MacGeminiTranscriptionError>);
    expect(f.checkpoint).toBe(malformed);
    expect(f.calls.some(([name]) => name === "checkpoint" || name === "prepare" || name === "turn")).toBe(false);
  });

  it("does not start with an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = setup();
    await expect(runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, signal: controller.signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "stopped" } satisfies Partial<MacGeminiTranscriptionError>);
    expect(f.calls).toEqual([]);
    expect(f.completed).toHaveLength(0);
  });

  it("fails the server run when native checkpoint reading fails after start", async () => {
    const f = setup({ checkpointReadFailure: true });
    await expect(runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined })).rejects.toThrow();
    expect(f.failed).toHaveLength(1);
    expect(f.failed[0]).toMatchObject({ action: "fail", runId: RUN, generation: 1 });
  });

  it("does not complete when stop wins after the last part returns", async () => {
    const controller = new AbortController();
    let turns = 0;
    const f = setup({ afterTurn: () => { turns += 1; if (turns === 2) controller.abort(); } });
    await expect(runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, signal: controller.signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "stopped" } satisfies Partial<MacGeminiTranscriptionError>);
    expect(f.completed).toHaveLength(0);
    expect(f.failed[0]).toMatchObject({ action: "stop" });
  });

  it("does not retry a CLI usage limit as a short response", async () => {
    const f = setup({ turns: [{ type: "Error", reason_code: "UsageLimitReached", message: "limit" }] });
    await expect(runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "usage" } satisfies Partial<MacGeminiTranscriptionError>);
    expect(f.calls.filter(([name]) => name === "turn")).toHaveLength(1);
  });

  it("does not treat MaxTokens as success and retains a retryable checkpoint", async () => {
    const f = setup({ turns: [done("途中", "MaxTokens"), done("途中", "MaxTokens"), done("途中", "MaxTokens")] });
    await expect(runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "incomplete" } satisfies Partial<MacGeminiTranscriptionError>);
    expect(f.completed).toHaveLength(0);
    expect(f.failed).toHaveLength(1);
    expect(f.checkpoint).toMatchObject({ state: "failed", completed: [] });
  });

  it.each([
    { name: "silent output", text: "" },
    { name: "too-short output", text: "短い出力" },
  ])("does not save $name as a successful transcript", async ({ text }) => {
    const f = setup({ turns: [done(text), done(text), done(text)] });
    f.shell.geminiPrepare = async () => [
      { durationSec: 600, parts: [{ startSec: 0, endSec: 600, soundSec: 90 }] },
      { durationSec: 300, parts: [{ startSec: 0, endSec: 300, soundSec: 40 }] },
    ];
    await expect(runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "incomplete" } satisfies Partial<MacGeminiTranscriptionError>);
    expect(f.completed).toHaveLength(0);
    expect(f.calls.filter(([name]) => name === "turn")).toHaveLength(3);
  });

  it("fails a terminal CLI error and reports an explicit stop without saving either result", async () => {
    const cli = setup({ turns: [{ type: "Error", reason_code: "CliFailed", message: "synthetic" }] });
    await expect(runMacGeminiTranscription({ shell: cli.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "failed" } satisfies Partial<MacGeminiTranscriptionError>);
    expect(cli.completed).toHaveLength(0);
    expect(cli.failed).toHaveLength(1);

    const stopped = setup({ turns: [done("", "Stopped")] });
    await expect(runMacGeminiTranscription({ shell: stopped.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "stopped" } satisfies Partial<MacGeminiTranscriptionError>);
    expect(stopped.completed).toHaveLength(0);
    expect(stopped.failed).toHaveLength(1);
    expect(stopped.failed[0]).toMatchObject({ action: "stop" });
  });

  it("treats an audio preparation with no parts as incomplete", async () => {
    const f = setup();
    f.shell.geminiPrepare = async () => [{ durationSec: 0, parts: [] }, { durationSec: 0, parts: [] }];
    await expect(runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "incomplete" } satisfies Partial<MacGeminiTranscriptionError>);
    expect(f.completed).toHaveLength(0);
  });

  it("keeps a confirmed server success even when local staging cleanup must be retried later", async () => {
    const f = setup();
    f.shell.geminiDiscard = async () => { throw new Error("synthetic cleanup failure"); };
    await expect(runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined })).resolves.toBeUndefined();
    expect(f.completed).toHaveLength(1);
    expect(f.failed).toHaveLength(0);
  });

  it("surfaces a recording revision conflict and keeps the completed output for review/retry", async () => {
    const f = setup({ completeConflict: true });
    await expect(runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "saving" } satisfies Partial<MacGeminiTranscriptionError>);
    expect(f.completed).toHaveLength(1);
    expect(f.checkpoint).toMatchObject({ state: "saving", pendingOutput: { durationSec: 900 } });
  });

  it("does not resume a failed run after its page revision or audio manifest changed", async () => {
    const f = setup({ resumeConflict: true });
    await expect(runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, operationId: OP, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "changed" } satisfies Partial<MacGeminiTranscriptionError>);
    expect(f.calls.some(([name]) => name === "begin" || name === "prepare" || name === "turn")).toBe(false);
  });

  it("keeps an already-generated pending result visible when a changed recording cannot resume", async () => {
    const fingerprint = runFingerprint();
    const pendingOutput = { segments: [{ start: 2, end: 2, text: "保存待ち", speaker: 0 }], durationSec: 900 };
    const f = setup({
      resumeConflict: true,
      checkpoint: { schemaVersion: 1, pageId: PAGE, runId: RUN, operationId: OP, generation: 1, revision: 1, previousRevision: 0, fingerprint, completed: [], pendingOutput, state: "saving" },
    });
    await expect(runMacGeminiTranscription({ shell: f.shell, pageId: PAGE, operationId: OP, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "saving" } satisfies Partial<MacGeminiTranscriptionError>);
    expect(f.checkpoint).toMatchObject({ state: "saving", pendingOutput });
    expect(f.calls.some(([name]) => name === "prepare" || name === "turn")).toBe(false);
  });
});
