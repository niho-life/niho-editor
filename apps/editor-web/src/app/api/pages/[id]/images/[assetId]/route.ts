import { imageDeps } from "@/server/deps";
import { deleteImageRoute } from "@/server/images-api";

/** このページの写真から外す（アップロード中の取消も同じ）。 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string; assetId: string }> }): Promise<Response> {
  const { id, assetId } = await context.params;
  return deleteImageRoute(request, id, assetId, imageDeps);
}
