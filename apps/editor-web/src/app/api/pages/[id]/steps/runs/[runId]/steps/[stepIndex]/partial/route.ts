import { getStepPartialOutput } from "@/server/steps-api";
import { stepsDeps } from "@/server/steps-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; runId: string; stepIndex: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { id, runId, stepIndex } = await context.params;
  return getStepPartialOutput(request, id, runId, stepIndex, stepsDeps);
}
