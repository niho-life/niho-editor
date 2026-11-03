import { googleDocsBatchApiDeps } from "@/server/google-docs-batch-deps";
import { getLatestGoogleDocsBatchRoute } from "@/server/google-docs-batch-api";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ rootPageId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return getLatestGoogleDocsBatchRoute(request, (await context.params).rootPageId, googleDocsBatchApiDeps);
}
