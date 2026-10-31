import { audioDeps } from "@/server/deps";
import { completeAudioPartRoute } from "@/server/audio-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; index: string }> };

/** 2 本目以降の音声のアップロードの完了（#36 段 3b-4）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id, index } = await context.params;
  return completeAudioPartRoute(request, id, index, audioDeps);
}
