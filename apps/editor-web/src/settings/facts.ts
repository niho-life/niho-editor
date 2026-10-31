import "server-only";
import type { StorageMode } from "@niho/editor-publish";
import type { Session } from "../auth/types";
import { storageModeReaderOf } from "../publish/ports";
import { audioLimits } from "../recording/audio-limits";
import { resolveTranscriptionConfig, type TranscriptionEnv } from "../transcription/config";

/**
 * 設定の画面に出す「変えられない事実」（Issue #108）。どれもサーバー側が持っているもので、画面は読むだけ。
 *
 * - 文字起こしのエンジン: `EDITOR_TRANSCRIBE_ENGINE`（src/transcription/config.ts）。Web からは選べない。
 *   Gemini は長い音声の区切りがサーバー側に無いので、まだ出さない（config.ts の方式に無い）。
 * - 音声の上限と、クラウドの音声が消えるまでの日数: src/recording/audio-limits.ts。
 * - 保存先: 公開と同じ読み手（src/publish/ports.ts の storageModeReaderOf）。NIHO から毎回読み、editor に保存しない（設計 §2.1）。
 *   Web では選べない（ブラウザの保存領域は消えることがあるため）。
 *
 * 鍵は読まない（`resolveTranscriptionConfig` の戻り値の `apiKey` には触れず、方式の名前だけを取る）。
 * 設定の誤りは起動時の検査が止めるので、ここは後ろの守りとして `off` にする（値も理由も画面に出さない）。
 */

/** 画面に出す文字起こしの方式。`fake` は開発・CI の偽物、`off` は使わない設定（または設定の誤り）。 */
export type TranscribeEngineFact = "deepgram" | "fake" | "gemini" | "off";

export type SettingsFacts = {
  transcription: {
    engine: TranscribeEngineFact;
    /** 1 回の文字起こしの時間切れ（秒）。`off` のときは null。 */
    timeoutSec: number | null;
    audio: ReturnType<typeof audioLimits>;
  };
  /** 保存先（`UNSET` は未選択。クラウドと同じ扱い）。 */
  storage: StorageMode;
};

export function transcriptionFact(env: TranscriptionEnv = process.env): SettingsFacts["transcription"] {
  const audio = audioLimits();
  let config;
  try {
    config = resolveTranscriptionConfig(env);
  } catch {
    return { engine: "off", timeoutSec: null, audio };
  }
  if (config.engine === "off") return { engine: "off", timeoutSec: null, audio };
  return { engine: config.engine, timeoutSec: Math.round(config.timeoutMs / 1000), audio };
}

export async function settingsFacts(session: Session, env: TranscriptionEnv = process.env): Promise<SettingsFacts> {
  return {
    transcription: transcriptionFact(env),
    storage: await storageModeReaderOf(session).read(session.userId),
  };
}
