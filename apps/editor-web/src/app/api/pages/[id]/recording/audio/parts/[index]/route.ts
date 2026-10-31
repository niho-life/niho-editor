import { audioDeps } from "@/server/deps";
import { discardAudioPartRoute } from "@/server/audio-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; index: string }> };

/** アップロードが済んでいない 2 本目以降の音声を取り除く（#36 段 3b-4）。 */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  const { id, index } = await context.params;
  return discardAudioPartRoute(request, id, index, audioDeps);
}
