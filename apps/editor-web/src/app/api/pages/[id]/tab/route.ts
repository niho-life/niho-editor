import { moveTab } from "@/server/pages-api";
import { runtimeDeps } from "@/server/deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** タブを別の入れ物へ移す（`{ page: id }`。#307）。 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return moveTab(request, id, runtimeDeps);
}
