"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { playbackParts } from "@/lib/playback";
import { RecordingRequestError, getRecording, recordingErrorMessage, type RecordingSnapshot, type TranscriptTabView } from "@/lib/recording-client";
import { formatClock } from "@/lib/recording-view";
import { useRecordingPlayback } from "@/lib/use-recording-playback";
import { useEditorFrame } from "./EditorFrame";
import { PlaybackSeek } from "./PlaybackSeek";
import { RecordingAudios } from "./RecordingAudios";
import { RecordingTranscription } from "./RecordingTranscription";

type Load = { state: "loading" } | { state: "ready" } | { state: "missing" } | { state: "failed"; message: string };

const NO_SEGMENTS: readonly { start: number | null }[] = [];
/** setTimeout が待てる最大（約 24.8 日）。音声の期限がこれより先なら、期限の切り替えは読み直したときに任せる。 */
const MAX_TIMER_MS = 2 ** 31 - 1;
const PROBLEM_STYLE: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 8 };
const PART_CONTROLS_STYLE: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, margin: "8px 0" };
const HEADING_STYLE = { margin: "18px 0 8px", fontSize: 16, fontWeight: 600, color: "var(--ed-ink)" } as const;
const LIST_STYLE: CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 };
const ITEM_STYLE: CSSProperties = { display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "4px 10px" };

/** 文字起こしのタブの 1 行の補足（エンジン · 区間の数 · 長さ）。 */
export function transcriptTabNote(tab: TranscriptTabView): string {
  const parts = [tab.engineLabel, tab.segmentCount > 0 ? `${tab.segmentCount} 区間` : "まだ空", formatClock(tab.durationSec) ? `長さ ${formatClock(tab.durationSec)}` : ""];
  return parts.filter(Boolean).join(" · ");
}

/**
 * 録音のタブの本文（#36 → #310。「この録音について」の下）: 音声の再生、文字起こしの開始と状態、音声を足す、
 * この録音から作った**文字起こしのタブの一覧**（本文は「文字起こし」ページのタブ。TranscriptPage）。
 * 段落はここでは出さない・直さない（オーナー決定 2026-11-06。文字起こしはエンジンごとのタブ）。
 * - 再生（#36 段 3b-2・#231）: 再生可能なPartを同じ origin の認証付きrouteから順につなぎ、保存済み offset の全体時間軸でシークする。
 * - 文字起こしを始めたら、結果を書くタブを開く。済んだら一覧を読み直す（別の画面で始めた分も、開き直せば一覧に出る）。
 */
export function RecordingTranscript({ pageId }: { pageId: string }) {
  const router = useRouter();
  const { openPage } = useEditorFrame();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<RecordingSnapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 読み込んだ録音のページ（ページを移った直後に、前のページの録音で新しいページの音声を読みに行かない）
  const [loadedPage, setLoadedPage] = useState<string | null>(null);
  // 音声Partの期限と比べる時刻（期限が来たら更新して、再生可能なPartを選び直す）
  const [now, setNow] = useState(() => Date.now());
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    getRecording(pageId).then(
      (loaded) => {
        if (mine !== generation.current) return;
        setSnapshot(loaded);
        setLoadedPage(pageId);
        setLoad({ state: "ready" });
      },
      (error: unknown) => {
        if (mine !== generation.current) return;
        setLoad(error instanceof RecordingRequestError && error.status === 404 ? { state: "missing" } : { state: "failed", message: recordingErrorMessage(error, "load") });
      },
    );
    return () => {
      generation.current += 1;
    };
  }, [pageId, attempt]);

  /** 文字起こしが済んだ・音声が増えた: 録音を読み直す（一覧・音声の列）。 */
  const reload = useCallback(() => {
    const mine = generation.current;
    getRecording(pageId).then(
      (next) => {
        if (mine !== generation.current) return;
        setSnapshot(next);
        setNotice(null);
      },
      (error: unknown) => {
        if (mine === generation.current) setNotice(recordingErrorMessage(error, "load"));
      },
    );
  }, [pageId]);

  const open = useCallback((id: string) => {
    if (openPage) openPage(id);
    else router.push(`/p/${id}`);
  }, [openPage, router]);

  // 音声Partの一覧。古い応答に一覧が無い場合は、元音声1本として扱う。
  const audioParts = useMemo(() => {
    if (!snapshot) return [];
    if (snapshot.audios !== undefined) return snapshot.audios;
    const audio = snapshot.recording.audio;
    return audio
      ? [{ partIndex: 0, status: audio.status, bytes: audio.bytes, contentType: audio.contentType, durationSec: snapshot.recording.durationSec, offsetSec: 0, sourceName: null, expiresAt: audio.expiresAt }]
      : [];
  }, [snapshot]);
  const timelineParts = useMemo(() => playbackParts(audioParts, now, snapshot?.recording.durationSec ?? null), [audioParts, now, snapshot?.recording.durationSec]);
  // 期限が来るたびに再評価する。長期間先なら画面を開き直したときに再評価する。
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
  const player = snapshot !== null && loadedPage === pageId && timelineParts.some((part) => part.state === "ready");
  const playback = useRecordingPlayback(pageId, player ? timelineParts : [], NO_SEGMENTS);
  // `<audio>` の付け外しは子（AudioElement）に渡す（React Compiler の lint が、ref を渡した object の他の値を「ref の読み取り」と見るため）
  const attachAudio = playback.ref;
  const seekDurationSec = playback.durationSec ?? (timelineParts.length === 1 ? undefined : null);

  if (load.state === "loading") {
    return (
      <p role="status" aria-live="polite" data-transcript="loading">
        録音を読み込んでいます
      </p>
    );
  }
  if (load.state === "missing") return <p data-transcript="missing">このページには録音がありません。</p>;
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

  const { audio } = snapshot.recording;
  const transcripts = snapshot.transcripts ?? [];
  return (
    <section aria-label="録音と文字起こし" data-transcript="ready">
      <div data-recording-controls="">
        {audio && (
          <RecordingTranscription
            pageId={pageId}
            audio={audio}
            engine={snapshot.defaultEngine ?? null}
            onStarted={(tab) => {
              if (tab) open(tab);
              else reload();
            }}
            onSucceeded={reload}
          />
        )}
        {/* 現在Partの src は playback.ref が付け外しする（同じ認証境界の音声routeを使う）。 */}
        {player && <AudioElement key={pageId} attach={attachAudio} />}
        {player && (
          <div style={PART_CONTROLS_STYLE} role="group" aria-label="録音再生">
            <button type="button" className="es-btn es-btn--outline es-btn--sm" aria-label={playback.playing ? "一時停止" : "再生"} onClick={playback.toggle}>
              {playback.playing ? "一時停止" : "再生"}
            </button>
            <PlaybackSeek audio={playback.element} recordingSec={snapshot.recording.durationSec} durationSec={seekDurationSec} positionOf={playback.positionOf} onSeek={playback.seekTo} />
          </div>
        )}
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
        {audio && <RecordingAudios pageId={pageId} audios={snapshot.audios ?? []} onChanged={reload} />}
      </div>
      {/* 文字起こしのタブの一覧（#310。本文はそれぞれのタブ） */}
      <h2 style={HEADING_STYLE}>文字起こし</h2>
      {transcripts.length === 0 ? (
        <p className="es-note" data-transcripts="none">
          {audio ? "まだ文字起こしがありません。上の「文字起こしをはじめる」か、「ページ」パネルの流れでエンジンを選んで始めます。" : "まだ文字起こしがありません。"}
        </p>
      ) : (
        <ul style={LIST_STYLE} data-transcripts={transcripts.length} aria-label="文字起こしのタブ">
          {transcripts.map((tab) => (
            <li key={tab.id} style={ITEM_STYLE}>
              <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={() => open(tab.id)}>
                文字起こし {tab.label}
              </button>
              <small className="es-note">{transcriptTabNote(tab)}</small>
            </li>
          ))}
        </ul>
      )}
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

/** 現在Partの src は `attach`（use-recording-playback の ref）が付け外しする（同じ認証境界の音声routeを使う）。 */
function AudioElement({ attach }: { attach: (node: HTMLAudioElement | null) => (() => void) | undefined }) {
  return <audio ref={attach} preload="metadata" data-recording-audio="" />;
}
