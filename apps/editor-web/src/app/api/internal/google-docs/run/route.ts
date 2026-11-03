import { googleDocsBatchWorkerDeps } from "@/server/google-docs-batch-deps";
import { runGoogleDocsBatchTask } from "@/server/google-docs-batch-worker-api";

export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> { return runGoogleDocsBatchTask(request, googleDocsBatchWorkerDeps); }
