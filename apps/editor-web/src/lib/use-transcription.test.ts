import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptionRequestError, type TranscriptionRun } from "./transcription-client";
import type { TranscriptionState } from "./transcription-view";
import { TranscriptionWatcher, type TranscriptionWatcherDeps } from "./use-transcription";

const PAGE_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
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

/** 読むたびに answers の先頭を返す（Error なら失敗）。最後の答えは繰り返す。 */
function watcher(answers: (TranscriptionRun | null | Error)[], overrides: Partial<TranscriptionWatcherDeps> = {}) {
  const states: TranscriptionState[] = [];
  let hidden = false;
  const get = vi.fn(async () => {
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const deps: TranscriptionWatcherDeps = {
    get,
    start: vi.fn(async () => ({ run: run("queued") })),
    onChange: (state) => states.push(state),
    onSucceeded: vi.fn(),
    onHasTranscript: vi.fn(),
    hasTranscript: () => false,
    isHidden: () => hidden,
    ...overrides,
  };
  const instance = new TranscriptionWatcher(PAGE_ID, deps);
  return { instance, deps, get, states, setHidden: (value: boolean) => (hidden = value) };
}

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("TranscriptionWatcher", () => {
  it("reads every 3 seconds while queued or running, then reloads once when it succeeds and stops", async () => {
    const { instance, deps, get } = watcher([run("queued"), run("running"), run("succeeded")]);
    instance.begin();
    await tick(0);
    expect(get).toHaveBeenCalledTimes(1);
    expect(instance.state.phase).toBe("active");
    await tick(2999);
    expect(get).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(get).toHaveBeenCalledTimes(2);
    expect(instance.state.run?.status).toBe("running");
    await tick(3000);
    expect(get).toHaveBeenCalledTimes(3);
    expect(instance.state.phase).toBe("idle");
    expect(deps.onSucceeded).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await tick(30_000);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("stops on failure, and does not read when there is nothing running", async () => {
    const failed = watcher([run("running"), run("failed", "engine_unavailable")]);
    failed.instance.begin();
    await tick(3000);
    expect(failed.instance.state).toMatchObject({ phase: "failed", run: { errorCode: "engine_unavailable" } });
    expect(vi.getTimerCount()).toBe(0);
    expect(failed.deps.onSucceeded).not.toHaveBeenCalled();

    const none = watcher([null]);
    none.instance.begin();
    await tick(10_000);
    expect(none.get).toHaveBeenCalledTimes(1);
    expect(none.instance.state.phase).toBe("idle");
  });

  it("reloads on the first read only when the run already succeeded and the page has no paragraphs yet", async () => {
    const empty = watcher([run("succeeded")]);
    empty.instance.begin();
    await tick(0);
    expect(empty.deps.onSucceeded).toHaveBeenCalledTimes(1);
    const filled = watcher([run("succeeded")], { hasTranscript: () => true });
    filled.instance.begin();
    await tick(0);
    expect(filled.deps.onSucceeded).not.toHaveBeenCalled();
  });

  it("waits longer while the page is hidden, and reads at once when it is shown again", async () => {
    const { instance, get, setHidden } = watcher([run("running")]);
    setHidden(true);
    instance.begin();
    await tick(0);
    await tick(3000);
    expect(get).toHaveBeenCalledTimes(1);
    await tick(12_000);
    expect(get).toHaveBeenCalledTimes(2);
    // 見えるようになったら、延ばしていた分を待たずに読む
    instance.visibilityChanged();
    await tick(0);
    expect(get).toHaveBeenCalledTimes(2);
    setHidden(false);
    instance.visibilityChanged();
    await tick(0);
    expect(get).toHaveBeenCalledTimes(3);
    await tick(3000);
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("gives up after three failed reads in a row (stalled), and reads again on resume", async () => {
    const { instance, get } = watcher([run("running"), new Error("offline"), new Error("offline"), new Error("offline"), run("running")]);
    instance.begin();
    await tick(0);
    await tick(3000);
    await tick(3000);
    expect(instance.state).toMatchObject({ phase: "active", failures: 2 });
    await tick(3000);
    expect(instance.state).toMatchObject({ phase: "stalled", failures: 3 });
    expect(vi.getTimerCount()).toBe(0);
    await tick(30_000);
    expect(get).toHaveBeenCalledTimes(4);
    instance.resume();
    await tick(0);
    expect(get).toHaveBeenCalledTimes(5);
    expect(instance.state).toMatchObject({ phase: "active", failures: 0 });
  });

  it("starts (replace only when asked), then watches; explains a refusal and reloads when there is already a transcript", async () => {
    const { instance, deps, get } = watcher([null, run("running")]);
    instance.begin();
    await tick(0);
    await instance.start(false);
    expect(deps.start).toHaveBeenCalledWith(PAGE_ID, {});
    expect(instance.state.phase).toBe("active");
    await tick(3000);
    expect(get).toHaveBeenCalledTimes(2);
    instance.dispose();

    const replace = watcher([run("failed", "engine_timeout")]);
    replace.instance.begin();
    await tick(0);
    await replace.instance.start(true);
    expect(replace.deps.start).toHaveBeenCalledWith(PAGE_ID, { replace: true });
    replace.instance.dispose();

    const refused = watcher([null], { start: vi.fn(async () => Promise.reject(new TranscriptionRequestError(503, "transcription_unavailable"))) });
    refused.instance.begin();
    await tick(0);
    await refused.instance.start(false);
    expect(refused.instance.state).toMatchObject({ phase: "idle", startError: "いまは始められません。少ししてから、もう一度試してください。" });
    expect(refused.deps.onHasTranscript).not.toHaveBeenCalled();

    const conflict = watcher([null], { start: vi.fn(async () => Promise.reject(new TranscriptionRequestError(409, "cannot_start", "has_transcript"))) });
    conflict.instance.begin();
    await tick(0);
    await conflict.instance.start(false);
    expect(conflict.deps.onHasTranscript).toHaveBeenCalledTimes(1);
  });

  it("does not start twice while starting or running", async () => {
    let finish!: (value: { run: TranscriptionRun }) => void;
    const start = vi.fn(() => new Promise<{ run: TranscriptionRun }>((resolve) => (finish = resolve)));
    const { instance } = watcher([null], { start });
    instance.begin();
    await tick(0);
    const first = instance.start(false);
    void instance.start(false);
    expect(start).toHaveBeenCalledTimes(1);
    finish({ run: run("queued") });
    await first;
    await instance.start(false);
    expect(start).toHaveBeenCalledTimes(1);
    instance.dispose();
  });

  it("picks up a run started elsewhere (the flow's 文字起こし 作成 ▾): reads again, watches it, and reloads when it succeeds (#309)", async () => {
    const { instance, deps, get } = watcher([null, run("queued"), run("succeeded")]);
    instance.begin();
    await tick(0);
    expect(get).toHaveBeenCalledTimes(1);
    expect(instance.state.phase).toBe("idle");
    await tick(10_000);
    expect(get).toHaveBeenCalledTimes(1);
    instance.startedElsewhere();
    await tick(0);
    expect(get).toHaveBeenCalledTimes(2);
    expect(instance.state.phase).toBe("active");
    await tick(3_000);
    expect(get).toHaveBeenCalledTimes(3);
    expect(deps.onSucceeded).toHaveBeenCalledTimes(1);
    // 動いている間の知らせは無視する（二重に読まない）
    const busy = watcher([run("running")]);
    busy.instance.begin();
    await tick(0);
    busy.instance.startedElsewhere();
    await tick(0);
    expect(busy.get).toHaveBeenCalledTimes(1);
  });

  it("leaves no timer after dispose and ignores answers that arrive late", async () => {
    let answer!: (value: TranscriptionRun) => void;
    const get = vi.fn(() => new Promise<TranscriptionRun>((resolve) => (answer = resolve)));
    const { instance, states } = watcher([], { get });
    instance.begin();
    instance.dispose();
    answer(run("succeeded"));
    await tick(0);
    expect(states).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
