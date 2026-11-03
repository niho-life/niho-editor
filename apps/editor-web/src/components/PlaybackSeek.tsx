"use client";

import { useEffect, useState } from "react";
import { playbackClock, playbackDuration } from "@/lib/playback";

const EVENTS = ["timeupdate", "seeked", "loadedmetadata", "durationchange", "emptied"] as const;

/**
 * 録音の再生位置のスライダーと時刻（#36 段 3b-2。ShellRecording の seek に入れて、波形の代わりに出す）。
 * `<audio>` を自分で購読して描き直す（再生位置が動くたびに段落の欄まで描き直さない）。矢印・Home・End・PageUp/PageDown は
 * スライダーの標準の操作で、1 秒ずつ動く。長さが分からない間（読み込み前）は動かせない。
 * スライダーの input は文字起こしの「書いている途中」に数えないよう、外へ伝えない。
 */
export function PlaybackSeek({
  audio,
  recordingSec,
  durationSec,
  positionOf,
  onSeek,
}: {
  /** 読むだけ（再生位置と長さを購読する）。 */
  audio: HTMLAudioElement | null;
  /** 録音の長さ（ブラウザが長さを知らないときに使う）。 */
  recordingSec: number | null;
  /** 複数Partの全体時間。渡されたときは現在の`<audio>`単体の長さより優先する。 */
  durationSec?: number | null;
  /** 現在のPart内の位置を、録音全体の位置に変換する。 */
  positionOf?: (audio: HTMLAudioElement) => number;
  /** スライダーで動かした位置（秒）。 */
  onSeek: (seconds: number) => void;
}) {
  const [position, setPosition] = useState({ time: 0, media: Number.NaN });
  useEffect(() => {
    if (!audio) return undefined;
    const read = () => setPosition({ time: positionOf?.(audio) ?? audio.currentTime, media: audio.duration });
    for (const type of EVENTS) audio.addEventListener(type, read);
    read();
    return () => {
      for (const type of EVENTS) audio.removeEventListener(type, read);
    };
  }, [audio, positionOf]);

  const duration = durationSec === undefined ? playbackDuration(position.media, recordingSec) : durationSec;
  const max = duration === null ? 0 : Math.max(1, Math.floor(duration));
  const time = Math.min(Math.floor(Number.isFinite(position.time) && position.time > 0 ? position.time : 0), max);
  const clock = playbackClock(time, duration);
  return (
    <span className="es-seek">
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={time}
        disabled={duration === null || !audio}
        aria-label="再生位置"
        aria-valuetext={clock}
        onInput={(event) => event.stopPropagation()}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          onSeek(next);
          setPosition((current) => ({ ...current, time: next }));
        }}
      />
      <span className="es-time">{clock}</span>
    </span>
  );
}
