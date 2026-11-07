import { recordingDeps } from "@/server/deps";
import { getRecordingRoute } from "@/server/recordings-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 録音（音声・長さ・実行・文字起こしのタブの一覧）。段落と話者は文字起こしのタブ（`/api/pages/{タブ}/transcript`）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return getRecordingRoute(request, id, recordingDeps);
}
