import { transcriptDeps } from "@/server/deps";
import { restoreTranscriptVersionRoute } from "@/server/transcript-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; version: string }> };

/** 文字起こしのタブをその版に戻す（今の本文は版に残る。baseRevision が古ければ 409 で最新）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id, version } = await context.params;
  return restoreTranscriptVersionRoute(request, id, version, transcriptDeps);
}
