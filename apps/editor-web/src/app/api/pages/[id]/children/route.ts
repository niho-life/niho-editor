import { listPageChildren } from "@/server/folder-api";
import { folderDeps } from "@/server/folder-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** そのページの中の行（フォルダの子。並びの順）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return listPageChildren(request, id, folderDeps);
}
