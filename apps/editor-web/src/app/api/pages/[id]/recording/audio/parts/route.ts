import { audioDeps } from "@/server/deps";
import { startAudioPartRoute } from "@/server/audio-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 2 本目以降の音声のアップロードを始める（#36 段 3b-4）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return startAudioPartRoute(request, id, audioDeps);
}
