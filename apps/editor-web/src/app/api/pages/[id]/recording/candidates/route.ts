import { candidatesDeps } from "@/server/deps";
import { addCandidateRoute } from "@/server/recording-candidates-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 別のエンジンの文字起こしの案を作って、その案の実行を積む（#36 段 3b-4）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return addCandidateRoute(request, id, candidatesDeps);
}
