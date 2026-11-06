"use client";

import { useEffect, useRef, useState } from "react";
import { TranscriptionRequestError, getTranscription, startTranscription, type StartTranscriptionInput, type TranscriptionRun } from "./transcription-client";
import {
  INITIAL_TRANSCRIPTION_STATE,
  pollDelayMs,
  shouldPoll,
  startErrorMessage,
  transcriptionReducer,
  type TranscriptionEvent,
  type TranscriptionState,
} from "./transcription-view";

export type TranscriptionWatcherDeps = {
  get?: (pageId: string) => Promise<TranscriptionRun | null>;
  start?: (pageId: string, input: StartTranscriptionInput) => Promise<{ run: TranscriptionRun }>;
  onChange: (state: TranscriptionState) => void;
  /** 実行が済んだ（段落を読み直す）。 */
  onSucceeded: () => void;
  /** 開始が「段落がすでにある」で断られた（段落を読み直す）。 */
  onHasTranscript?: () => void;
  /** いまの録音に段落があるか（最初に読んだ run が済んでいたとき、読み直すかを決める）。 */
  hasTranscript: () => boolean;
  isHidden?: () => boolean;
};

/** ほかの入口（「ページ」パネルの流れの「文字起こし 作成 ▾」。#309）で文字起こしを始めたことを、その録音の watcher へ知らせる口。 */
const startedListeners = new Set<(pageId: string) => void>();

/** 流れなど、この hook の外で文字起こしを始めた。録音の画面の watcher が読み直して、進み・完了・新しい段落を映す。 */
export function notifyTranscriptionStarted(pageId: string): void {
  for (const listener of startedListeners) listener(pageId);
}

export function onTranscriptionStarted(listener: (pageId: string) => void): () => void {
  startedListeners.add(listener);
  return () => {
    startedListeners.delete(listener);
  };
}

/**
 * 1 つの録音ページの文字起こしの状態を読み続ける（#36 段 3b-1）。
 * - begin で最新の run を読み、待機中・文字起こし中なら 3 秒ごと（画面が見えていない間は 15 秒ごと）に読み直す。
 * - 済んだら onSucceeded を 1 度呼んで止める。失敗でも止める。続けて 3 回読めなければ止めて stalled（resume で読み直す）。
 * - dispose のあとは、遅れて届いた結果を捨て、タイマーを残さない。
 */
export class TranscriptionWatcher {
  private current: TranscriptionState = INITIAL_TRANSCRIPTION_STATE;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** 読み直しの世代（resume・開始のたびに進め、前の世代の結果を捨てる）。 */
  private generation = 0;
  private readonly get: NonNullable<TranscriptionWatcherDeps["get"]>;
  private readonly startRun: NonNullable<TranscriptionWatcherDeps["start"]>;

  constructor(
    private readonly pageId: string,
    private readonly deps: TranscriptionWatcherDeps,
  ) {
    this.get = deps.get ?? ((id) => getTranscription(id));
    this.startRun = deps.start ?? ((id, input) => startTranscription(id, input));
  }

  get state(): TranscriptionState {
    return this.current;
  }

  begin(): void {
    void this.poll();
  }

  /** 文字起こしを始める（「もう一度」も）。段落があるときは replace を渡す（呼ぶ側が確認してから）。 */
  async start(replace: boolean): Promise<void> {
    if (this.disposed || this.current.phase === "starting" || this.current.phase === "active" || this.current.phase === "loading") return;
    this.clearTimer();
    const generation = ++this.generation;
    this.apply({ type: "start" });
    try {
      const { run } = await this.startRun(this.pageId, replace ? { replace: true } : {});
      if (this.disposed || generation !== this.generation) return;
      const next = this.apply({ type: "started", run });
      if (shouldPoll(next)) this.schedule();
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.apply({ type: "startFailed", message: startErrorMessage(error) });
      if (error instanceof TranscriptionRequestError && error.status === 409 && error.reason === "has_transcript") this.deps.onHasTranscript?.();
    }
  }

  /** ほかの入口で始めた run を拾う（待機中・実行中でなければ、いま読み直して監視を始める）。 */
  startedElsewhere(): void {
    if (this.disposed || this.current.phase === "starting" || this.current.phase === "active" || this.current.phase === "loading") return;
    this.clearTimer();
    this.generation += 1;
    this.apply({ type: "startedElsewhere" });
    void this.poll();
  }

  /** 「更新できません」から読み直す。 */
  resume(): void {
    if (this.disposed || this.current.phase !== "stalled") return;
    this.apply({ type: "resume" });
    void this.poll();
  }

  /** 画面が見えるようになったら、延ばしていた読み直しをすぐに行う。 */
  visibilityChanged(): void {
    if (this.disposed || this.deps.isHidden?.() || this.timer === null || !shouldPoll(this.current)) return;
    this.clearTimer();
    void this.poll();
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.clearTimer();
  }

  private apply(event: TranscriptionEvent): TranscriptionState {
    const next = transcriptionReducer(this.current, event);
    this.current = next;
    if (!this.disposed) this.deps.onChange(next);
    return next;
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, pollDelayMs(this.deps.isHidden?.() ?? false));
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.disposed) return;
    const generation = this.generation;
    const before = this.current.phase;
    let event: TranscriptionEvent;
    try {
      event = { type: "polled", run: await this.get(this.pageId) };
    } catch {
      event = { type: "pollFailed" };
    }
    if (this.disposed || generation !== this.generation) return;
    const next = this.apply(event);
    if (event.type === "polled" && event.run?.status === "succeeded") {
      // 実行が済んだのを見た（最初に読んだときは、段落がまだ画面に無いときだけ読み直す）
      if (before === "active" || before === "stalled" || (before === "loading" && !this.deps.hasTranscript())) this.deps.onSucceeded();
    }
    if (shouldPoll(next)) this.schedule();
  }
}

/** 録音ページの文字起こしの状態（enabled のあいだだけ読む。音声の無い録音では読まない）。 */
export function useTranscription(
  pageId: string,
  options: { enabled: boolean; hasTranscript: boolean; onSucceeded: () => void; onHasTranscript?: () => void },
) {
  const [state, setState] = useState<TranscriptionState>(INITIAL_TRANSCRIPTION_STATE);
  const watcherRef = useRef<TranscriptionWatcher | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const { enabled } = options;

  useEffect(() => {
    if (!enabled) return;
    const watcher = new TranscriptionWatcher(pageId, {
      onChange: setState,
      onSucceeded: () => latest.current.onSucceeded(),
      onHasTranscript: () => latest.current.onHasTranscript?.(),
      hasTranscript: () => latest.current.hasTranscript,
      isHidden: () => typeof document !== "undefined" && document.hidden,
    });
    watcherRef.current = watcher;
    watcher.begin();
    const onVisibility = () => watcher.visibilityChanged();
    document.addEventListener("visibilitychange", onVisibility);
    const offStarted = onTranscriptionStarted((id) => {
      if (id === pageId) watcher.startedElsewhere();
    });
    return () => {
      offStarted();
      document.removeEventListener("visibilitychange", onVisibility);
      watcher.dispose();
      if (watcherRef.current === watcher) watcherRef.current = null;
    };
  }, [enabled, pageId]);

  return {
    state,
    start: (replace: boolean) => watcherRef.current?.start(replace) ?? Promise.resolve(),
    resume: () => watcherRef.current?.resume(),
  };
}
