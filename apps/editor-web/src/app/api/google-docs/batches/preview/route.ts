import { googleDocsBatchApiDeps } from "@/server/google-docs-batch-deps";
import { previewGoogleDocsBatch } from "@/server/google-docs-batch-api";

export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> { return previewGoogleDocsBatch(request, googleDocsBatchApiDeps); }
