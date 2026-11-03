import { parseSpeechJsonl, type SpeechSegment } from "@niho/docs-core";
import type { ShellBridge } from "niho-desktop-bridge/shell-bridge";
import { composeParts } from "@/transcription/compose-parts";
import {
  completeMacLocalTranscription,
  endMacLocalTranscription,
  MacLocalTranscriptionRequestError,
  resumeMacLocalTranscription,
  startMacLocalTranscription,
  type MacLocalAudioManifestPart,
  type MacLocalTranscriptionRun,
} from "./mac-local-transcription-client";

const RANGE_BYTES = 4 * 1024 * 1024;

export type MacLocalProgress = { phase: "staging" | "transcribing" | "saving" | "done"; completed: number; total: number };

export class MacLocalTranscriptionError extends Error {
  override readonly name = "MacLocalTranscriptionError";
  constructor(readonly code: "unsupported" | "changed" | "failed" | "saving" | "stopped") {
    super(`mac local transcription: ${code}`);
  }
}

function baseContentType(value: string | null): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function rangeHeader(value: string | null): { start: number; end: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  return match ? { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) } : null;
}

export async function readExact(response: Response, size: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body || size < 1 || size > RANGE_BYTES) throw new MacLocalTranscriptionError("changed");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(size);
  let offset = 0;
  let complete = false;
  try {
    for (;;) {
      if (signal.aborted) throw new MacLocalTranscriptionError("stopped");
      const { value, done } = await reader.read();
      if (signal.aborted) throw new MacLocalTranscriptionError("stopped");
      if (done) break;
      if (offset + value.byteLength > size) throw new MacLocalTranscriptionError("changed");
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== size) throw new MacLocalTranscriptionError("changed");
    complete = true;
    return bytes;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function stagePart(shell: ShellBridge, pageId: string, runId: string, part: MacLocalAudioManifestPart, file: number, signal: AbortSignal): Promise<void> {
  const state = await shell.localAudioBegin(runId, file, part.bytes, part.contentType, part.sha256);
  if (signal.aborted) throw new MacLocalTranscriptionError("stopped");
  if (state.complete) return;
  let offset = state.receivedBytes;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > part.bytes) throw new MacLocalTranscriptionError("changed");
  while (offset < part.bytes) {
    const end = Math.min(part.bytes - 1, offset + RANGE_BYTES - 1);
    const response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/recording/audio?part=${part.partIndex}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Range: `bytes=${offset}-${end}` },
      signal,
    });
    const range = rangeHeader(response.headers.get("content-range"));
    const size = end - offset + 1;
    if (response.status !== 206 || !range || range.start !== offset || range.end !== end || range.total !== part.bytes ||
      response.headers.get("content-length") !== String(size) || baseContentType(response.headers.get("content-type")) !== baseContentType(part.contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new MacLocalTranscriptionError("changed");
    }
    const bytes = await readExact(response, size, signal);
    const received = await shell.localAudioChunk(runId, file, offset, bytes);
    if (received !== end + 1) throw new MacLocalTranscriptionError("changed");
    offset = received;
  }
  await shell.localAudioFinish(runId, file);
}

function outputOf(run: MacLocalTranscriptionRun, transcripts: Awaited<ReturnType<ShellBridge["transcribeLocal"]>>) {
  if (transcripts.length !== run.audioManifest.length) throw new MacLocalTranscriptionError("changed");
  const composed = composeParts(transcripts.map((item, index) => ({
    offsetSec: run.audioManifest[index]!.offsetSec,
    durationSec: item.durationSec,
    segments: parseSpeechJsonl(item.jsonl)
      .filter((line): line is SpeechSegment => line.type === "segment")
      .map((line) => ({ start: line.start, end: line.end, text: line.text, speaker: line.speaker ?? null })),
  })));
  return {
    durationSec: composed.durationSec,
    segments: composed.segments.map((segment) => {
      if (segment.start === null || segment.end === null) throw new MacLocalTranscriptionError("changed");
      return { ...segment, start: segment.start, end: segment.end };
    }),
  };
}

export async function runMacLocalTranscription(input: {
  shell: ShellBridge;
  pageId: string;
  operationId?: string;
  signal: AbortSignal;
  onProgress: (progress: MacLocalProgress) => void;
}): Promise<void> {
  const assertActive = () => {
    if (input.signal.aborted) throw new MacLocalTranscriptionError("stopped");
  };
  assertActive();
  const capabilities = await input.shell.capabilities();
  assertActive();
  if (capabilities.features.localTranscriptionV2 !== true) throw new MacLocalTranscriptionError("unsupported");
  let run = await startMacLocalTranscription(input.pageId, input.operationId ?? crypto.randomUUID());
  if (run.run.status === "succeeded") {
    assertActive();
    await input.shell.localDiscard(run.run.id).catch(() => undefined);
    assertActive();
    input.onProgress({ phase: "done", completed: 1, total: 1 });
    return;
  }
  if (run.run.status === "failed") {
    try {
      run = await resumeMacLocalTranscription(input.pageId, run);
    } catch (error) {
      // 音声・ページ revision が変わった failed run は再開できない。UI に stale operationId を
      // 保持させず、次の操作で新しい run を開始できるよう「変更済み」として返す。
      if (error instanceof MacLocalTranscriptionRequestError && error.status === 409) {
        throw new MacLocalTranscriptionError("changed");
      }
      throw error;
    }
  }
  let resultReady = false;
  const stop = () => { void input.shell.transcribeStop(run.run.id).catch(() => undefined); };
  input.signal.addEventListener("abort", stop, { once: true });
  try {
    assertActive();
    for (let index = 0; index < run.audioManifest.length; index += 1) {
      input.onProgress({ phase: "staging", completed: index, total: run.audioManifest.length });
      await stagePart(input.shell, input.pageId, run.run.id, run.audioManifest[index]!, index, input.signal);
    }
    if (input.signal.aborted) throw new MacLocalTranscriptionError("stopped");
    input.onProgress({ phase: "transcribing", completed: 0, total: run.audioManifest.length });
    const transcripts = await input.shell.transcribeLocal(
      run.run.id,
      { kind: "server", files: run.audioManifest.length },
      { language: run.run.language, speakerMode: "auto", hints: [] },
      () => undefined,
    );
    resultReady = true;
    assertActive();
    const output = outputOf(run, transcripts);
    input.onProgress({ phase: "saving", completed: run.audioManifest.length, total: run.audioManifest.length });
    assertActive();
    try {
      await completeMacLocalTranscription(input.pageId, run, output);
    } catch (error) {
      if (error instanceof MacLocalTranscriptionRequestError && error.status === 409) throw new MacLocalTranscriptionError("changed");
      throw new MacLocalTranscriptionError("saving");
    }
    assertActive();
    await input.shell.localDiscard(run.run.id).catch(() => undefined);
    assertActive();
    input.onProgress({ phase: "done", completed: 1, total: 1 });
  } catch (error) {
    const known = error instanceof MacLocalTranscriptionError ? error : new MacLocalTranscriptionError(input.signal.aborted ? "stopped" : "failed");
    // staging/認識前に不整合で止まった run は active のまま残さない。結果確定の 409 は
    // store 側が superseded/failed にしており、保存応答不明だけは running のまま結果再送へ残す。
    if (!resultReady || known.code === "stopped") {
      await endMacLocalTranscription(input.pageId, run, known.code === "stopped", "internal").catch(() => undefined);
    }
    throw known;
  } finally {
    input.signal.removeEventListener("abort", stop);
  }
}
