import { photoLifecycleRoutes } from "@/server/photo-lifecycle/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ photoId: string }> }): Promise<Response> {
  const { photoId } = await context.params;
  return photoLifecycleRoutes.restore(request, photoId);
}
