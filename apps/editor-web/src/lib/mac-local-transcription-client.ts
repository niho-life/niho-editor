export type MacLocalAudioManifestPart = {
  partIndex: number;
  bytes: number;
  contentType: string;
  sha256: string;
  durationSec: number | null;
  offsetSec: number;
};

export type MacLocalTranscriptionRun = {
  run: {
    id: string;
    status: "running" | "succeeded" | "failed";
    engine: "apple-local";
    executor: "mac-local";
    language: "ja" | "en";
    errorCode: string | null;
  };
  generation: number;
  operationId: string;
  settings: { engine: "apple-speech"; speakerMode: "auto" };
  audioManifest: MacLocalAudioManifestPart[];
  /** 結果を書く文字起こしのタブ（#310）。 */
  tab: string | null;
};

export class MacLocalTranscriptionRequestError extends Error {
  override readonly name = "MacLocalTranscriptionRequestError";
  constructor(readonly status: number, readonly reason: string | null = null) {
    super(`mac local transcription request failed: ${status}${reason ? ` (${reason})` : ""}`);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_MAX = 2 * 1024 * 1024 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifest(value: unknown): value is MacLocalAudioManifestPart[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 256 && value.every((part, index) => object(part) &&
    Number.isSafeInteger(part.partIndex) && (part.partIndex as number) >= 0 && (part.partIndex as number) <= 255 &&
    (index === 0 ? part.partIndex === 0 : (part.partIndex as number) > (value[index - 1] as MacLocalAudioManifestPart).partIndex) &&
    Number.isSafeInteger(part.bytes) && (part.bytes as number) > 0 && (part.bytes as number) <= FILE_MAX &&
    typeof part.contentType === "string" && /^[a-f0-9]{64}$/.test(String(part.sha256)) &&
    (part.durationSec === null || (typeof part.durationSec === "number" && Number.isFinite(part.durationSec) && part.durationSec >= 0)) &&
    typeof part.offsetSec === "number" && Number.isFinite(part.offsetSec) && part.offsetSec >= 0 &&
    (index === 0 || part.offsetSec >= (value[index - 1] as MacLocalAudioManifestPart).offsetSec));
}

function parseRun(value: unknown): MacLocalTranscriptionRun | null {
  if (!object(value) || !object(value.run) || !object(value.settings) || !manifest(value.audioManifest)) return null;
  const run = value.run;
  if (typeof run.id !== "string" || !UUID.test(run.id) || !["running", "succeeded", "failed"].includes(String(run.status)) || run.engine !== "apple-local" || run.executor !== "mac-local") return null;
  if ((run.language !== "ja" && run.language !== "en") || (run.errorCode !== null && typeof run.errorCode !== "string")) return null;
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1 || typeof value.operationId !== "string" || !UUID.test(value.operationId)) return null;
  if (value.settings.engine !== "apple-speech" || value.settings.speakerMode !== "auto") return null;
  if (value.tab !== null && (typeof value.tab !== "string" || !UUID.test(value.tab))) return null;
  return value as unknown as MacLocalTranscriptionRun;
}

async function request(pageId: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/recording/transcription/mac-local`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new MacLocalTranscriptionRequestError(0);
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = object(data) ? [data.reason, data.error].find((item) => typeof item === "string") : null;
    throw new MacLocalTranscriptionRequestError(response.status, typeof reason === "string" ? reason : null);
  }
  return data;
}

export async function startMacLocalTranscription(pageId: string, operationId: string): Promise<MacLocalTranscriptionRun> {
  const run = parseRun(await request(pageId, "POST", { action: "start", operationId }));
  if (!run) throw new MacLocalTranscriptionRequestError(500);
  return run;
}

export async function getMacLocalTranscription(pageId: string): Promise<MacLocalTranscriptionRun | null> {
  const data = await request(pageId, "GET");
  if (!object(data) || !("run" in data)) throw new MacLocalTranscriptionRequestError(500);
  return data.run === null ? null : parseRun(data);
}

export async function completeMacLocalTranscription(
  pageId: string,
  run: MacLocalTranscriptionRun,
  output: { segments: readonly { start: number; end: number; text: string; speaker: number | null }[]; durationSec: number | null },
): Promise<void> {
  await request(pageId, "POST", { action: "complete", operationId: run.operationId, runId: run.run.id, generation: run.generation, ...output });
}

export async function resumeMacLocalTranscription(pageId: string, run: MacLocalTranscriptionRun): Promise<MacLocalTranscriptionRun> {
  const resumed = parseRun(await request(pageId, "POST", { action: "resume", operationId: run.operationId, runId: run.run.id, generation: run.generation }));
  if (!resumed) throw new MacLocalTranscriptionRequestError(500);
  return resumed;
}

export async function endMacLocalTranscription(pageId: string, run: MacLocalTranscriptionRun, stopped: boolean, errorCode = "internal"): Promise<void> {
  await request(pageId, "POST", { action: stopped ? "stop" : "fail", operationId: run.operationId, runId: run.run.id, generation: run.generation, ...(stopped ? {} : { errorCode }) });
}
