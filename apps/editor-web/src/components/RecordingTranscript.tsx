"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { RecordingSegment } from "@niho/editor-store";
import { ShellRecording } from "niho-docs-ui/shell";
import { isPlayable, playbackSrc, segmentStart } from "@/lib/playback";
import {
  CONFLICT_MESSAGE,
  RecordingConflictError,
  RecordingRequestError,
  SEGMENT_EDITS_MAX,
  editSegments,
  getRecording,
  mergeSpeakers,
  recordingErrorMessage,
  renameSpeaker,
  type RecordingSnapshot,
} from "@/lib/recording-client";
import { durationLabel, readTimestampsPreference, shellSegments, shellSpeakers, writeTimestampsPreference } from "@/lib/recording-view";
import { useRecordingPlayback } from "@/lib/use-recording-playback";
import { PlaybackSeek } from "./PlaybackSeek";
import { RecordingAppend } from "./RecordingAppend";
import { RecordingAudios } from "./RecordingAudios";
import { RecordingCandidates } from "./RecordingCandidates";
import { RecordingTranscription } from "./RecordingTranscription";

/** 直した段落の文章（まだ保存されていない）。held は、保存に失敗したか競合した段落で、もう一度確定するまで送らない。 */
type Draft = { text: string; held: boolean };
type Drafts = Readonly<Record<number, Draft>>;
type Load = { state: "loading" } | { state: "ready" } | { state: "missing" } | { state: "failed"; message: string };

const NO_SEGMENTS: readonly RecordingSegment[] = [];
/** setTimeout が待てる最大（約 24.8 日）。音声の期限がこれより先なら、期限の切り替えは読み直したときに任せる。 */
const MAX_TIMER_MS = 2 ** 31 - 1;
const PROBLEM_STYLE: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 };

/**
 * 録音ページの文字起こし（設計 §7.1。本文の上）。録音を読み、段落をその場で直し（確定は blur・Enter）、話者の名前を変え・まとめる。
 * - 保存は 1 本ずつ順に送る。`baseRevision` は直前の応答の revision（送る直前に読む）。
 * - 別の画面が先に直していたら（409）、自分の文章は消さず、最新に合わせて知らせる。まだ送っていない下書きは（送っている間に直した段落も）
 *   すべて止めておき、もう一度確定する（か「もう一度保存」）と送る。最新に合わせた版の上に、確かめないまま重ねて書かない。
 * - 書いている途中（まだ確定していない入力）も「保存待ち」で、閉じようとしたらブラウザの確認を出す。
 * - 時刻の表示は端末ごとの好み。
 * - 音声のある録音（#36 段 3b-1）は、文字起こしの開始と状態（RecordingTranscription）を上に出す。段落がまだ無ければ段落の欄は出さない。
 *   文字起こしが済んだら録音を読み直し、下書きは捨てる（置き換えは確かめてから始めている。前の段落の位置の下書きを新しい段落に重ねない）。
 * - あとの音声の文字起こし（.vtt）を足せる（#36 段 3b-3。RecordingAppend）。時刻は前の音声の長さだけずらして 1 本につながる。
 * - 音声は複数持てる（#36 段 3b-4。RecordingAudios）。足した音声は、文字起こしをやり直すと 1 本につながる。
 * - 同じ音声の別の案（RecordingCandidates）を作って見比べ、採用できる。採用すると正本が入れ替わる（revision が進む）。
 * - 再生（#36 段 3b-2）: 音声がアップロード済みで期限の前、かつ段落の欄があるときだけ `<audio preload="metadata">` を 1 つ置き、
 *   同じ origin の route（`/api/pages/{id}/recording/audio`）から読む。再生・一時停止は段落の欄の再生ボタン、位置はスライダー
 *   （PlaybackSeek）、段落の時刻を押すとそこから再生。いま再生している段落を強調する（段落が移ったときだけ描き直す。直している最中の
 *   段落の文章は ShellRecording が上書きしない）。読めない・再生を始められないときは小さく知らせ、読めないときは「もう一度」。
 */
export function RecordingTranscript({ pageId }: { pageId: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<RecordingSnapshot | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // 書いている途中（段落・話者の入力に input があり、まだ blur・変換の確定をしていない）。下書きになる前の入力も失わないための印
  const [typing, setTyping] = useState(false);
  const composing = useRef(false);
  const [showTimestamps, setShowTimestamps] = useState(readTimestampsPreference);
  // 読み込んだ録音のページ（ページを移った直後に、前のページの録音で新しいページの音声を読みに行かない）
  const [loadedPage, setLoadedPage] = useState<string | null>(null);
  // 音声の期限と比べる時刻（期限が来たら更新して、再生の部品を外す）
  const [now, setNow] = useState(() => Date.now());

  // 送る直前に読む最新の値（非同期の保存が、古い render の値を掴まないため）
  const snapshotRef = useRef<RecordingSnapshot | null>(null);
  const draftsRef = useRef<Drafts>({});
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  /** 読み込んだ録音をそのまま置く（別のページの音声・案を引き継がない）。 */
  const replaceSnapshot = useCallback((next: RecordingSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);
  /**
   * 変更（段落の直し・話者の名前・.vtt を足す・採用）の応答を置く。応答は `recording` と `speakers` だけで、音声の列と
   * 案の一覧（読み取りのときだけ入る）は含まない。含まないときは直前のものを残す（空に戻すと、音声が無い・案が消えたように見える）。
   */
  const applySnapshot = useCallback(
    (next: RecordingSnapshot) => {
      const previous = snapshotRef.current;
      replaceSnapshot({
        ...next,
        ...(next.audios === undefined && previous?.audios !== undefined ? { audios: previous.audios } : {}),
        ...(next.candidates === undefined && previous?.candidates !== undefined ? { candidates: previous.candidates } : {}),
        ...(next.engines === undefined && previous?.engines !== undefined ? { engines: previous.engines } : {}),
        ...(next.defaultEngine === undefined && previous?.defaultEngine !== undefined ? { defaultEngine: previous.defaultEngine } : {}),
      });
    },
    [replaceSnapshot],
  );
  const applyDrafts = useCallback((next: Drafts) => {
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getRecording(pageId).then(
      (loaded) => {
        if (cancelled) return;
        replaceSnapshot(loaded);
        setLoadedPage(pageId);
        setLoad({ state: "ready" });
      },
      (error: unknown) => {
        if (cancelled) return;
        setLoad(error instanceof RecordingRequestError && error.status === 404 ? { state: "missing" } : { state: "failed", message: recordingErrorMessage(error, "load") });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [pageId, attempt, replaceSnapshot]);

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
        applySnapshot(await editSegments(pageId, base.recording.revision, batch));
        // 送った文章のままの下書きだけ消す（送っている間にさらに直された段落は残す）
        const rest = { ...draftsRef.current };
        for (const edit of batch) if (rest[edit.index]?.text === edit.text) delete rest[edit.index];
        applyDrafts(rest);
        setNotice(null);
      } catch (error) {
        const held = { ...draftsRef.current };
        if (error instanceof RecordingConflictError) {
          applySnapshot(error.snapshot);
          // 競合: 最新に合わせた版では、ほかの段落も別の画面に直されているかもしれない。送っている間に直した段落も含めて、
          // 下書きをすべて止める（順番を待っている flush が、確かめないまま最新の版に重ねて書かない）
          for (const [index, draft] of Object.entries(held)) held[Number(index)] = { text: draft.text, held: true };
        } else {
          // 送ろうとした段落は止める（自分の文章は画面に残す）。もう一度確定すると送る
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
  }, [pageId, applySnapshot, applyDrafts]);

  const onSegmentChange = (id: string, text: string) => {
    const index = Number(id);
    const base = snapshotRef.current;
    const server = base?.recording.segments[index]?.text;
    if (!base || server === undefined) return;
    // 元の文章のまま・下書きも無いなら何もしない（下書きがあるときは、戻した文章を送って揃える）
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

  /** 話者の操作（名前・まとめる）。成功は undefined、失敗は画面に出す文言（競合は最新に合わせて、もう一度の案内）。 */
  const speakerAction = (run: (base: RecordingSnapshot) => Promise<RecordingSnapshot>, action: "rename" | "merge"): Promise<string | undefined> =>
    enqueue(async () => {
      const base = snapshotRef.current;
      if (!base) return recordingErrorMessage(null, action);
      try {
        applySnapshot(await run(base));
        setNotice(null);
        return undefined;
      } catch (error) {
        if (error instanceof RecordingConflictError) {
          applySnapshot(error.snapshot);
          setNotice(CONFLICT_MESSAGE);
          return `${CONFLICT_MESSAGE}。もう一度試してください。`;
        }
        return recordingErrorMessage(error, action);
      }
    });

  /** 文字起こしが済んだ・段落がすでにあると断られた: 録音を読み直す（保存の列のあとに）。 */
  const reloadAfterTranscription = useCallback(() => {
    void enqueue(async () => {
      try {
        const next = await getRecording(pageId);
        applyDrafts({});
        applySnapshot(next);
        setNotice(null);
      } catch (error) {
        setNotice(recordingErrorMessage(error, "load"));
      }
    });
  }, [pageId, enqueue, applyDrafts, applySnapshot]);

  const held = Object.values(drafts).filter((draft) => draft.held).length;
  const unsaved = typing || Object.keys(drafts).length > 0;
  // 保存されていない文章があるまま閉じようとしたら、ブラウザの確認を出す
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  // 再生（#36 段 3b-2）。期限が来たら時刻を進めて、再生の部品を外す（期限切れは RecordingTranscription が「音声は削除されました」）
  const expiresAt = snapshot?.recording.audio?.expiresAt ?? null;
  useEffect(() => {
    if (expiresAt === null) return undefined;
    const wait = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(wait) || wait > MAX_TIMER_MS) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, wait) + 1);
    return () => clearTimeout(timer);
  }, [expiresAt]);
  // 再生の部品（再生ボタン・位置・時刻のボタン）は、再生できる音声があって段落の欄を出す（段落がある）ときだけ
  const player = snapshot !== null && loadedPage === pageId && snapshot.recording.segments.length > 0 && isPlayable(snapshot.recording.audio, now);
  const playback = useRecordingPlayback(player ? playbackSrc(pageId) : null, snapshot?.recording.segments ?? NO_SEGMENTS);
  const { playFrom } = playback;
  const onPlayFrom = useCallback(
    (id: string) => {
      const start = segmentStart(snapshotRef.current?.recording.segments ?? NO_SEGMENTS, id);
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
  if (load.state === "missing") return <p data-transcript="missing">このページには文字起こしがありません。</p>;
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
  const { audio } = snapshot.recording;
  const hasSegments = snapshot.recording.segments.length > 0;
  // 音声から作った録音で、まだ文字起こしの段落が無い: 段落の欄（直す・話者・時刻）は出さず、開始と状態だけ
  const showSegments = hasSegments || audio === null;
  return (
    <section
      aria-label="文字起こし"
      data-transcript="ready"
      onInput={() => setTyping(true)}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        // 変換の途中で外れたフォーカスは、子が変換の終わりに確定する（下書きになる）。中にフォーカスが無ければ書き終わり
        if (!event.currentTarget.contains(document.activeElement)) setTyping(false);
      }}
      onBlur={() => {
        // 確定は子（段落は blur、話者は送信）。変換の途中なら変換が終わるまで書いている扱いのまま
        if (!composing.current) setTyping(false);
      }}
    >
      {audio && (
        <RecordingTranscription pageId={pageId} audio={audio} engine={snapshot.defaultEngine ?? null} hasTranscript={hasSegments} onSucceeded={reloadAfterTranscription} onHasTranscript={reloadAfterTranscription} />
      )}
      {/* src は playback.ref が付け外しする（外して付け直されても src が戻るように） */}
      {player && <audio key={pageId} ref={playback.ref} preload="metadata" data-recording-audio="" />}
      {player && playback.problem && (
        <div role="alert" data-playback-problem={playback.problem} style={PROBLEM_STYLE}>
          <span>{playback.problem === "load" ? "音声を再生できません" : "再生できませんでした"}</span>
          {playback.problem === "load" && (
            <button type="button" className="es-btn es-btn--outline es-btn--sm" aria-label="音声をもう一度読み込む" onClick={playback.retry}>
              もう一度
            </button>
          )}
        </div>
      )}
      {showSegments && (
        <ShellRecording
          segments={shellSegments(
            snapshot.recording,
            Object.fromEntries(Object.entries(drafts).map(([index, draft]) => [index, draft.text])),
            player ? playback.currentId : null,
          )}
          speakers={shellSpeakers(snapshot.speakers)}
          position={player ? undefined : durationLabel(snapshot.recording)}
          onPlay={player ? playback.toggle : undefined}
          playing={player && playback.playing}
          seek={player ? <PlaybackSeek audio={playback.element} recordingSec={snapshot.recording.durationSec} onSeek={playback.seekTo} /> : undefined}
          onPlayFrom={player ? onPlayFrom : undefined}
          editing={editing}
          onToggleEdit={() => setEditing((value) => !value)}
          onSegmentChange={onSegmentChange}
          onRenameSpeaker={(id, name) => speakerAction((base) => renameSpeaker(pageId, base.recording.revision, Number(id), name), "rename")}
          onMergeSpeakers={(from, into) => speakerAction((base) => mergeSpeakers(pageId, base.recording.revision, Number(from), Number(into)), "merge")}
          showTimestamps={showTimestamps}
          onTimestamps={() => {
            const next = !showTimestamps;
            setShowTimestamps(next);
            writeTimestampsPreference(next);
          }}
        />
      )}
      {audio && (
        <RecordingAudios pageId={pageId} audios={snapshot.audios ?? []} onChanged={reloadAfterTranscription} disabled={saving} />
      )}
      {hasSegments && (
        <RecordingAppend
          pageId={pageId}
          revision={() => snapshotRef.current?.recording.revision ?? null}
          onSnapshot={applySnapshot}
          enqueue={enqueue}
          disabled={saving}
        />
      )}
      {audio && hasSegments && (
        <RecordingCandidates
          pageId={pageId}
          candidates={snapshot.candidates ?? []}
          engines={snapshot.engines ?? []}
          defaultEngine={snapshot.defaultEngine ?? null}
          onSnapshot={(next) => {
            applyDrafts({});
            applySnapshot(next);
            setNotice(null);
          }}
          onChanged={reloadAfterTranscription}
          disabled={saving}
        />
      )}
      <p role="status" aria-live="polite" data-save-state={status}>
        {showSegments && statusText}
        {held > 0 && (
          <>
            {" "}
            <button type="button" onClick={retry}>
              もう一度保存
            </button>
          </>
        )}
      </p>
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
