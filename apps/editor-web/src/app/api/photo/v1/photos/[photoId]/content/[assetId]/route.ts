import { photoTransferRoutes } from "@/server/photo-transfer/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ photoId: string; assetId: string }> }): Promise<Response> {
  const { photoId, assetId } = await context.params;
  return photoTransferRoutes.content(request, photoId, assetId);
}
