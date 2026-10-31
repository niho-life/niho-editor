import { candidatesDeps } from "@/server/deps";
import { adoptCandidateRoute } from "@/server/recording-candidates-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; candidateId: string }> };

/** その案を採用する（正本に写す。それまでの本文は採用中だった案に残る）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id, candidateId } = await context.params;
  return adoptCandidateRoute(request, id, candidateId, candidatesDeps);
}
