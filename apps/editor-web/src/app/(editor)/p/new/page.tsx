import { NewPage, RecordingStartScreen } from "@/components/FramePages";
import { StoreUnavailable } from "@/components/Notice";
import { audioLimits } from "@/recording/audio-limits";
import { getStore } from "@/server/db";
import { requireSession } from "@/server/session";
import { resolveTranscriptionEngines } from "@/transcription/config";

export const dynamic = "force-dynamic";

/** 新しいページ（題名か本文を入力した時点で作り、`/p/{id}` になる）。`?from=recording` は録音の開始の画面。 */
export default async function NewPageView(props: { searchParams: Promise<{ from?: string | string[] }> }) {
  const { from } = await props.searchParams;
  const recording = from === "recording";
  await requireSession(recording ? "/p/new?from=recording" : "/p/new");
  if (!getStore()) return <StoreUnavailable />;
  // 上限（長さ・容量・クラウドの音声を残す日数）は、画面の案内のためにそのまま渡す（要求を増やさない）
  return recording ? <RecordingStartScreen limits={audioLimits()} transcriptionEngine={resolveTranscriptionEngines(process.env)?.default ?? null} /> : <NewPage />;
}
