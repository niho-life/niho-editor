import { exportFolder } from "@/server/folder-api";
import { folderDeps } from "@/server/folder-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** そのページとその中のページを .md ＋写真の zip で書き出す。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return exportFolder(request, id, folderDeps);
}
