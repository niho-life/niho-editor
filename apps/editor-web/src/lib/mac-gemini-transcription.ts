import {
  buildAudioTranscriptionPartPrompt,
  buildAudioTranscriptionSystemPrompt,
  countChars,
  parseAudioTranscriptParagraphs,
  timedTranscriptParagraphs,
  transcriptionReferenceLines,
  type AudioTranscriptParagraph,
  type AudioTranscriptPart,
} from "@niho/docs-core";
import type { ShellBridge } from "niho-desktop-bridge/shell-bridge";
import { isShellError, type ShellAiEvent } from "niho-desktop-bridge/shell-contract";
import { macEngineModels, macEngineReady } from "./mac-ai-chat";
import {
  completeMacTranscription,
  endMacTranscription,
  MacTranscriptionRequestError,
  resumeMacTranscription,
  startMacTranscription,
  type MacAudioManifestPart,
  type MacTranscriptionRun,
} from "./mac-transcription-client";

const MODEL = "gemini-3.8-flash";
const RANGE_BYTES = 4 * 1024 * 1024;
const ATTEMPTS = 3;
const CHECKPOINT_PARTS_MAX = 20_000;
const CHECKPOINT_TEXT_MAX = 8 * 1024 * 1024;
const CHECKPOINT_REFERENCES_MAX = 1_000;
const CHECKPOINT_REFERENCE_MAX = 4_096;
const CHECKPOINT_TIME_MAX = 31 * 24 * 60 * 60;

export type MacGeminiProgress =
  | { phase: "staging" | "preparing" | "transcribing" | "saving"; completed: number; total: number }
  | { phase: "done"; completed: number; total: number };

export type MacGeminiCheckpoint = {
  schemaVersion: 1;
  pageId: string;
  runId: string;
  operationId: string;
  generation: number;
  revision: number;
  previousRevision: number;
  fingerprint: string;
  completed: Array<AudioTranscriptPart & { file: number; part: number }>;
  pendingOutput: null | {
    segments: Array<{ start: number; end: number; text: string; speaker: number | null }>;
    durationSec: number | null;
  };
  state: "running" | "stopped" | "failed" | "saving";
};

export class MacGeminiTranscriptionError extends Error {
  override readonly name = "MacGeminiTranscriptionError";
  constructor(readonly code: "unsupported" | "unavailable" | "auth" | "changed" | "checkpoint" | "incomplete" | "failed" | "saving" | "stopped" | "usage") {
    super(`mac gemini transcription: ${code}`);
  }
}

function stableFingerprint(pageId: string, run: MacTranscriptionRun): string {
  return JSON.stringify({
    pageId,
    runId: run.run.id,
    operationId: run.operationId,
    language: run.run.language,
    tab: run.tab,
    settings: run.settings,
    audioManifest: run.audioManifest,
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, min = 0, max = CHECKPOINT_TIME_MAX): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function validPendingOutput(value: unknown): value is NonNullable<MacGeminiCheckpoint["pendingOutput"]> {
  if (!object(value) || !(value.durationSec === null || finite(value.durationSec)) || !Array.isArray(value.segments) || value.segments.length > CHECKPOINT_PARTS_MAX) return false;
  let bytes = 0;
  return value.segments.every((segment) => {
    if (!object(segment) || !finite(segment.start) || !finite(segment.end) || segment.end < segment.start ||
      typeof segment.text !== "string" || !(segment.speaker === null || (Number.isSafeInteger(segment.speaker) && (segment.speaker as number) >= 0 && (segment.speaker as number) <= CHECKPOINT_REFERENCES_MAX))) return false;
    bytes += new TextEncoder().encode(segment.text).byteLength;
    return bytes <= CHECKPOINT_TEXT_MAX;
  });
}

function validCompleted(value: unknown): value is MacGeminiCheckpoint["completed"] {
  if (!Array.isArray(value) || value.length > CHECKPOINT_PARTS_MAX) return false;
  let bytes = 0;
  return value.every((part) => {
    if (!object(part) || !Number.isSafeInteger(part.file) || (part.file as number) < 0 || (part.file as number) > 255 ||
      !Number.isSafeInteger(part.part) || (part.part as number) < 0 || (part.part as number) >= CHECKPOINT_PARTS_MAX ||
      !finite(part.startSec) || !finite(part.endSec) || part.endSec < part.startSec || typeof part.text !== "string" ||
      !Array.isArray(part.referenceLines) || part.referenceLines.length > CHECKPOINT_REFERENCES_MAX ||
      !part.referenceLines.every((line) => typeof line === "string" && line.length <= CHECKPOINT_REFERENCE_MAX)) return false;
    bytes += new TextEncoder().encode(part.text).byteLength + part.referenceLines.reduce((sum, line) => sum + new TextEncoder().encode(line as string).byteLength, 0);
    return bytes <= CHECKPOINT_TEXT_MAX;
  });
}

function checkpoint(value: unknown, expected: { pageId: string; run: MacTranscriptionRun; fingerprint: string }): MacGeminiCheckpoint | null {
  if (!object(value)) return null;
  const item = value as Partial<MacGeminiCheckpoint>;
  if (item.schemaVersion !== 1 || item.pageId !== expected.pageId || item.runId !== expected.run.run.id || item.operationId !== expected.run.operationId || item.fingerprint !== expected.fingerprint) return null;
  if (!Number.isSafeInteger(item.generation) || (item.generation as number) < Math.max(1, expected.run.generation - 1) || (item.generation as number) > expected.run.generation ||
    !Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || !Number.isSafeInteger(item.previousRevision) ||
    (item.previousRevision as number) < 0 || (item.previousRevision as number) + 1 !== item.revision || !validCompleted(item.completed) ||
    !(item.pendingOutput === null || validPendingOutput(item.pendingOutput)) || !["running", "stopped", "failed", "saving"].includes(String(item.state))) return null;
  return item as MacGeminiCheckpoint;
}

async function stopAndThrow(shell: ShellBridge, runId: string): Promise<never> {
  await shell.geminiStop(runId).catch(() => undefined);
  throw new MacGeminiTranscriptionError("stopped");
}

async function requireRunning(signal: AbortSignal, shell: ShellBridge, runId: string): Promise<void> {
  if (signal.aborted) await stopAndThrow(shell, runId);
}

function baseContentType(value: string | null): string {
  return (value ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

async function readAudioRange(response: Response, size: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body || size < 1 || size > RANGE_BYTES) throw new MacGeminiTranscriptionError("changed");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(size);
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw new MacGeminiTranscriptionError("stopped");
      if (done) break;
      if (offset + value.byteLength > size) throw new MacGeminiTranscriptionError("changed");
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== size) throw new MacGeminiTranscriptionError("changed");
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function stageAudio(shell: ShellBridge, pageId: string, run: MacTranscriptionRun, part: MacAudioManifestPart, fileIndex: number, signal: AbortSignal): Promise<void> {
  // 取り込み取消でサーバーのpart番号は欠番になり得る。nativeのファイル番号はmanifestの順番に揃える。
  const stage = await shell.geminiAudioBegin(run.run.id, fileIndex, part.bytes, part.contentType, part.sha256);
  await requireRunning(signal, shell, run.run.id);
  if (stage.complete) return;
  let offset = stage.receivedBytes;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > part.bytes) throw new MacGeminiTranscriptionError("changed");
  while (offset < part.bytes) {
    if (signal.aborted) throw new MacGeminiTranscriptionError("stopped");
    const end = Math.min(part.bytes - 1, offset + RANGE_BYTES - 1);
    const response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/recording/audio?part=${part.partIndex}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Range: `bytes=${offset}-${end}` },
      signal,
    });
    await requireRunning(signal, shell, run.run.id);
    const range = parseContentRange(response.headers.get("content-range"));
    const expectedBytes = end - offset + 1;
    if (response.status !== 206 || !range || range.start !== offset || range.end !== end || range.total !== part.bytes ||
      response.headers.get("content-length") !== String(expectedBytes) ||
      baseContentType(response.headers.get("content-type")) !== baseContentType(part.contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new MacGeminiTranscriptionError("changed");
    }
    const bytes = await readAudioRange(response, expectedBytes, signal);
    await requireRunning(signal, shell, run.run.id);
    if (bytes.byteLength !== expectedBytes || bytes.byteLength > RANGE_BYTES) throw new MacGeminiTranscriptionError("changed");
    const received = await shell.geminiAudioChunk(run.run.id, fileIndex, offset, bytes);
    await requireRunning(signal, shell, run.run.id);
    if (received !== offset + bytes.byteLength) throw new MacGeminiTranscriptionError("changed");
    offset = received;
  }
  await shell.geminiAudioFinish(run.run.id, fileIndex);
  await requireRunning(signal, shell, run.run.id);
}

function isTooShort(text: string, soundSec: number, language: "ja" | "en", referenceLines: readonly string[]): boolean {
  const chars = parseAudioTranscriptParagraphs({ text, speakers: "auto", language, referenceLines })
    .reduce((sum, paragraph) => sum + countChars(paragraph.text), 0);
  return (soundSec > 5 && chars === 0) || (soundSec > 60 && chars < 50);
}

function terminalText(final: ShellAiEvent | null, streamed: string): { text: string; retry: boolean } {
  if (!final) return { text: streamed, retry: true };
  if (final.type === "Error") {
    if (final.reason_code === "TransientFailure") return { text: streamed, retry: true };
    if (final.reason_code === "UsageLimitReached") throw new MacGeminiTranscriptionError("usage");
    throw new MacGeminiTranscriptionError("failed");
  }
  if (final.type !== "Done") return { text: streamed, retry: true };
  if (final.stop_reason === "Stopped") throw new MacGeminiTranscriptionError("stopped");
  if (final.usage.model_used && final.usage.model_used !== MODEL) throw new MacGeminiTranscriptionError("changed");
  return { text: final.text || streamed, retry: final.stop_reason === "MaxTokens" };
}

export async function assertMacGeminiAvailable(shell: ShellBridge): Promise<void> {
  const capabilities = await shell.capabilities();
  if (capabilities.features.geminiCliTranscription !== true) throw new MacGeminiTranscriptionError("unsupported");
  const engine = (await shell.aiEngines()).find((item) => item.engine === "cli:antigravity");
  if (!engine?.installed) throw new MacGeminiTranscriptionError("unavailable");
  if (!engine.authenticated) throw new MacGeminiTranscriptionError("auth");
  if (!macEngineReady(engine) || !macEngineModels(engine).includes(MODEL)) throw new MacGeminiTranscriptionError("unavailable");
}

export async function runMacGeminiTranscription(input: {
  shell: ShellBridge;
  pageId: string;
  operationId?: string;
  signal: AbortSignal;
  onProgress: (progress: MacGeminiProgress) => void;
}): Promise<void> {
  if (input.signal.aborted) throw new MacGeminiTranscriptionError("stopped");
  let run = await startMacTranscription(input.pageId, input.operationId ?? crypto.randomUUID());
  let saved: MacGeminiCheckpoint | null = null;
  const persist = async () => {
    if (!saved) throw new MacGeminiTranscriptionError("checkpoint");
    const next = { ...saved, previousRevision: saved.revision, revision: saved.revision + 1 };
    await input.shell.geminiCheckpointWrite(run.run.id, next);
    saved = next;
  };
  let stopping = false;
  const stop = () => {
    stopping = true;
    void input.shell.geminiStop(run.run.id).catch(() => undefined);
  };
  input.signal.addEventListener("abort", stop, { once: true });
  try {
    await requireRunning(input.signal, input.shell, run.run.id);
    if (run.run.status === "succeeded") {
      await input.shell.geminiDiscard(run.run.id).catch(() => undefined);
      input.onProgress({ phase: "done", completed: 1, total: 1 });
      return;
    }
    const initialFingerprint = stableFingerprint(input.pageId, run);
    const rawCheckpoint = await input.shell.geminiCheckpointRead(run.run.id);
    await requireRunning(input.signal, input.shell, run.run.id);
    const stored = rawCheckpoint === null ? null : checkpoint(rawCheckpoint, { pageId: input.pageId, run, fingerprint: initialFingerprint });
    if (rawCheckpoint !== null && !stored) throw new MacGeminiTranscriptionError("checkpoint");
    saved = stored;

    if (run.run.status === "failed") {
      run = await resumeMacTranscription(input.pageId, run);
      await requireRunning(input.signal, input.shell, run.run.id);
    }
    if (run.run.status !== "running") throw new MacGeminiTranscriptionError("failed");
    const fingerprint = stableFingerprint(input.pageId, run);
    saved = stored
      ? { ...stored, generation: run.generation, state: stored.pendingOutput ? "saving" : "running" }
      : {
        schemaVersion: 1,
        pageId: input.pageId,
        runId: run.run.id,
        operationId: run.operationId,
        generation: run.generation,
        revision: 0,
        previousRevision: 0,
        fingerprint,
        completed: [],
        pendingOutput: null,
        state: "running",
      };
    await persist();
    if (saved.pendingOutput) {
      await requireRunning(input.signal, input.shell, run.run.id);
      input.onProgress({ phase: "saving", completed: saved.completed.length, total: saved.completed.length });
      await completeMacTranscription(input.pageId, run, saved.pendingOutput);
      await input.shell.geminiDiscard(run.run.id).catch(() => undefined);
      input.onProgress({ phase: "done", completed: saved.completed.length, total: saved.completed.length });
      return;
    }
    await assertMacGeminiAvailable(input.shell);
    await requireRunning(input.signal, input.shell, run.run.id);
    for (let index = 0; index < run.audioManifest.length; index++) {
      input.onProgress({ phase: "staging", completed: index, total: run.audioManifest.length });
      await stageAudio(input.shell, input.pageId, run, run.audioManifest[index]!, index, input.signal);
      await requireRunning(input.signal, input.shell, run.run.id);
    }
    if (stopping || input.signal.aborted) throw new MacGeminiTranscriptionError("stopped");
    input.onProgress({ phase: "preparing", completed: 0, total: 1 });
    const prepared = await input.shell.geminiPrepare(run.run.id, { kind: "server", files: run.audioManifest.length }, () => undefined);
    await requireRunning(input.signal, input.shell, run.run.id);
    if (prepared.length !== run.audioManifest.length || prepared.some((file) =>
      !Number.isFinite(file.durationSec) || file.durationSec < 0 || !Array.isArray(file.parts) || file.parts.some((part) =>
        !Number.isFinite(part.startSec) || !Number.isFinite(part.endSec) || !Number.isFinite(part.soundSec) ||
        part.startSec < 0 || part.endSec < part.startSec || part.endSec > file.durationSec || part.soundSec < 0,
      ),
    )) throw new MacGeminiTranscriptionError("changed");
    const targets: Array<{ file: number; part: number; startSec: number; endSec: number; soundSec: number }> = [];
    prepared.forEach((file, fileIndex) => {
      const offset = run.audioManifest[fileIndex]!.offsetSec;
      file.parts.forEach((part, partIndex) => targets.push({ file: fileIndex, part: partIndex, startSec: offset + part.startSec, endSec: offset + part.endSec, soundSec: part.soundSec }));
    });
    if (targets.length === 0) throw new MacGeminiTranscriptionError("incomplete");
    if (saved.completed.length > targets.length || saved.completed.some((part, index) => {
      const target = targets[index];
      return !target || part.file !== target.file || part.part !== target.part || part.startSec !== target.startSec || part.endSec !== target.endSec;
    })) throw new MacGeminiTranscriptionError("changed");
    const systemPrompt = buildAudioTranscriptionSystemPrompt({ title: null, language: run.run.language, speakers: "auto", terms: [] });
    const completed = saved.completed;
    const parsed: AudioTranscriptParagraph[] = [];
    for (const part of completed) parsed.push(...parseAudioTranscriptParagraphs({ text: part.text, speakers: "auto", language: run.run.language, referenceLines: part.referenceLines }));
    for (let index = completed.length; index < targets.length; index++) {
      if (stopping || input.signal.aborted) throw new MacGeminiTranscriptionError("stopped");
      input.onProgress({ phase: "transcribing", completed: index, total: targets.length });
      const target = targets[index]!;
      const referenceLines = transcriptionReferenceLines(parsed);
      const userPrompt = buildAudioTranscriptionPartPrompt({ index, count: targets.length, speakers: "auto", fileName: `f${target.file}-p${target.part}.wav`, referenceLines });
      let accepted: string | null = null;
      for (let attempt = 0; attempt < ATTEMPTS && accepted === null; attempt++) {
        let streamed = "";
        const turn = await input.shell.geminiTranscribePart(run.run.id, crypto.randomUUID(), target.file, target.part, systemPrompt, userPrompt, (envelope) => {
          if (envelope.event.type === "TextDelta") streamed += envelope.event.text;
          if (input.signal.aborted) void input.shell.geminiStop(run.run.id).catch(() => undefined);
        });
        await requireRunning(input.signal, input.shell, run.run.id);
        const result = terminalText(turn.finalEvent, streamed);
        const tooShort = isTooShort(result.text, target.soundSec, run.run.language, referenceLines);
        if (result.retry || tooShort) {
          if (attempt + 1 < ATTEMPTS) continue;
          throw new MacGeminiTranscriptionError("incomplete");
        }
        accepted = result.text;
      }
      const part: AudioTranscriptPart & { file: number; part: number } = { text: accepted ?? "", startSec: target.startSec, endSec: target.endSec, referenceLines, file: target.file, part: target.part };
      completed.push(part);
      parsed.push(...parseAudioTranscriptParagraphs({ text: part.text, speakers: "auto", language: run.run.language, referenceLines }));
      saved = { ...saved, completed: [...completed], state: "running" };
      await persist();
      await requireRunning(input.signal, input.shell, run.run.id);
    }
    const timed = timedTranscriptParagraphs(completed, "auto", run.run.language);
    const durationSec = prepared.reduce((max, file, index) => Math.max(max, run.audioManifest[index]!.offsetSec + file.durationSec), 0);
    const pendingOutput = { segments: timed.map((item) => ({ start: item.startSec, end: item.startSec, text: item.text, speaker: item.speaker })), durationSec };
    saved = { ...saved, pendingOutput, state: "saving" };
    await persist();
    await requireRunning(input.signal, input.shell, run.run.id);
    input.onProgress({ phase: "saving", completed: targets.length, total: targets.length });
    await completeMacTranscription(input.pageId, run, pendingOutput);
    await input.shell.geminiDiscard(run.run.id).catch(() => undefined);
    input.onProgress({ phase: "done", completed: targets.length, total: targets.length });
  } catch (error) {
    const stopped = stopping || input.signal.aborted || (error instanceof MacGeminiTranscriptionError && error.code === "stopped") || (isShellError(error) && error.code === "speech_stopped");
    const exposed = error instanceof MacTranscriptionRequestError && error.reason === "stale_run"
      ? new MacGeminiTranscriptionError("changed")
      : error;
    if (isShellError(error) && error.code === "shell_gemini_checkpoint_stale") {
      throw new MacGeminiTranscriptionError("checkpoint");
    }
    if (saved?.pendingOutput && !stopped) {
      saved = { ...saved, state: "saving" };
      await persist().catch(() => undefined);
      throw new MacGeminiTranscriptionError("saving");
    }
    if (saved) {
      saved = { ...saved, state: stopped ? "stopped" : "failed" };
      await persist().catch(() => undefined);
    }
    await endMacTranscription(input.pageId, run, stopped, error instanceof MacGeminiTranscriptionError && error.code === "unavailable" ? "engine_unavailable" : "engine_bad_response").catch(() => undefined);
    throw stopped ? new MacGeminiTranscriptionError("stopped") : exposed;
  } finally {
    input.signal.removeEventListener("abort", stop);
  }
}
