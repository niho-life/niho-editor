import { macLocalTranscriptionDeps } from "@/server/deps";
import { getMacLocalTranscriptionRoute, mutateMacLocalTranscriptionRoute } from "@/server/mac-local-transcription-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return getMacLocalTranscriptionRoute(request, id, macLocalTranscriptionDeps);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return mutateMacLocalTranscriptionRoute(request, id, macLocalTranscriptionDeps);
}
