import { googleDocsBatchApiDeps } from "@/server/google-docs-batch-deps";
import { retryGoogleDocsBatchRoute } from "@/server/google-docs-batch-api";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ jobId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  return retryGoogleDocsBatchRoute(request, (await context.params).jobId, googleDocsBatchApiDeps);
}
