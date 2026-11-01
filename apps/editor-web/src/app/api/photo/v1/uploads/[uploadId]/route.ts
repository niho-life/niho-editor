import { photoTransferRoutes } from "@/server/photo-transfer/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ uploadId: string }> }): Promise<Response> {
  const { uploadId } = await context.params;
  return photoTransferRoutes.get(request, uploadId);
}
