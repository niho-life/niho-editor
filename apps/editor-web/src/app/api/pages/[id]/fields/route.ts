import { getPageFields, patchPageFields } from "@/server/folder-api";
import { folderDeps } from "@/server/folder-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 録音ページの「この録音について」（登場人物・固有名詞・背景）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return getPageFields(request, id, folderDeps);
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return patchPageFields(request, id, folderDeps);
}
