import { candidatesDeps } from "@/server/deps";
import { listCandidateVersionsRoute } from "@/server/recording-candidates-api";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; candidateId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { id, candidateId } = await context.params;
  return listCandidateVersionsRoute(request, id, candidateId, candidatesDeps);
}
