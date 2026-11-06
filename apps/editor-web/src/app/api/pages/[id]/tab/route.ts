import { patchTab } from "@/server/pages-api";
import { runtimeDeps } from "@/server/deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** タブの名前を変える（`{ name }`。#308）・別の入れ物へ移す（`{ page: id }`。#307）。 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return patchTab(request, id, runtimeDeps);
}
