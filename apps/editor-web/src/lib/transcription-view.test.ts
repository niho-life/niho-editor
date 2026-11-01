import { describe, expect, it } from "vitest";
import { TranscriptionRequestError, type TranscriptionRun } from "./transcription-client";
import {
  INITIAL_TRANSCRIPTION_STATE,
  POLL_HIDDEN_INTERVAL_MS,
  POLL_INTERVAL_MS,
  audioExpiryLabel,
  canRetry,
  failureReason,
  isAudioExpired,
  pollDelayMs,
  runStatusLabel,
  shouldPoll,
  startErrorMessage,
  transcriptionReducer,
  type TranscriptionEvent,
  type TranscriptionState,
} from "./transcription-view";

const run = (status: TranscriptionRun["status"], errorCode: string | null = null): TranscriptionRun => ({
  id: "0b6c9a4e-3f0a-4c5e-9d1e-2a7b8c9d0e1f",
  status,
  engine: "fake",
  language: "ja",
  errorCode,
  createdAt: "2030-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
});

const play = (events: TranscriptionEvent[], from: TranscriptionState = INITIAL_TRANSCRIPTION_STATE) => events.reduce(transcriptionReducer, from);

describe("transcriptionReducer", () => {
  it("reads the first state: nothing yet, running, failed, done", () => {
    expect(play([{ type: "loaded", run: null }]).phase).toBe("idle");
    expect(play([{ type: "polled", run: run("queued") }]).phase).toBe("active");
    expect(play([{ type: "polled", run: run("failed", "engine_timeout") }]).phase).toBe("failed");
    expect(play([{ type: "polled", run: run("succeeded") }]).phase).toBe("idle");
    expect(shouldPoll(INITIAL_TRANSCRIPTION_STATE)).toBe(true);
  });

  it("starts: starting → active → done; a refusal keeps the previous state with its reason", () => {
    const started = play([{ type: "loaded", run: null }, { type: "start" }]);
    expect(started.phase).toBe("starting");
    expect(shouldPoll(started)).toBe(false);
    const active = transcriptionReducer(started, { type: "started", run: run("queued") });
    expect(active.phase).toBe("active");
    expect(shouldPoll(active)).toBe(true);
    const running = transcriptionReducer(active, { type: "polled", run: run("running") });
    expect(running.phase).toBe("active");
    expect(transcriptionReducer(running, { type: "polled", run: run("succeeded") })).toMatchObject({ phase: "idle", run: { status: "succeeded" } });

    const refused = play([{ type: "loaded", run: null }, { type: "start" }, { type: "startFailed", message: "いまは始められません" }]);
    expect(refused).toMatchObject({ phase: "idle", startError: "いまは始められません" });
    const retryRefused = play([{ type: "loaded", run: run("failed", "internal") }, { type: "start" }, { type: "startFailed", message: "x" }]);
    expect(retryRefused.phase).toBe("failed");
    // 次の開始で理由を消す
    expect(transcriptionReducer(refused, { type: "start" }).startError).toBeNull();
  });

  it("stops after three failed reads in a row and resumes on request; a good read resets the count", () => {
    const active = play([{ type: "started", run: run("running") }]);
    const once = transcriptionReducer(active, { type: "pollFailed" });
    expect(once).toMatchObject({ phase: "active", failures: 1 });
    expect(transcriptionReducer(once, { type: "polled", run: run("running") }).failures).toBe(0);
    const stalled = play([{ type: "pollFailed" }, { type: "pollFailed" }, { type: "pollFailed" }], active);
    expect(stalled).toMatchObject({ phase: "stalled", failures: 3 });
    expect(shouldPoll(stalled)).toBe(false);
    expect(transcriptionReducer(stalled, { type: "resume" })).toMatchObject({ phase: "active", failures: 0 });
  });

  it("ignores late reads once it is not watching (a finished run is not brought back)", () => {
    const done = play([{ type: "started", run: run("running") }, { type: "polled", run: run("failed", "engine_rejected") }]);
    expect(transcriptionReducer(done, { type: "polled", run: run("running") })).toBe(done);
    expect(transcriptionReducer(done, { type: "pollFailed" })).toBe(done);
    expect(transcriptionReducer(done, { type: "resume" })).toBe(done);
  });
});

describe("transcription view words", () => {
  it("polls every 3 seconds, 15 while the page is hidden", () => {
    expect(POLL_INTERVAL_MS).toBe(3000);
    expect(POLL_HIDDEN_INTERVAL_MS).toBe(15000);
    expect(pollDelayMs(false)).toBe(3000);
    expect(pollDelayMs(true)).toBe(15000);
  });

  it("names the states and every failure in short Japanese, and offers no retry once the audio is gone", () => {
    expect(runStatusLabel(run("queued"))).toBe("待機中");
    expect(runStatusLabel(run("running"))).toBe("文字起こし中");
    expect(runStatusLabel(run("failed"))).toBe("文字起こしに失敗しました");
    expect(runStatusLabel(run("succeeded"))).toBeNull();
    expect(runStatusLabel(null)).toBeNull();
    const codes = ["audio_missing", "audio_expired", "engine_unavailable", "engine_rejected", "engine_timeout", "engine_bad_response", "too_large", "internal"];
    const reasons = codes.map(failureReason);
    expect(new Set(reasons).size).toBe(codes.length);
    for (const reason of reasons) expect(reason).toMatch(/^[^a-z_]+。$/);
    expect(failureReason("something_new")).toBe("うまくいきませんでした。");
    expect(failureReason(null)).toBe("うまくいきませんでした。");
    expect(canRetry(run("failed", "engine_timeout"))).toBe(true);
    expect(canRetry(run("failed", "audio_expired"))).toBe(false);
    expect(canRetry(run("succeeded"))).toBe(false);
  });

  it("explains refusals to start", () => {
    expect(startErrorMessage(new TranscriptionRequestError(503, "transcription_unavailable"))).toBe("いまは始められません。少ししてから、もう一度試してください。");
    expect(startErrorMessage(new TranscriptionRequestError(502))).toContain("いまは始められません");
    expect(startErrorMessage(new TranscriptionRequestError(409, "cannot_start", "audio_not_ready"))).toBe("音声の取り込みが終わっていません。");
    expect(startErrorMessage(new TranscriptionRequestError(409, "cannot_start", "audio_expired"))).toBe("音声は削除されました。");
    expect(startErrorMessage(new TranscriptionRequestError(409, "cannot_start", "has_transcript"))).toContain("文字起こしがすでにあります");
    expect(startErrorMessage(new TranscriptionRequestError(401))).toContain("ログイン");
    expect(startErrorMessage(new TypeError("offline"))).toContain("つながりませんでした");
  });

  it("tells when the audio will be deleted (local calendar), or that it is gone", () => {
    const audio = { expiresAt: "2030-01-31T03:00:00.000Z" };
    const before = Date.parse("2030-01-10T00:00:00.000Z");
    expect(audioExpiryLabel(audio, before)).toBe("音声は 1月31日に削除されます");
    expect(isAudioExpired(audio, before)).toBe(false);
    expect(audioExpiryLabel(audio, Date.parse(audio.expiresAt))).toBe("音声は削除されました");
    expect(isAudioExpired(audio, Date.parse(audio.expiresAt) + 1)).toBe(true);
    expect(audioExpiryLabel({ expiresAt: null }, before)).toBeNull();
    expect(audioExpiryLabel(null, before)).toBeNull();
    expect(audioExpiryLabel({ expiresAt: "not a date" }, before)).toBeNull();
  });

});
