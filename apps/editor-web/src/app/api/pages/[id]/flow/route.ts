import { getFlow, patchFlow } from "@/server/flow-api";
import { stepsDeps } from "@/server/steps-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 「ページ」パネルの「流れ」（#309）。`id` は開いているタブ（または `?tab=` を添えたフォルダ）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return getFlow(request, id, stepsDeps);
}

/** フォルダの手順を替える（`{ recipe }`）。 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return patchFlow(request, id, stepsDeps);
}
