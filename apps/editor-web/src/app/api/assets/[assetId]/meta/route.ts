import { imageDeps } from "@/server/deps";
import { imageMetadataRoute } from "@/server/images-api";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ assetId: string }> }): Promise<Response> {
  const { assetId } = await context.params;
  return imageMetadataRoute(request, assetId, imageDeps);
}
