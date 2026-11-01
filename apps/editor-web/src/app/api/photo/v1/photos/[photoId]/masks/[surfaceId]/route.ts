import { photoTransferRoutes } from "@/server/photo-transfer/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ photoId: string; surfaceId: string }> }): Promise<Response> {
  const { photoId, surfaceId } = await context.params;
  return photoTransferRoutes.mask(request, photoId, surfaceId);
}
