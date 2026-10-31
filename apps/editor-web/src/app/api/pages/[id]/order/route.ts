import { movePageOrder } from "@/server/folder-api";
import { folderDeps } from "@/server/folder-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 手動の並びを 1 つ動かす（`{ move: "up" | "down" }`）。 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return movePageOrder(request, id, folderDeps);
}
