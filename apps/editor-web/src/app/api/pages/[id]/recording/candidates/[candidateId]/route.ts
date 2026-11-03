import { candidatesDeps } from "@/server/deps";
import { deleteCandidateRoute, getCandidateRoute, updateCandidateRoute } from "@/server/recording-candidates-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; candidateId: string }> };

/** 文字起こしの案 1 つ（本文つき。見比べる画面が読む）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id, candidateId } = await context.params;
  return getCandidateRoute(request, id, candidateId, candidatesDeps);
}

/** 要らなくなった案を消す（採用中・実行中は消せない）。 */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  const { id, candidateId } = await context.params;
  return deleteCandidateRoute(request, id, candidateId, candidatesDeps);
}

/** 名前、または非採用案の本文・話者名を candidate revision CAS で保存する。 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { id, candidateId } = await context.params;
  return updateCandidateRoute(request, id, candidateId, candidatesDeps);
}
