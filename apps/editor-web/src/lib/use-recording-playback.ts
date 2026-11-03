"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecordingSegment } from "@niho/editor-store";
import { playbackPartAt, playbackPartMessage, playbackSrc, playbackTimelineDuration, segmentAt, segmentTimeline, type PlaybackPart } from "./playback";

/** load: 音声を読めない（404・ネットワーク・形式に非対応）/ play: 再生を始められない。 */
export type PlaybackProblem = "load" | "play";

export type RecordingPlayback = {
  /** `<audio>` に付ける ref。現在のPartを同じoriginの認証付きrouteから取得する。 */
  ref: (node: HTMLAudioElement | null) => (() => void) | undefined;
  element: HTMLAudioElement | null;
  playing: boolean;
  problem: PlaybackProblem | null;
  notice: string | null;
  currentPartIndex: number | null;
  currentId: string | null;
  durationSec: number | null;
  /** PlaybackSeek が全体時間を読む。位置の更新で録音本文を描き直さない。 */
  positionOf: (node: HTMLAudioElement) => number;
  toggle: () => void;
  playFrom: (seconds: number) => void;
  seekTo: (seconds: number) => void;
  previousPart: () => void;
  nextPart: () => void;
  canGoPrevious: boolean;
  canGoNext: boolean;
  retry: () => void;
};

type PendingSwitch = { partIndex: number; localTime: number; autoplay: boolean };

/** 録音の複数音声Partを、offsetを保った一つの時間軸として再生・シークする。 */
export function useRecordingPlayback(pageId: string, parts: readonly PlaybackPart[], segments: readonly Pick<RecordingSegment, "start">[]): RecordingPlayback {
  const initialIndex = parts.find((part) => part.state === "ready")?.partIndex ?? null;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeRef = useRef<PlaybackPart | null>(parts.find((part) => part.partIndex === initialIndex) ?? null);
  const partsRef = useRef(parts);
  const pendingRef = useRef<PendingSwitch | null>(null);
  const [element, setElement] = useState<HTMLAudioElement | null>(null);
  const [activePartIndex, setActivePartIndex] = useState<number | null>(initialIndex);
  const [playing, setPlaying] = useState(false);
  const [problem, setProblem] = useState<PlaybackProblem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const segmentIndex = useMemo(() => segmentTimeline(segments), [segments]);
  const durationSec = useMemo(() => playbackTimelineDuration(parts, null), [parts]);
  const activePart = parts.find((part) => part.partIndex === activePartIndex && part.state === "ready") ?? parts.find((part) => part.state === "ready") ?? null;
  const selectedPartIndex = activePart?.partIndex ?? null;

  // 非同期イベントから参照する時間軸と選択Partを、描画後に最新化する。
  useEffect(() => {
    partsRef.current = parts;
    activeRef.current = activePart;
  }, [activePart, parts]);

  const source = selectedPartIndex === null ? null : playbackSrc(pageId, selectedPartIndex);
  const ref = useCallback(
    (node: HTMLAudioElement | null) => {
      audioRef.current = node;
      setElement(node);
      if (!node) return undefined;
      if (source !== null && node.getAttribute("src") !== source) {
        node.setAttribute("src", source);
        node.load();
      }
      return () => {
        node.pause();
        node.removeAttribute("src");
        node.load();
        if (audioRef.current === node) audioRef.current = null;
        setElement((current) => (current === node ? null : current));
        setPlaying(false);
        setProblem(null);
        setNotice(null);
        setCurrentId(null);
      };
    },
    [setCurrentId, setElement, setNotice, setPlaying, setProblem, source],
  );

  const play = useCallback(async (node: HTMLAudioElement) => {
    try {
      await node.play();
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError") return;
      if (!node.error) setProblem("play");
    }
  }, [setProblem]);

  const updateCurrent = useCallback((node: HTMLAudioElement) => {
    const active = activeRef.current;
    const globalTime = active ? active.offsetSec + node.currentTime : node.currentTime;
    const id = !node.paused || globalTime > 0 ? segmentAt(segmentIndex, globalTime) : null;
    setCurrentId((current) => (current === id ? current : id));
  }, [segmentIndex]);

  const switchPart = useCallback((part: PlaybackPart, localTime: number, autoplay: boolean) => {
    const node = audioRef.current;
    if (!node || part.state !== "ready") return;
    activeRef.current = part;
    pendingRef.current = { partIndex: part.partIndex, localTime: Math.max(0, localTime), autoplay };
    setActivePartIndex(part.partIndex);
    setCurrentId(null);
    setProblem(null);
  }, [setActivePartIndex, setCurrentId, setProblem]);

  useEffect(() => {
    const node = element;
    if (!node) return undefined;
    const onPlay = () => {
      setPlaying(true);
      setProblem(null);
      updateCurrent(node);
    };
    const onPause = () => {
      setPlaying(false);
      updateCurrent(node);
    };
    const onEnded = () => {
      setPlaying(false);
      const active = activeRef.current;
      if (!active) return;
      const next = partsRef.current.find((part) => part.partIndex > active.partIndex && part.state === "ready");
      if (!next) return;
      const skipped = partsRef.current.some((part) => part.partIndex > active.partIndex && part.partIndex < next.partIndex && part.state !== "ready");
      if (skipped) setNotice("再生できない音声Partを飛ばして、次の音声へ移動しました。音声一覧の状態をご確認ください。");
      switchPart(next, 0, true);
    };
    const onLoadedMetadata = () => {
      const pending = pendingRef.current;
      if (!pending || pending.partIndex !== activeRef.current?.partIndex) return;
      pendingRef.current = null;
      const max = Number.isFinite(node.duration) && node.duration > 0 ? node.duration : pending.localTime;
      node.currentTime = Math.min(pending.localTime, max);
      updateCurrent(node);
      if (pending.autoplay) void play(node);
    };
    const onError = () => {
      if (!node.getAttribute("src")) return;
      setPlaying(false);
      setProblem("load");
    };
    const onLoaded = () => setProblem((current) => (current === "load" ? null : current));
    const listeners: [string, () => void][] = [
      ["play", onPlay], ["pause", onPause], ["ended", onEnded], ["timeupdate", () => updateCurrent(node)],
      ["seeked", () => updateCurrent(node)], ["loadedmetadata", onLoadedMetadata], ["error", onError], ["canplay", onLoaded],
    ];
    for (const [type, listener] of listeners) node.addEventListener(type, listener);
    setPlaying(!node.paused);
    updateCurrent(node);
    return () => {
      for (const [type, listener] of listeners) node.removeEventListener(type, listener);
    };
  }, [activePartIndex, element, play, switchPart, updateCurrent]);

  const seekTo = useCallback((seconds: number, autoplay = audioRef.current ? !audioRef.current.paused : false) => {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const target = playbackPartAt(partsRef.current, seconds);
    if (!target || target.state !== "ready") {
      setNotice(playbackPartMessage(target) || "この時間の音声はありません。");
      return;
    }
    setNotice(null);
    const localTime = seconds - target.offsetSec;
    const node = audioRef.current;
    if (!node) return;
    if (target.partIndex === activeRef.current?.partIndex) {
      node.currentTime = localTime;
      if (autoplay) void play(node);
      updateCurrent(node);
    } else switchPart(target, localTime, autoplay);
  }, [play, setNotice, switchPart, updateCurrent]);

  const playFrom = useCallback((seconds: number) => seekTo(seconds, true), [seekTo]);
  const toggle = useCallback(() => {
    const node = audioRef.current;
    if (!node) return;
    if (node.paused || node.ended) void play(node);
    else node.pause();
  }, [play]);

  const movePart = useCallback((direction: -1 | 1) => {
    const current = activeRef.current;
    if (!current) return;
    const candidate = direction > 0
      ? partsRef.current.find((part) => part.partIndex > current.partIndex && part.state === "ready")
      : [...partsRef.current].reverse().find((part) => part.partIndex < current.partIndex && part.state === "ready");
    if (!candidate) return;
    const skipped = direction > 0
      ? partsRef.current.some((part) => part.partIndex > current.partIndex && part.partIndex < candidate.partIndex && part.state !== "ready")
      : partsRef.current.some((part) => part.partIndex < current.partIndex && part.partIndex > candidate.partIndex && part.state !== "ready");
    setNotice(skipped ? "再生できない音声Partを飛ばしました。音声一覧の状態をご確認ください。" : null);
    switchPart(candidate, 0, audioRef.current ? !audioRef.current.paused : false);
  }, [setNotice, switchPart]);
  const previousPart = useCallback(() => movePart(-1), [movePart]);
  const nextPart = useCallback(() => movePart(1), [movePart]);
  const retry = useCallback(() => {
    const node = audioRef.current;
    if (!node) return;
    setProblem(null);
    node.load();
  }, [setProblem]);
  const positionOf = useCallback((node: HTMLAudioElement) => {
    const active = activeRef.current;
    return active && audioRef.current === node ? active.offsetSec + node.currentTime : 0;
  }, []);

  const playableBefore = selectedPartIndex !== null && parts.some((part) => part.partIndex < selectedPartIndex && part.state === "ready");
  const playableAfter = selectedPartIndex !== null && parts.some((part) => part.partIndex > selectedPartIndex && part.state === "ready");
  return {
    ref, element, playing, problem, notice, currentPartIndex: selectedPartIndex, currentId, durationSec, positionOf,
    toggle, playFrom, seekTo, previousPart, nextPart,
    canGoPrevious: playableBefore, canGoNext: playableAfter, retry,
  };
}
