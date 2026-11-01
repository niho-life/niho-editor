import { photoTransferRoutes } from "@/server/photo-transfer/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ uploadId: string }> }): Promise<Response> {
  const { uploadId } = await context.params;
  return photoTransferRoutes.cancel(request, uploadId);
}
