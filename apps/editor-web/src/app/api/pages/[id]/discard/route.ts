import { runtimeDeps } from "@/server/deps";
import { discardPage } from "@/server/pages-api";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 何も足していないページを捨てる（空ならゴミ箱に入れずに完全に消す。空でなければ何もしない）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return discardPage(request, id, runtimeDeps);
}
