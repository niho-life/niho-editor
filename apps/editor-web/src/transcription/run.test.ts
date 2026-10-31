import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedTranscription, FinishTranscriptionResult, TranscriptionErrorCode, TranscriptionOutput } from "@niho/editor-store";
import { createFakeStorage, type FakeStorage } from "../storage/fake";
import { StorageError, type ObjectStorage } from "../storage/types";
import { EngineError, type EngineErrorCode, type EngineInput, type TranscriptionEngine } from "./engine";
import { createFakeEngine } from "./fake";
import { executeRun, type TranscriptionRunStore } from "./run";

// 合成の id・小さなバイト列だけを使う
const RUN_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const ASSET_ID = "0b6f7d8e-1c2a-4b3c-8d4e-5f6a7b8c9d0e";
const OBJECT = `audio/${ASSET_ID}`;
const NOW = Date.parse("2030-01-01T00:00:00.000Z");

function claimOf(
  extra: {
    audio?: Partial<NonNullable<ClaimedTranscription["audio"]>> | null;
    diarize?: boolean;
    /** 音声の列（#36 段 3b-4）。渡さなければ part 0 の 1 件（audio と同じもの）。 */
    parts?: ClaimedTranscription["parts"];
    candidateId?: string | null;
  } = {},
): ClaimedTranscription {
  const audio =
    extra.audio === null
      ? null
      : {
          assetId: ASSET_ID,
          objectPath: OBJECT,
          status: "uploaded" as const,
          bytes: 3,
          contentType: "audio/mp4",
          sha256: "c".repeat(64),
          expiresAt: new Date(NOW + 86_400_000).toISOString(),
          ...extra.audio,
        };
  return {
    run: {
      id: RUN_ID,
      status: "running",
      engine: "fake",
      language: "ja",
      errorCode: null,
      createdAt: new Date(NOW).toISOString(),
      startedAt: new Date(NOW).toISOString(),
      finishedAt: null,
      owner: "synthetic-owner",
      pageId: "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9",
      diarize: extra.diarize ?? true,
      replace: false,
      terms: ["合成語"],
      candidateId: extra.candidateId ?? null,
    },
    generation: 1,
    audio,
    parts: extra.parts ?? (audio ? [{ ...audio, partIndex: 0, offsetSec: 0, durationSec: null, sourceName: null }] : []),
  };
}

function memoryStore(claim: ClaimedTranscription | null | Error, finish: FinishTranscriptionResult | Error = "succeeded") {
  const finished: Array<{ runId: string; generation: number; output: TranscriptionOutput }> = [];
  const failed: Array<{ runId: string; generation: number; code: TranscriptionErrorCode }> = [];
  const store: TranscriptionRunStore = {
    claimRun: async () => {
      if (claim instanceof Error) throw claim;
      return claim;
    },
    finishRun: async (runId, generation, output) => {
      finished.push({ runId, generation, output });
      if (finish instanceof Error) throw finish;
      return finish;
    },
    failRun: async (runId, generation, code) => {
      failed.push({ runId, generation, code });
      return true;
    },
  };
  return { store, finished, failed };
}

async function storageWithAudio(): Promise<FakeStorage> {
  const storage = createFakeStorage();
  const ticket = await storage.startUpload({ objectPath: OBJECT, contentType: "audio/mp4", sizeBytes: 3, origin: null });
  expect(storage.putFakeObject(ticket.url.split("/").pop()!, new Uint8Array([1, 2, 3]), "audio/mp4")).toBe("ok");
  return storage;
}

function failingEngine(error: unknown): TranscriptionEngine {
  return {
    name: "fake",
    transcribe: async () => {
      throw error;
    },
  };
}

let errors: { mock: { calls: unknown[] } };

beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** ログに出たのは code と例外の名前だけ（場所・id・本文・鍵を出さない）。 */
function expectQuietLogs() {
  const logged = JSON.stringify(errors.mock.calls);
  for (const secret of [OBJECT, ASSET_ID, "合成", "test-key-not-secret", "synthetic detail"]) expect(logged).not.toContain(secret);
}

describe("executeRun", () => {
  it("claims, streams the audio to the engine, normalizes the speakers and finishes the run", async () => {
    const { store, finished, failed } = memoryStore(claimOf());
    const seen: EngineInput[] = [];
    const fake = createFakeEngine();
    const engine: TranscriptionEngine = {
      name: "fake",
      transcribe: async (input) => {
        seen.push(input);
        return fake.transcribe(input);
      },
    };
    const outcome = await executeRun({ store, storage: await storageWithAudio(), engines: () => engine, runId: RUN_ID, timeoutMs: 60_000, now: () => NOW });
    expect(outcome).toEqual({ status: "succeeded" });
    expect(seen[0]?.audio.contentType).toBe("audio/mp4");
    expect(seen[0]?.audio.sizeBytes).toBe(3);
    expect(seen[0]?.language).toBe("ja");
    expect(seen[0]?.diarize).toBe(true);
    expect(seen[0]?.terms).toEqual(["合成語"]);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.generation).toBe(1);
    expect(finished[0]?.output.segments.map((segment) => segment.speaker)).toEqual([1, 2, 1]);
    expect(finished[0]?.output.durationSec).toBe(9);
    expect(failed).toEqual([]);
  });

  it("keeps the audio length the engine reported, even when the last utterance ends earlier (trailing silence)", async () => {
    const { store, finished } = memoryStore(claimOf());
    const engine: TranscriptionEngine = {
      name: "fake",
      transcribe: async () => ({ segments: [{ start: 0, end: 10, text: "合成", speaker: 1 }], durationSec: 100 }),
    };
    const outcome = await executeRun({ store, storage: await storageWithAudio(), engines: () => engine, runId: RUN_ID, timeoutMs: 60_000, now: () => NOW });
    expect(outcome).toEqual({ status: "succeeded" });
    expect(finished[0]?.output.durationSec).toBe(100);
  });

  it("transcribes every audio of the recording and joins them with the stored offsets", async () => {
    const second = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    const secondObject = `audio/${second}`;
    const claim = claimOf({
      parts: [
        { assetId: ASSET_ID, objectPath: OBJECT, status: "uploaded", bytes: 3, contentType: "audio/mp4", sha256: "c".repeat(64), expiresAt: null, partIndex: 0, offsetSec: 0, durationSec: 600, sourceName: "音声 1.m4a" },
        { assetId: second, objectPath: secondObject, status: "uploaded", bytes: 2, contentType: "audio/mp4", sha256: "d".repeat(64), expiresAt: null, partIndex: 1, offsetSec: 600, durationSec: 300, sourceName: "音声 2.m4a" },
      ],
    });
    const { store, finished, failed } = memoryStore(claim);
    const storage = await storageWithAudio();
    const ticket = await storage.startUpload({ objectPath: secondObject, contentType: "audio/mp4", sizeBytes: 2, origin: null });
    expect(storage.putFakeObject(ticket.url.split("/").pop()!, new Uint8Array([4, 5]), "audio/mp4")).toBe("ok");
    const seen: EngineInput[] = [];
    const engine: TranscriptionEngine = {
      name: "fake",
      transcribe: async (input) => {
        seen.push(input);
        await input.audio.stream.cancel();
        // それぞれの音声の先頭を 0 とした時刻で返る
        return { segments: [{ start: 0, end: 5, text: `${seen.length} 本目`, speaker: 1 }], durationSec: 5 };
      },
    };
    const outcome = await executeRun({ store, storage, engines: () => engine, runId: RUN_ID, timeoutMs: 60_000, now: () => NOW });
    expect(outcome).toEqual({ status: "succeeded" });
    // 音声は足した順に 1 本ずつ渡す
    expect(seen.map((input) => input.audio.sizeBytes)).toEqual([3, 2]);
    expect(finished[0]?.output.segments.map((item) => [item.start, item.end, item.text, item.speaker])).toEqual([
      [0, 5, "1 本目", 1],
      // 2 本目は記録してある 600 秒ぶんずれ、話者の番号は続く
      [600, 605, "2 本目", 2],
    ]);
    expect(finished[0]?.output.durationSec).toBe(605);
    expect(failed).toEqual([]);
  });

  it("fails without calling the engine when one of the audios is still uploading or has expired", async () => {
    const ready = { assetId: ASSET_ID, objectPath: OBJECT, status: "uploaded" as const, bytes: 3, contentType: "audio/mp4", sha256: "c".repeat(64), expiresAt: null, partIndex: 0, offsetSec: 0, durationSec: 600, sourceName: null };
    const engine: TranscriptionEngine = { name: "fake", transcribe: async () => expect.unreachable("the engine must not be called") };
    const uploading = memoryStore(claimOf({ parts: [ready, { ...ready, partIndex: 1, status: "uploading", assetId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e" }] }));
    expect(await executeRun({ store: uploading.store, storage: await storageWithAudio(), engines: () => engine, runId: RUN_ID, timeoutMs: 60_000, now: () => NOW })).toEqual({
      status: "failed",
      errorCode: "audio_missing",
    });
    const expired = memoryStore(claimOf({ parts: [ready, { ...ready, partIndex: 1, expiresAt: new Date(NOW - 1000).toISOString() }] }));
    expect(await executeRun({ store: expired.store, storage: await storageWithAudio(), engines: () => engine, runId: RUN_ID, timeoutMs: 60_000, now: () => NOW })).toEqual({
      status: "failed",
      errorCode: "audio_expired",
    });
    expectQuietLogs();
  });

  it("fails without calling the engine when the run's engine is not configured on this server", async () => {
    const { store, finished, failed } = memoryStore(claimOf());
    const outcome = await executeRun({
      store,
      storage: await storageWithAudio(),
      // 鍵の無いエンジン（run には記録されているが、このサーバーでは使えない）
      engines: () => null,
      runId: RUN_ID,
      timeoutMs: 60_000,
      now: () => NOW,
    });
    expect(outcome).toEqual({ status: "failed", errorCode: "engine_unavailable" });
    expect(failed).toEqual([{ runId: RUN_ID, generation: 1, code: "engine_unavailable" }]);
    expect(finished).toEqual([]);
    expectQuietLogs();
  });

  it("picks the engine the run was created with", async () => {
    const { store, finished } = memoryStore(claimOf());
    const asked: string[] = [];
    const outcome = await executeRun({
      store,
      storage: await storageWithAudio(),
      engines: (name) => {
        asked.push(name);
        return name === "fake" ? createFakeEngine() : null;
      },
      runId: RUN_ID,
      timeoutMs: 60_000,
      now: () => NOW,
    });
    expect(outcome).toEqual({ status: "succeeded" });
    expect(asked).toEqual(["fake"]);
    expect(finished).toHaveLength(1);
  });

  it("drops the speakers when the run does not diarize", async () => {
    const { store, finished } = memoryStore(claimOf({ diarize: false }));
    await executeRun({ store, storage: await storageWithAudio(), engines: () => createFakeEngine(), runId: RUN_ID, timeoutMs: 60_000, now: () => NOW });
    expect(finished[0]?.output.segments.map((segment) => segment.speaker)).toEqual([null, null, null]);
  });

  it("does nothing when the run was claimed by another or finished", async () => {
    const { store, finished, failed } = memoryStore(null);
    expect(await executeRun({ store, storage: createFakeStorage(), engines: () => createFakeEngine(), runId: RUN_ID, timeoutMs: 60_000 })).toEqual({ status: "skipped" });
    expect(finished).toEqual([]);
    expect(failed).toEqual([]);
  });

  it("fails with audio_missing or audio_expired before calling the engine, and keeps the audio", async () => {
    const engine = { name: "fake" as const, transcribe: vi.fn() };
    const cases: Array<[ClaimedTranscription, ObjectStorage, TranscriptionErrorCode]> = [
      [claimOf({ audio: null }), await storageWithAudio(), "audio_missing"],
      [claimOf({ audio: { status: "uploading" } }), await storageWithAudio(), "audio_missing"],
      [claimOf({ audio: { expiresAt: new Date(NOW).toISOString() } }), await storageWithAudio(), "audio_expired"],
      [claimOf(), createFakeStorage(), "audio_missing"],
    ];
    for (const [claim, storage, code] of cases) {
      const { store, failed, finished } = memoryStore(claim);
      expect(await executeRun({ store, storage, engines: () => engine, runId: RUN_ID, timeoutMs: 60_000, now: () => NOW })).toEqual({ status: "failed", errorCode: code });
      expect(failed).toEqual([{ runId: RUN_ID, generation: 1, code }]);
      expect(finished).toEqual([]);
    }
    expect(engine.transcribe).not.toHaveBeenCalled();
    // 期限の無い音声は期限切れにしない
    const { store } = memoryStore(claimOf({ audio: { expiresAt: null } }));
    expect(await executeRun({ store, storage: await storageWithAudio(), engines: () => createFakeEngine(), runId: RUN_ID, timeoutMs: 60_000, now: () => NOW })).toEqual({ status: "succeeded" });
    expectQuietLogs();
  });

  it("treats a storage failure as internal, not as missing audio", async () => {
    const storage = await storageWithAudio();
    storage.readObject = async () => {
      throw new StorageError("unavailable");
    };
    const { store, failed } = memoryStore(claimOf());
    expect(await executeRun({ store, storage, engines: () => createFakeEngine(), runId: RUN_ID, timeoutMs: 60_000, now: () => NOW })).toEqual({ status: "failed", errorCode: "internal" });
    expect(failed[0]?.code).toBe("internal");
    expectQuietLogs();
  });

  it("maps every engine failure to its code", async () => {
    const map: Array<[EngineErrorCode, TranscriptionErrorCode]> = [
      ["unavailable", "engine_unavailable"],
      ["rejected", "engine_rejected"],
      ["timeout", "engine_timeout"],
      ["bad_response", "engine_bad_response"],
      ["too_large", "too_large"],
    ];
    for (const [engineCode, code] of map) {
      const { store, failed, finished } = memoryStore(claimOf());
      const outcome = await executeRun({ store, storage: await storageWithAudio(), engines: () => failingEngine(new EngineError(engineCode)), runId: RUN_ID, timeoutMs: 60_000, now: () => NOW });
      expect(outcome).toEqual({ status: "failed", errorCode: code });
      expect(failed).toEqual([{ runId: RUN_ID, generation: 1, code }]);
      expect(finished).toEqual([]);
    }
    expectQuietLogs();
  });

  it("fails with engine_timeout when its own time limit passes, and too_large when the result is over the limits", async () => {
    const hanging: TranscriptionEngine = {
      name: "fake",
      transcribe: (input) =>
        new Promise((_, reject) => {
          input.signal.addEventListener("abort", () => reject(new Error("synthetic detail")));
        }),
    };
    const first = memoryStore(claimOf());
    expect(await executeRun({ store: first.store, storage: await storageWithAudio(), engines: () => hanging, runId: RUN_ID, timeoutMs: 20, now: () => NOW })).toEqual({
      status: "failed",
      errorCode: "engine_timeout",
    });

    const huge: TranscriptionEngine = {
      name: "fake",
      transcribe: async () => ({ segments: Array.from({ length: 20_001 }, (_, index) => ({ start: index, end: index + 1, text: "合成", speaker: 0 })), durationSec: null }),
    };
    const second = memoryStore(claimOf());
    expect(await executeRun({ store: second.store, storage: await storageWithAudio(), engines: () => huge, runId: RUN_ID, timeoutMs: 60_000, now: () => NOW })).toEqual({
      status: "failed",
      errorCode: "too_large",
    });
    expect(second.finished).toEqual([]);
  });

  it("never lets an exception out: unexpected engine, store and claim failures become internal", async () => {
    const engineThrows = memoryStore(claimOf());
    expect(
      await executeRun({ store: engineThrows.store, storage: await storageWithAudio(), engines: () => failingEngine(new TypeError("synthetic detail")), runId: RUN_ID, timeoutMs: 60_000, now: () => NOW }),
    ).toEqual({ status: "failed", errorCode: "internal" });

    const finishThrows = memoryStore(claimOf(), Object.assign(new Error("synthetic detail"), { code: "XX000" }));
    expect(await executeRun({ store: finishThrows.store, storage: await storageWithAudio(), engines: () => createFakeEngine(), runId: RUN_ID, timeoutMs: 60_000, now: () => NOW })).toEqual({
      status: "failed",
      errorCode: "internal",
    });
    expect(finishThrows.failed).toEqual([{ runId: RUN_ID, generation: 1, code: "internal" }]);

    // claim そのものが失敗: claim される前（世代 0）の run だけを失敗にする
    const claimThrows = memoryStore(new Error("synthetic detail"));
    expect(await executeRun({ store: claimThrows.store, storage: await storageWithAudio(), engines: () => createFakeEngine(), runId: RUN_ID, timeoutMs: 60_000 })).toEqual({
      status: "failed",
      errorCode: "internal",
    });
    expect(claimThrows.failed).toEqual([{ runId: RUN_ID, generation: 0, code: "internal" }]);

    // 失敗の記録も失敗する
    const failThrows = memoryStore(claimOf());
    failThrows.store.failRun = async () => {
      throw new Error("synthetic detail");
    };
    expect(
      await executeRun({ store: failThrows.store, storage: await storageWithAudio(), engines: () => failingEngine(new EngineError("unavailable")), runId: RUN_ID, timeoutMs: 60_000, now: () => NOW }),
    ).toEqual({ status: "failed", errorCode: "engine_unavailable" });
    expectQuietLogs();
  });

  it("reports a superseded finish as an internal failure and a stale finish as skipped", async () => {
    const superseded = memoryStore(claimOf(), "superseded");
    expect(await executeRun({ store: superseded.store, storage: await storageWithAudio(), engines: () => createFakeEngine(), runId: RUN_ID, timeoutMs: 60_000, now: () => NOW })).toEqual({
      status: "failed",
      errorCode: "internal",
    });
    // store が書かずに failed にしたので、もう一度は失敗にしない
    expect(superseded.failed).toEqual([]);
    const stale = memoryStore(claimOf(), "stale");
    expect(await executeRun({ store: stale.store, storage: await storageWithAudio(), engines: () => createFakeEngine(), runId: RUN_ID, timeoutMs: 60_000, now: () => NOW })).toEqual({ status: "skipped" });
    expect(stale.failed).toEqual([]);
  });

  it("closes the audio stream when the engine did not read it", async () => {
    let cancelled = false;
    const storage = await storageWithAudio();
    storage.readObject = async () => ({
      body: new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      sizeBytes: 3,
      contentType: "audio/mp4",
    });
    const { store } = memoryStore(claimOf());
    await executeRun({ store, storage, engines: () => failingEngine(new EngineError("rejected")), runId: RUN_ID, timeoutMs: 60_000, now: () => NOW });
    expect(cancelled).toBe(true);
  });
});
