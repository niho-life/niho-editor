import { transcriptDeps } from "@/server/deps";
import { listTranscriptVersionsRoute } from "@/server/transcript-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 文字起こしのタブの版（直す前の本文。新しい順・本文なし）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return listTranscriptVersionsRoute(request, id, transcriptDeps);
}
