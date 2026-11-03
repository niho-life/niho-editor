import { getAuthProvider } from "@/auth";
import { NihoExperienceApiClient } from "@/auth/niho-experience-api";
import { errorResponse, guarded, isSameOriginRequest, jsonResponse, readJsonBody } from "@/server/http";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; decision: string }> };

export function POST(request: Request, context: Context): Promise<Response> {
  return guarded("POST /api/account/article-links/[id]/[decision]", async () => {
    const auth = getAuthProvider();
    const session = await auth.getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request)) return errorResponse("forbidden");
    const body = await readJsonBody(request, 16);
    if (!body.ok || !body.value || typeof body.value !== "object" || Array.isArray(body.value) || Object.keys(body.value).length !== 0) return errorResponse("bad_request");
    const { id, decision } = await context.params;
    if (decision !== "accept" && decision !== "decline") return errorResponse("bad_request");
    const link = await new NihoExperienceApiClient(auth).decide(session, request, id, decision);
    return jsonResponse(200, { link });
  });
}
