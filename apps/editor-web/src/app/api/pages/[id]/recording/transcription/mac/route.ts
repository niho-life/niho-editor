import { macTranscriptionDeps } from "@/server/deps";
import { getMacTranscriptionRoute, mutateMacTranscriptionRoute } from "@/server/mac-transcription-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return getMacTranscriptionRoute(request, id, macTranscriptionDeps);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return mutateMacTranscriptionRoute(request, id, macTranscriptionDeps);
}
