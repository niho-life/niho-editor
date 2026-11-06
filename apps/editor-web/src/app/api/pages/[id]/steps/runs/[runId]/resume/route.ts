import { resumeStepRun } from "@/server/steps-api";
import { stepsDeps } from "@/server/steps-deps";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string; runId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  const { id, runId } = await context.params;
  return resumeStepRun(request, id, runId, stepsDeps);
}
