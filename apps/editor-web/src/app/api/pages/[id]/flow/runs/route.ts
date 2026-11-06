import { createFlowRun } from "@/server/flow-api";
import { stepsDeps } from "@/server/steps-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 流れの「作成」（#309）: 今開いているタブを入力に、その段階までを作る（作り直す・同じ入力でもう 1 つも）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return createFlowRun(request, id, stepsDeps);
}
