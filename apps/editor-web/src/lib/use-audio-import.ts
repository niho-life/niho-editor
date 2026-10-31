"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioUploadFailure,
  uploadAudioFile,
  type AudioUploadFailureKind,
  type AudioUploadStage,
  type UploadAudioFileInput,
  type UploadAudioFileResult,
} from "./audio-upload-client";

/** 進み具合の段階の言葉（画面と読み上げ）。 */
export const AUDIO_STAGE_LABELS: Readonly<Record<AudioUploadStage, string>> = {
  hashing: "確認しています",
  starting: "準備しています",
  uploading: "送っています",
  completing: "仕上げています",
};

export type AudioImportProgress = { stage: AudioUploadStage; /** 0〜100 の整数。 */ percent: number };
export type AudioImportOutcome<T = UploadAudioFileResult> = { ok: true; result: T } | { ok: false; kind: AudioUploadFailureKind };

/**
 * 音声の取り込み（#36 段 3b-1。録音ページを作る `uploadAudioFile` と、あとの音声を足す `uploadAudioPart` の両方に使う）。
 * 1 本だけ走らせ、進み具合（段階と整数の %）と中止を持つ。
 * - 同じファイル（マイクの録音も）の取り込み直しには同じ Idempotency-Key を使う（同じ録音ページに戻る。ページを増やさない）。
 *   キーが別の内容に使われていた（409 など、理由が other）ときだけ、次は新しいキーにする。
 * - 画面を離れたら（unmount）中止する。
 */
export function useAudioImport<T = UploadAudioFileResult>(options: { upload?: (input: UploadAudioFileInput) => Promise<T> } = {}) {
  const [progress, setProgress] = useState<AudioImportProgress | null>(null);
  const controller = useRef<AbortController | null>(null);
  const keys = useRef(new WeakMap<Blob, string>());
  const uploadRef = useRef(options.upload ?? (uploadAudioFile as unknown as (input: UploadAudioFileInput) => Promise<T>));

  const run = useCallback(async (file: File, input: { durationSec?: number | null; lang?: "ja" | "en" } = {}): Promise<AudioImportOutcome<T>> => {
    if (controller.current) return { ok: false, kind: "other" };
    const current = new AbortController();
    controller.current = current;
    let key = keys.current.get(file);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(file, key);
    }
    let last: AudioImportProgress = { stage: "hashing", percent: 0 };
    setProgress(last);
    try {
      const result = await uploadRef.current({
        file,
        durationSec: input.durationSec,
        lang: input.lang,
        idempotencyKey: key,
        signal: current.signal,
        onProgress: ({ stage, fraction }) => {
          const percent = Math.max(0, Math.min(100, Math.floor(fraction * 100)));
          // 整数の % か段階が変わったときだけ描き直す（2 GiB の計算で何百回も描かない）
          if (stage === last.stage && percent === last.percent) return;
          last = { stage, percent };
          if (controller.current === current) setProgress(last);
        },
      });
      return { ok: true, result };
    } catch (error) {
      const kind: AudioUploadFailureKind = error instanceof AudioUploadFailure ? error.kind : "other";
      if (kind === "other") keys.current.delete(file);
      return { ok: false, kind };
    } finally {
      if (controller.current === current) {
        controller.current = null;
        setProgress(null);
      }
    }
  }, []);

  const cancel = useCallback(() => {
    controller.current?.abort();
  }, []);

  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
    },
    [],
  );

  return { progress, run, cancel };
}
