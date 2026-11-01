import { photoLifecycleRoutes } from "@/server/photo-lifecycle/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const { jobId } = await context.params;
  return photoLifecycleRoutes.job(request, jobId);
}
