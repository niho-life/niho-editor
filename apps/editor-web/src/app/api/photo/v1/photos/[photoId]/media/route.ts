import { photoMediaRoutes } from "@/server/photo-media/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ photoId: string }> }): Promise<Response> {
  const { photoId } = await context.params;
  return photoMediaRoutes.ensure(request, photoId);
}
