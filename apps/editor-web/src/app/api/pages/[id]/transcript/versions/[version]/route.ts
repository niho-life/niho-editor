import { transcriptDeps } from "@/server/deps";
import { getTranscriptVersionRoute } from "@/server/transcript-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; version: string }> };

/** 文字起こしのタブの 1 つの版（本文つき）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id, version } = await context.params;
  return getTranscriptVersionRoute(request, id, version, transcriptDeps);
}
