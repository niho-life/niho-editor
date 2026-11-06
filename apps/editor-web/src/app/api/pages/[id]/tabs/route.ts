import { createTab, getTabs, reorderTabs } from "@/server/pages-api";
import { runtimeDeps } from "@/server/deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 入れ物とタブ（`{ page, tab, tabs }`。id はタブでも入れ物でもよい。#307）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return getTabs(request, id, runtimeDeps);
}

/** 入れ物にまっさらなタブを足す（帯の右端の ＋。`{ title? }`）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return createTab(request, id, runtimeDeps);
}

/** タブの並びを決める（`{ ids: [...] }`）。 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return reorderTabs(request, id, runtimeDeps);
}
