import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellBridge } from "niho-desktop-bridge/shell-bridge";
import { MacLocalTranscriptionError, readExact, runMacLocalTranscription } from "./mac-local-transcription";

const PAGE = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const OP = "00000000-0000-4000-8000-000000000003";
const manifest = [
  { partIndex: 0, bytes: 4, contentType: "audio/mp4", sha256: "a".repeat(64), durationSec: 10, offsetSec: 0 },
  { partIndex: 3, bytes: 4, contentType: "audio/mp4", sha256: "b".repeat(64), durationSec: 20, offsetSec: 10 },
];

function run(status: "running" | "failed" | "succeeded" = "running", generation = 1) {
  return { run: { id: RUN, status, engine: "apple-local", executor: "mac-local", language: "ja", errorCode: null }, generation, operationId: OP,
    settings: { engine: "apple-speech", speakerMode: "auto" }, audioManifest: manifest, tab: null };
}

function setup(options: { complete?: "ok" | "network" | "changed"; v2?: boolean; changedStage?: boolean; rangeContentType?: string; startStatus?: "running" | "failed"; resume?: "ok" | "stale" } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const shell = {
    capabilities: async () => ({ version: "test", dev: true, features: { recording: true, localTranscription: true, localTranscriptionV2: options.v2 ?? true, cliAi: true } }),
    localAudioBegin: async (_run: string, file: number) => { calls.push(["begin", file]); return { receivedBytes: options.changedStage ? 5 : 0, complete: false }; },
    localAudioChunk: async (_run: string, file: number, offset: number, bytes: Uint8Array) => { calls.push(["chunk", file, offset, bytes.byteLength]); return offset + bytes.byteLength; },
    localAudioFinish: async (_run: string, file: number) => { calls.push(["finish", file]); },
    transcribeLocal: async (_run: string, source: unknown) => { calls.push(["transcribe", source]); return [
      { jsonl: '{"type":"segment","start":1,"end":2,"text":"一つ目","speaker":1}', durationSec: 10 },
      { jsonl: '{"type":"segment","start":2,"end":3,"text":"二つ目","speaker":1}', durationSec: 20 },
    ]; },
    transcribeStop: async () => { calls.push(["stop"]); return true; },
    localDiscard: async () => { calls.push(["discard"]); },
  } as unknown as ShellBridge;
  const bodies: unknown[] = [];
  const fetchMock = vi.fn(async (resource: string | URL | Request, init?: RequestInit) => {
    const url = String(resource);
    if (url.includes("/recording/audio?part=")) {
      const total = 4;
      return new Response(new Uint8Array(total), { status: 206, headers: { "content-type": options.rangeContentType ?? "audio/mp4", "content-length": String(total), "content-range": `bytes 0-3/${total}` } });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    bodies.push(body);
    if (body?.action === "complete") {
      if (options.complete === "network") throw new TypeError("synthetic lost response");
      if (options.complete === "changed") return Response.json({ error: "recording_changed" }, { status: 409 });
      return Response.json({ status: "succeeded" });
    }
    if (body?.action === "start") return Response.json(run(options.startStatus ?? "running"));
    if (body?.action === "resume" && options.resume === "stale") return Response.json({ error: "stale_run" }, { status: 409 });
    if (body?.action === "fail" || body?.action === "stop") return Response.json({ status: "failed" });
    return Response.json(run());
  });
  vi.stubGlobal("fetch", fetchMock);
  return { shell, calls, bodies, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe("Apple on-device transcription orchestration", () => {
  it("cancels oversized and aborted response streams before releasing the reader", async () => {
    let overflowCanceled = 0;
    const overflow = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(5)); },
      cancel() { overflowCanceled += 1; },
    });
    await expect(readExact(new Response(overflow), 4, new AbortController().signal)).rejects.toMatchObject({ code: "changed" });
    expect(overflowCanceled).toBe(1);
    expect(overflow.locked).toBe(false);

    let abortCanceled = 0;
    const pending = new ReadableStream<Uint8Array>({ cancel() { abortCanceled += 1; } });
    const controller = new AbortController();
    controller.abort();
    await expect(readExact(new Response(pending), 4, controller.signal)).rejects.toMatchObject({ code: "stopped" });
    expect(abortCanceled).toBe(1);
    expect(pending.locked).toBe(false);
  });

  it("stages dense native files from exact server parts, preserves offsets and scopes speakers per file", async () => {
    const f = setup();
    await runMacLocalTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined });
    expect(f.fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("recording/audio"))).toEqual([
      `/api/pages/${PAGE}/recording/audio?part=0`, `/api/pages/${PAGE}/recording/audio?part=3`,
    ]);
    expect(f.calls.filter(([name]) => name === "chunk")).toEqual([["chunk", 0, 0, 4], ["chunk", 1, 0, 4]]);
    expect(f.calls).toContainEqual(["transcribe", { kind: "server", files: 2 }]);
    const complete = f.bodies.find((body) => (body as { action?: string } | null)?.action === "complete") as { segments: Array<{ start: number; speaker: number }> };
    expect(complete.segments.map((item) => [item.start, item.speaker])).toEqual([[1, 1], [12, 2]]);
    expect(f.calls.at(-1)).toEqual(["discard"]);
  });

  it("keeps native audio/result and does not mark the run failed when the save response is unknown", async () => {
    const f = setup({ complete: "network" });
    await expect(runMacLocalTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "saving" } satisfies Partial<MacLocalTranscriptionError>);
    expect(f.calls.some(([name]) => name === "discard")).toBe(false);
    expect(f.bodies.some((body) => ["fail", "stop"].includes(String((body as { action?: string } | null)?.action)))).toBe(false);
  });

  it("does not save or discard when stopped just as recognition finishes", async () => {
    const f = setup();
    const controller = new AbortController();
    const recognize = f.shell.transcribeLocal;
    f.shell.transcribeLocal = async (...args) => {
      const result = await recognize(...args);
      controller.abort();
      return result;
    };
    await expect(runMacLocalTranscription({ shell: f.shell, pageId: PAGE, signal: controller.signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "stopped" });
    expect(f.bodies.some((body) => (body as { action?: string })?.action === "complete")).toBe(false);
    expect(f.bodies).toContainEqual(expect.objectContaining({ action: "stop" }));
    expect(f.calls.some(([name]) => name === "discard")).toBe(false);
  });

  it("keeps the local result and never reports success when stopped during the save response", async () => {
    const f = setup();
    const controller = new AbortController();
    const send = f.fetchMock.getMockImplementation()!;
    f.fetchMock.mockImplementation(async (resource, init) => {
      const response = await send(resource, init);
      if (init?.body && JSON.parse(String(init.body)).action === "complete") controller.abort();
      return response;
    });
    const progress = vi.fn();
    await expect(runMacLocalTranscription({ shell: f.shell, pageId: PAGE, signal: controller.signal, onProgress: progress }))
      .rejects.toMatchObject({ code: "stopped" });
    expect(f.calls.some(([name]) => name === "discard")).toBe(false);
    expect(progress.mock.calls.some(([value]) => value.phase === "done")).toBe(false);
  });

  it("rejects a changed late result without fallback, discard, or another recognition", async () => {
    const f = setup({ complete: "changed" });
    await expect(runMacLocalTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "changed" } satisfies Partial<MacLocalTranscriptionError>);
    expect(f.calls.filter(([name]) => name === "transcribe")).toHaveLength(1);
    expect(f.calls.some(([name]) => name === "discard")).toBe(false);
  });

  it("releases a failed operation when its audio revision can no longer be resumed", async () => {
    const f = setup({ startStatus: "failed", resume: "stale" });
    await expect(runMacLocalTranscription({ shell: f.shell, pageId: PAGE, operationId: OP, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "changed" } satisfies Partial<MacLocalTranscriptionError>);
    expect(f.bodies.map((body) => (body as { action?: string }).action)).toEqual(["start", "resume"]);
    expect(f.calls.some(([name]) => name === "transcribe")).toBe(false);
    expect(f.calls.some(([name]) => name === "discard")).toBe(false);
  });

  it("fails a pre-recognition run whose staged manifest changed so it does not stay active", async () => {
    const f = setup({ changedStage: true });
    await expect(runMacLocalTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "changed" } satisfies Partial<MacLocalTranscriptionError>);
    expect(f.calls.some(([name]) => name === "transcribe")).toBe(false);
    expect(f.bodies).toContainEqual(expect.objectContaining({ action: "fail", errorCode: "internal" }));
  });

  it("rejects a MIME mismatch before native recognition", async () => {
    const f = setup({ rangeContentType: "audio/mpeg" });
    await expect(runMacLocalTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "changed" } satisfies Partial<MacLocalTranscriptionError>);
    expect(f.calls.some(([name]) => name === "transcribe")).toBe(false);
    expect(f.bodies).toContainEqual(expect.objectContaining({ action: "fail" }));
  });

  it("does not start on an old Mac binary", async () => {
    const f = setup({ v2: false });
    await expect(runMacLocalTranscription({ shell: f.shell, pageId: PAGE, signal: new AbortController().signal, onProgress: () => undefined }))
      .rejects.toMatchObject({ code: "unsupported" } satisfies Partial<MacLocalTranscriptionError>);
    expect(f.bodies).toEqual([]);
  });
});
