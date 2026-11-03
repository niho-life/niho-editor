import { candidatesDeps } from "@/server/deps";
import { getCandidateVersionRoute } from "@/server/recording-candidates-api";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; candidateId: string; version: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { id, candidateId, version } = await context.params;
  return getCandidateVersionRoute(request, id, candidateId, version, candidatesDeps);
}
