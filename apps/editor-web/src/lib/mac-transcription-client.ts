export type MacAudioManifestPart = {
  partIndex: number;
  bytes: number;
  contentType: string;
  sha256: string;
  durationSec: number | null;
  offsetSec: number;
};

export type MacTranscriptionRun = {
  run: {
    id: string;
    status: "running" | "succeeded" | "failed";
    engine: "gemini-cli";
    executor: "mac-cli";
    language: "ja" | "en";
    errorCode: string | null;
  };
  generation: number;
  operationId: string;
  settings: { model: "gemini-3.8-flash"; effort: "low"; targetSec: 600 };
  audioManifest: MacAudioManifestPart[];
  candidateId: string | null;
};

export class MacTranscriptionRequestError extends Error {
  override readonly name = "MacTranscriptionRequestError";
  constructor(readonly status: number, readonly reason: string | null = null) {
    super(`mac transcription request failed: ${status}${reason ? ` (${reason})` : ""}`);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUDIO_FILE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validManifest(value: unknown): value is MacAudioManifestPart[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 256 && value.every((part, index) => object(part) &&
    Number.isSafeInteger(part.partIndex) && (part.partIndex as number) >= 0 && (part.partIndex as number) <= 255 &&
    (index === 0 ? part.partIndex === 0 : (part.partIndex as number) > (value[index - 1] as MacAudioManifestPart).partIndex) &&
    Number.isSafeInteger(part.bytes) && (part.bytes as number) > 0 && (part.bytes as number) <= AUDIO_FILE_MAX_BYTES &&
    typeof part.contentType === "string" && /^[a-f0-9]{64}$/.test(String(part.sha256)) &&
    (part.durationSec === null || (typeof part.durationSec === "number" && Number.isFinite(part.durationSec) && part.durationSec >= 0)) &&
    typeof part.offsetSec === "number" && Number.isFinite(part.offsetSec) && part.offsetSec >= 0 &&
    (index === 0 || part.offsetSec >= (value[index - 1] as MacAudioManifestPart).offsetSec));
}

function parseRun(value: unknown): MacTranscriptionRun | null {
  if (!object(value) || !object(value.run) || !object(value.settings) || !validManifest(value.audioManifest)) return null;
  const run = value.run;
  if (typeof run.id !== "string" || !UUID.test(run.id) || !["running", "succeeded", "failed"].includes(String(run.status)) || run.engine !== "gemini-cli" || run.executor !== "mac-cli") return null;
  if ((run.language !== "ja" && run.language !== "en") || (run.errorCode !== null && typeof run.errorCode !== "string")) return null;
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1 || typeof value.operationId !== "string" || !UUID.test(value.operationId)) return null;
  if (value.settings.model !== "gemini-3.8-flash" || value.settings.effort !== "low" || value.settings.targetSec !== 600) return null;
  if (value.candidateId !== null && (typeof value.candidateId !== "string" || !UUID.test(value.candidateId))) return null;
  return value as unknown as MacTranscriptionRun;
}

async function request(pageId: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/pages/${encodeURIComponent(pageId)}/recording/transcription/mac`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new MacTranscriptionRequestError(0);
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const reason = object(data) ? [data.reason, data.error].find((item) => typeof item === "string") : null;
    throw new MacTranscriptionRequestError(response.status, typeof reason === "string" ? reason : null);
  }
  return data;
}

export async function startMacTranscription(pageId: string, operationId: string): Promise<MacTranscriptionRun> {
  const run = parseRun(await request(pageId, "POST", { action: "start", operationId }));
  if (!run) throw new MacTranscriptionRequestError(500);
  return run;
}

export async function getMacTranscription(pageId: string): Promise<MacTranscriptionRun | null> {
  const data = await request(pageId, "GET");
  if (!object(data) || !("run" in data)) throw new MacTranscriptionRequestError(500);
  if (data.run === null) return null;
  return parseRun(data);
}

export async function completeMacTranscription(
  pageId: string,
  run: MacTranscriptionRun,
  output: { segments: readonly { start: number; end: number; text: string; speaker: number | null }[]; durationSec: number | null },
): Promise<void> {
  await request(pageId, "POST", {
    action: "complete",
    operationId: run.operationId,
    runId: run.run.id,
    generation: run.generation,
    segments: output.segments,
    durationSec: output.durationSec,
  });
}

export async function resumeMacTranscription(pageId: string, run: MacTranscriptionRun): Promise<MacTranscriptionRun> {
  const resumed = parseRun(await request(pageId, "POST", {
    action: "resume",
    operationId: run.operationId,
    runId: run.run.id,
    generation: run.generation,
  }));
  if (!resumed) throw new MacTranscriptionRequestError(500);
  return resumed;
}

export async function endMacTranscription(pageId: string, run: MacTranscriptionRun, stopped: boolean, errorCode = "internal"): Promise<void> {
  await request(pageId, "POST", {
    action: stopped ? "stop" : "fail",
    operationId: run.operationId,
    runId: run.run.id,
    generation: run.generation,
    ...(stopped ? {} : { errorCode }),
  });
}
