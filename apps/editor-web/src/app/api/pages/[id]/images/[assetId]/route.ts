import { imageDeps } from "@/server/deps";
import { cancelImageRoute } from "@/server/images-api";

export async function DELETE(request: Request, context: { params: Promise<{ id: string; assetId: string }> }): Promise<Response> {
  const { id, assetId } = await context.params;
  return cancelImageRoute(request, id, assetId, imageDeps);
}
