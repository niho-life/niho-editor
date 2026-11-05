import { imageDeps } from "@/server/deps";
import { listImagesRoute } from "@/server/images-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** このページの写真（パネル）。済んだ画像を新しい順に最大 100 枚。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return listImagesRoute(request, id, imageDeps);
}
