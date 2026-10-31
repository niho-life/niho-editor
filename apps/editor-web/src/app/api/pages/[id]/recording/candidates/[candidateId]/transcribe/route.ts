import { candidatesDeps } from "@/server/deps";
import { retryCandidateRoute } from "@/server/recording-candidates-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; candidateId: string }> };

/** その案の文字起こしをもう一度始める。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id, candidateId } = await context.params;
  return retryCandidateRoute(request, id, candidateId, candidatesDeps);
}
