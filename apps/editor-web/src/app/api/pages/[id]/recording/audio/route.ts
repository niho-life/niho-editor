import { audioStreamDeps } from "@/server/deps";
import { headAudioRoute, streamAudioRoute } from "@/server/audio-stream-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 指定した音声Part（part省略時は0）を本人だけに中継する。`Range` は範囲 1 つ。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return streamAudioRoute(request, id, audioStreamDeps);
}

/** GET と同じ status・header で、本文なし。 */
export async function HEAD(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return headAudioRoute(request, id, audioStreamDeps);
}
