import { recordPageOpen } from "@/server/folder-api";
import { folderDeps } from "@/server/folder-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** ページを開いたことを「最近」に記録する。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return recordPageOpen(request, id, folderDeps);
}
