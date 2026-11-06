"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { RecordingSegment } from "@niho/editor-store";
import { ShellRecording } from "niho-docs-ui/shell";
import { playbackParts, segmentStart } from "@/lib/playback";
import { CONFLICT_MESSAGE, RecordingRequestError, SEGMENT_EDITS_MAX, getRecording, recordingErrorMessage, type RecordingSnapshot } from "@/lib/recording-client";
import { durationLabel, readTimestampsPreference, shellSegments, shellSpeakers, writeTimestampsPreference } from "@/lib/recording-view";
import {
  TranscriptConflictError,
  appendTranscriptVtt,
  editTranscriptSegments,
  getTranscript,
  getTranscriptRun,
  listTranscriptVersions,
  mergeTranscriptSpeakers,
  renameTranscriptSpeaker,
  restoreTranscriptVersion,
  versionReasonLabel,
  type TranscriptSnapshot,
  type TranscriptVersionSummary,
} from "@/lib/transcript-client";
import { startTranscription } from "@/lib/transcription-client";
import { canRetry, failureReason, runStatusLabel } from "@/lib/transcription-view";
import { notifyTranscriptionStarted, useTranscription } from "@/lib/use-transcription";
import { useRecordingPlayback } from "@/lib/use-recording-playback";
import { PlaybackSeek } from "./PlaybackSeek";
import { RecordingAppend } from "./RecordingAppend";

/** 直した段落の文章（まだ保存されていない）。held は、保存に失敗したか競合した段落で、もう一度確定するまで送らない。 */
type Draft = { text: string; held: boolean };
type Drafts = Readonly<Record<number, Draft>>;
type Load = { state: "loading" } | { state: "ready" } | { state: "missing" } | { state: "failed"; message: string };

const NO_SEGMENTS: readonly RecordingSegment[] = [];
/** setTimeout が待てる最大（約 24.8 日）。音声の期限がこれより先なら、期限の切り替えは読み直したときに任せる。 */
const MAX_TIMER_MS = 2 ** 31 - 1;
const PROBLEM_STYLE: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 };
const PART_CONTROLS_STYLE: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, margin: "8px 0" };
const VERSION_LIST_STYLE: CSSProperties = { listStyle: "none", margin: "4px 0 0", padding: 0, display: "grid", gap: 4 };
const VERSION_ITEM_STYLE: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px 10px" };

function versionTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * 文字起こしのタブ（#310。`made_from.kind = 'transcript'`。「文字起こし」ページのタブ）の本文（題名の下・本文の上）。
 * - 本文は `/api/pages/{tab}/transcript`。段落をその場で直し（確定は blur・Enter）、話者の名前を変え・まとめる。
 *   保存は 1 本ずつ順に送る。`baseRevision` は直前の応答の revision。別の画面が先に直していたら（409）、自分の文章は消さず最新に合わせて知らせる
 *   （下書きは止めて、もう一度確定すると送る。確かめないまま最新の版に重ねて書かない）。
 * - 再生は元の録音のタブ（`recording`）の音声（#36 段 3b-2・#231）。録音が消えていれば本文だけ（再生の部品は出さない）。
 * - このタブに書く実行（文字起こし中・失敗）はここで見せる。失敗の「もう一度」は同じタブに書き直す（同じエンジンがサーバーで使えるとき）。
 * - あとの音声の文字起こし（.vtt）を足す（RecordingAppend）。版（直す前の本文）を見て戻せる。
 */
export function TranscriptPage({ tabId, recording }: { tabId: string; recording: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<TranscriptSnapshot | null>(null);
  const [audioSnapshot, setAudioSnapshot] = useState<RecordingSnapshot | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // 書いている途中（段落・話者の入力に input があり、まだ blur・変換の確定をしていない）。下書きになる前の入力も失わないための印
  const [typing, setTyping] = useState(false);
  const composing = useRef(false);
  const [showTimestamps, setShowTimestamps] = useState(readTimestampsPreference);
  const [loadedTab, setLoadedTab] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // 版の一覧と開閉はタブごと（別のタブに移ったら読み直す。effect で戻さない）
  const [versionsState, setVersionsState] = useState<{ tab: string; list: TranscriptVersionSummary[] | null; open: boolean } | null>(null);
  const versions = versionsState?.tab === tabId ? versionsState.list : null;
  const versionsOpen = versionsState?.tab === tabId ? versionsState.open : false;
  const [restoring, setRestoring] = useState<number | null>(null);

  // 送る直前に読む最新の値（非同期の保存が、古い render の値を掴まないため）
  const snapshotRef = useRef<TranscriptSnapshot | null>(null);
  const draftsRef = useRef<Drafts>({});
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const generation = useRef(0);

  const applySnapshot = useCallback((next: TranscriptSnapshot) => {
    // 変更の応答には run が入らない。前の値を残す
    const previous = snapshotRef.current;
    const merged = { ...next, ...(next.run === undefined && previous?.run !== undefined ? { run: previous.run } : {}) };
    snapshotRef.current = merged;
    setSnapshot(merged);
  }, []);
  const applyDrafts = useCallback((next: Drafts) => {
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  useEffect(() => {
    const mine = ++generation.current;
    getTranscript(tabId).then(
      (loaded) => {
        if (mine !== generation.current) return;
        snapshotRef.current = loaded;
        setSnapshot(loaded);
        setLoadedTab(tabId);
        setLoad({ state: "ready" });
      },
      (error: unknown) => {
        if (mine !== generation.current) return;
        setLoad(error instanceof RecordingRequestError && error.status === 404 ? { state: "missing" } : { state: "failed", message: recordingErrorMessage(error, "load") });
      },
    );
    // 音声は元の録音のタブから（消えていれば再生なし）
    getRecording(recording).then(
      (loaded) => {
        if (mine === generation.current) setAudioSnapshot(loaded);
      },
      () => {
        if (mine === generation.current) setAudioSnapshot(null);
      },
    );
    return () => {
      generation.current += 1;
    };
  }, [tabId, recording, attempt]);

  /** 書き込みを 1 本ずつ順に走らせる（前の失敗は次を止めない）。 */
  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const run = chain.current.then(job);
    chain.current = run.catch(() => undefined);
    return run;
  }, []);

  /** 止めていない下書きを、まとめて送る。 */
  const flush = useCallback(async () => {
    for (;;) {
      const batch = Object.entries(draftsRef.current)
        .filter(([, draft]) => !draft.held)
        .slice(0, SEGMENT_EDITS_MAX)
        .map(([index, draft]) => ({ index: Number(index), text: draft.text }));
      const base = snapshotRef.current;
      if (batch.length === 0 || !base) return;
      setSaving(true);
      try {
        applySnapshot(await editTranscriptSegments(tabId, base.transcript.revision, batch));
        // 送った文章のままの下書きだけ消す（送っている間にさらに直された段落は残す）
        const rest = { ...draftsRef.current };
        for (const edit of batch) if (rest[edit.index]?.text === edit.text) delete rest[edit.index];
        applyDrafts(rest);
        setNotice(null);
      } catch (error) {
        const held = { ...draftsRef.current };
        if (error instanceof TranscriptConflictError) {
          applySnapshot(error.snapshot);
          // 競合: 最新に合わせた版では、ほかの段落も別の画面に直されているかもしれない。下書きをすべて止める
          for (const [index, draft] of Object.entries(held)) held[Number(index)] = { text: draft.text, held: true };
        } else {
          for (const edit of batch) {
            const draft = held[edit.index];
            if (draft?.text === edit.text) held[edit.index] = { text: draft.text, held: true };
          }
        }
        applyDrafts(held);
        setNotice(recordingErrorMessage(error, "edit"));
        return;
      } finally {
        setSaving(false);
      }
    }
  }, [tabId, applySnapshot, applyDrafts]);

  const onSegmentChange = (id: string, text: string) => {
    const index = Number(id);
    const base = snapshotRef.current;
    const server = base?.transcript.segments[index]?.text;
    if (!base || server === undefined) return;
    if (text === server && draftsRef.current[index] === undefined) return;
    applyDrafts({ ...draftsRef.current, [index]: { text, held: false } });
    void enqueue(flush);
  };

  /** 止めた段落を、もう一度送る。 */
  const retry = () => {
    applyDrafts(Object.fromEntries(Object.entries(draftsRef.current).map(([index, draft]) => [index, { ...draft, held: false }])));
    setNotice(null);
    void enqueue(flush);
  };

  /** 話者の操作（名前・まとめる）。成功は undefined、失敗は画面に出す文言。 */
  const speakerAction = (run: (base: TranscriptSnapshot) => Promise<TranscriptSnapshot>, action: "rename" | "merge"): Promise<string | undefined> =>
    enqueue(async () => {
      const base = snapshotRef.current;
      if (!base) return recordingErrorMessage(null, action);
      try {
        applySnapshot(await run(base));
        setNotice(null);
        return undefined;
      } catch (error) {
        if (error instanceof TranscriptConflictError) {
          applySnapshot(error.snapshot);
          setNotice(CONFLICT_MESSAGE);
          return `${CONFLICT_MESSAGE}。もう一度試してください。`;
        }
        return recordingErrorMessage(error, action);
      }
    });

  /** 文字起こしが済んだ: 本文を読み直す（保存の列のあとに。下書きは捨てる） */
  const reloadAfterTranscription = useCallback(() => {
    void enqueue(async () => {
      try {
        const next = await getTranscript(tabId);
        applyDrafts({});
        snapshotRef.current = next;
        setSnapshot(next);
        setNotice(null);
      } catch (error) {
        setNotice(recordingErrorMessage(error, "load"));
      }
    });
  }, [tabId, enqueue, applyDrafts]);

  const hasSegments = (snapshot?.transcript.segments.length ?? 0) > 0;
  const { state: runState, resume } = useTranscription(tabId, {
    enabled: load.state === "ready",
    hasTranscript: hasSegments,
    onSucceeded: reloadAfterTranscription,
    get: getTranscriptRun,
  });
  const run = runState.run ?? snapshot?.run ?? null;
  const active = runState.phase === "active" || runState.phase === "starting";
  const engines = audioSnapshot?.engines ?? [];
  const retryEngine = snapshot && engines.includes(snapshot.transcript.engine) ? snapshot.transcript.engine : null;
  const [retrying, setRetrying] = useState(false);
  /** 失敗の「もう一度」: 同じタブに同じエンジンで書き直す（録音の API に `tab` を添える）。 */
  const retryRun = async () => {
    if (retrying || !retryEngine) return;
    setRetrying(true);
    try {
      await startTranscription(recording, { engine: retryEngine, tab: tabId });
      notifyTranscriptionStarted(tabId);
      setNotice(null);
    } catch (error) {
      setNotice(recordingErrorMessage(error, "load") === "このページには文字起こしがありません。" ? "文字起こしを始められませんでした。" : "文字起こしを始められませんでした。しばらくしてからもう一度。");
    } finally {
      setRetrying(false);
    }
  };

  const loadVersions = useCallback(() => {
    const mine = generation.current;
    listTranscriptVersions(tabId).then(
      (list) => {
        if (mine === generation.current) setVersionsState((current) => ({ tab: tabId, list, open: current?.tab === tabId ? current.open : true }));
      },
      (error: unknown) => {
        if (mine === generation.current) setNotice(recordingErrorMessage(error, "load"));
      },
    );
  }, [tabId]);

  const restore = (version: number) =>
    enqueue(async () => {
      const base = snapshotRef.current;
      if (!base) return;
      setRestoring(version);
      try {
        applySnapshot(await restoreTranscriptVersion(tabId, version, base.transcript.revision));
        applyDrafts({});
        setNotice(null);
        loadVersions();
      } catch (error) {
        if (error instanceof TranscriptConflictError) applySnapshot(error.snapshot);
        setNotice(error instanceof TranscriptConflictError ? CONFLICT_MESSAGE : recordingErrorMessage(error, "edit"));
      } finally {
        setRestoring(null);
      }
    });

  const held = Object.values(drafts).filter((draft) => draft.held).length;
  const unsaved = typing || Object.keys(drafts).length > 0;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  // 元の録音の音声Part。古い応答に一覧が無い場合は、元音声1本として扱う
  const audioParts = useMemo(() => {
    if (!audioSnapshot) return [];
    if (audioSnapshot.audios !== undefined) return audioSnapshot.audios;
    const audio = audioSnapshot.recording.audio;
    return audio
      ? [{ partIndex: 0, status: audio.status, bytes: audio.bytes, contentType: audio.contentType, durationSec: audioSnapshot.recording.durationSec, offsetSec: 0, sourceName: null, expiresAt: audio.expiresAt }]
      : [];
  }, [audioSnapshot]);
  const timelineParts = useMemo(() => playbackParts(audioParts, now, audioSnapshot?.recording.durationSec ?? null), [audioParts, now, audioSnapshot?.recording.durationSec]);
  const nextExpiry = useMemo(() => {
    const times = audioParts.map((part) => (part.expiresAt === null ? Number.NaN : Date.parse(part.expiresAt))).filter((at) => Number.isFinite(at) && at > now);
    return times.length > 0 ? Math.min(...times) : null;
  }, [audioParts, now]);
  useEffect(() => {
    if (nextExpiry === null) return undefined;
    const wait = nextExpiry - Date.now();
    if (!Number.isFinite(wait) || wait > MAX_TIMER_MS) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, wait) + 1);
    return () => clearTimeout(timer);
  }, [nextExpiry]);
  const player = snapshot !== null && loadedTab === tabId && timelineParts.some((part) => part.state === "ready");
  // 音声はあったが、全部期限を過ぎて消えている（文字起こしは残る）
  const audioGone = !player && timelineParts.length > 0 && timelineParts.some((part) => part.state === "expired") && !timelineParts.some((part) => part.state === "uploading");
  const playback = useRecordingPlayback(recording, player ? timelineParts : [], snapshot?.transcript.segments ?? NO_SEGMENTS);
  const { playFrom } = playback;
  const seekDurationSec = playback.durationSec ?? (timelineParts.length === 1 ? undefined : null);
  const onPlayFrom = useCallback(
    (id: string) => {
      const start = segmentStart(snapshotRef.current?.transcript.segments ?? NO_SEGMENTS, id);
      if (start !== null) playFrom(start);
    },
    [playFrom],
  );

  if (load.state === "loading") {
    return (
      <p role="status" aria-live="polite" data-transcript="loading">
        文字起こしを読み込んでいます
      </p>
    );
  }
  if (load.state === "missing") return <p data-transcript="missing">この文字起こしは見つかりません。</p>;
  if (load.state === "failed" || !snapshot) {
    return (
      <div role="alert" data-transcript="failed">
        <p>{load.state === "failed" ? load.message : recordingErrorMessage(null, "load")}</p>
        <button
          type="button"
          onClick={() => {
            setLoad({ state: "loading" });
            setAttempt((count) => count + 1);
          }}
        >
          もう一度読み込む
        </button>
      </div>
    );
  }

  const status = saving ? "saving" : held > 0 ? "held" : unsaved ? "pending" : "saved";
  const statusText = { saving: "保存中", held: `保存されていない段落が ${held} つあります`, pending: "保存待ち", saved: "保存済み" }[status];
  const { transcript } = snapshot;
  const failed = !active && run?.status === "failed" && !hasSegments;
  return (
    <section
      aria-label="文字起こし"
      data-transcript="ready"
      data-transcript-engine={transcript.engine}
      onInput={() => setTyping(true)}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        if (!event.currentTarget.contains(document.activeElement)) setTyping(false);
      }}
      onBlur={() => {
        if (!composing.current) setTyping(false);
      }}
    >
      <div data-transcription={runState.phase}>
        {active && (
          <p role="status" aria-live="polite" className="es-note">
            {runStatusLabel(run)}（{transcript.engineLabel}）
          </p>
        )}
        {failed && run && (
          <div role="alert" data-transcription-error={run.errorCode ?? ""} style={PROBLEM_STYLE}>
            <span>{runStatusLabel(run)}。{failureReason(run.errorCode)}</span>
            {canRetry(run) && retryEngine && (
              <button type="button" className="es-btn es-btn--outline es-btn--sm" aria-disabled={retrying || undefined} onClick={() => void retryRun()}>
                もう一度
              </button>
            )}
          </div>
        )}
        {runState.phase === "stalled" && (
          <div role="alert" style={PROBLEM_STYLE}>
            <span>文字起こしの状態を更新できません。</span>
            <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={resume}>
              更新する
            </button>
          </div>
        )}
      </div>
      {!audioSnapshot && load.state === "ready" && <p className="es-note" data-transcript-audio="missing">元の録音が見つからないので、再生はできません（文字起こしは残ります）。</p>}
      {audioGone && <p className="es-note" data-transcript-audio="expired">音声は削除されたので、再生できません（文字起こしは残ります）。</p>}
      {/* 現在Partの src は playback.ref が付け外しする（同じ認証境界の音声routeを使う）。 */}
      {player && <audio key={tabId} ref={playback.ref} preload="metadata" data-recording-audio="" />}
      {player && timelineParts.length > 1 && (
        <div role="group" aria-label="音声Partの移動" style={PART_CONTROLS_STYLE} data-playback-parts="">
          <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="前の音声Part" disabled={!playback.canGoPrevious} onClick={playback.previousPart}>
            前の音声
          </button>
          <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="次の音声Part" disabled={!playback.canGoNext} onClick={playback.nextPart}>
            次の音声
          </button>
          <span role="status" aria-live="polite" data-playback-part="">
            {playback.currentPartIndex === null ? "再生できる音声がありません" : `音声 ${playback.currentPartIndex + 1}${playback.playing ? "を再生中" : "を選択中"}`}
          </span>
        </div>
      )}
      {player && playback.problem && (
        <div role="alert" data-playback-problem={playback.problem} style={PROBLEM_STYLE}>
          <span>{playback.problem === "load" ? `音声 ${playback.currentPartIndex === null ? "" : playback.currentPartIndex + 1}を読み込めません。期限切れまたは見つからない可能性があります。別の音声へ移動できます。` : "再生できませんでした"}</span>
          {playback.problem === "load" && (
            <button type="button" className="es-btn es-btn--outline es-btn--sm" aria-label="音声をもう一度読み込む" onClick={playback.retry}>
              もう一度
            </button>
          )}
        </div>
      )}
      {player && playback.notice && <p role="status" aria-live="polite" data-playback-notice="">{playback.notice}</p>}
      {(hasSegments || !active) && (
        <ShellRecording
          segments={shellSegments(
            transcript,
            Object.fromEntries(Object.entries(drafts).map(([index, draft]) => [index, draft.text])),
            player ? playback.currentId : null,
          )}
          speakers={shellSpeakers(snapshot.speakers)}
          position={player ? undefined : durationLabel(transcript)}
          onPlay={player ? playback.toggle : undefined}
          playing={player && playback.playing}
          seek={player ? <PlaybackSeek audio={playback.element} recordingSec={transcript.durationSec} durationSec={seekDurationSec} positionOf={playback.positionOf} onSeek={playback.seekTo} /> : undefined}
          onPlayFrom={player ? onPlayFrom : undefined}
          editing={editing}
          onToggleEdit={() => setEditing((value) => !value)}
          onSegmentChange={onSegmentChange}
          onRenameSpeaker={(id, name) => speakerAction((base) => renameTranscriptSpeaker(tabId, base.transcript.revision, Number(id), name), "rename")}
          onMergeSpeakers={(from, into) => speakerAction((base) => mergeTranscriptSpeakers(tabId, base.transcript.revision, Number(from), Number(into)), "merge")}
          showTimestamps={showTimestamps}
          onTimestamps={() => {
            const next = !showTimestamps;
            setShowTimestamps(next);
            writeTimestampsPreference(next);
          }}
        />
      )}
      {!hasSegments && !active && !failed && <p className="es-note" data-transcript-empty="">まだ段落がありません。</p>}
      {hasSegments && (
        <RecordingAppend
          revision={() => snapshotRef.current?.transcript.revision ?? null}
          append={(base, input) => appendTranscriptVtt(tabId, base, input)}
          conflictOf={(error) => (error instanceof TranscriptConflictError ? error.snapshot : null)}
          onSnapshot={applySnapshot}
          enqueue={enqueue}
          disabled={saving}
        />
      )}
      <p role="status" aria-live="polite" data-save-state={status}>
        {hasSegments && statusText}
        {held > 0 && (
          <>
            {" "}
            <button type="button" onClick={retry}>
              もう一度保存
            </button>
          </>
        )}
      </p>
      <details
        data-transcript-versions=""
        open={versionsOpen}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setVersionsState((current) => ({ tab: tabId, list: current?.tab === tabId ? current.list : null, open }));
          if (open && versions === null) loadVersions();
        }}
      >
        <summary className="es-note">版（直す前の本文）</summary>
        {versions === null ? (
          <p className="es-note">読み込んでいます</p>
        ) : versions.length === 0 ? (
          <p className="es-note">まだ版はありません。</p>
        ) : (
          <ul style={VERSION_LIST_STYLE}>
            {versions.map((version) => (
              <li key={version.version} style={VERSION_ITEM_STYLE}>
                <span className="es-note">
                  {versionTime(version.createdAt)} · {versionReasonLabel(version.reason)} · {version.segmentCount} 区間
                </span>
                <button
                  type="button"
                  className="es-btn es-btn--quiet es-btn--sm"
                  aria-disabled={restoring !== null || saving || unsaved || undefined}
                  onClick={() => {
                    if (restoring === null && !saving && !unsaved) void restore(version.version);
                  }}
                >
                  この版に戻す
                </button>
              </li>
            ))}
          </ul>
        )}
      </details>
      {notice && (
        <p role="alert" data-transcript-notice="">
          {notice}{" "}
          <button type="button" onClick={() => setNotice(null)}>
            閉じる
          </button>
        </p>
      )}
    </section>
  );
}
