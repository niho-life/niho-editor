import { transcriptDeps } from "@/server/deps";
import { getTranscriptRoute, patchTranscriptRoute } from "@/server/transcript-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 文字起こしのタブ（#310）の本文（段落・話者名・話者の一覧・このタブに書く最新の実行）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return getTranscriptRoute(request, id, transcriptDeps);
}

/** 段落の編集・話者名の変更・話者をまとめる・あとの .vtt を足す（1 回に 1 つ。baseRevision が古ければ 409 で最新）。 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return patchTranscriptRoute(request, id, transcriptDeps);
}
