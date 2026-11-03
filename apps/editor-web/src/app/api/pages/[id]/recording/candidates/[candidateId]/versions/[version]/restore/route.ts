import { candidatesDeps } from "@/server/deps";
import { restoreCandidateVersionRoute } from "@/server/recording-candidates-api";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; candidateId: string; version: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  const { id, candidateId, version } = await context.params;
  return restoreCandidateVersionRoute(request, id, candidateId, version, candidatesDeps);
}
