import { googleDocsBatchApiDeps } from "@/server/google-docs-batch-deps";
import { cancelGoogleDocsBatchRoute, getGoogleDocsBatchRoute } from "@/server/google-docs-batch-api";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ jobId: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  return getGoogleDocsBatchRoute(request, (await context.params).jobId, googleDocsBatchApiDeps);
}
export async function DELETE(request: Request, context: Context): Promise<Response> {
  return cancelGoogleDocsBatchRoute(request, (await context.params).jobId, googleDocsBatchApiDeps);
}
