import { getAuthProvider } from "@/auth";
import { NihoExperienceApiClient } from "@/auth/niho-experience-api";
import { guarded, errorResponse, jsonResponse } from "@/server/http";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return guarded("GET /api/account/article-links", async () => {
    if (new URL(request.url).search) return errorResponse("bad_request");
    const auth = getAuthProvider();
    const session = await auth.getSession(request);
    if (!session) return errorResponse("unauthorized");
    const client = new NihoExperienceApiClient(auth);
    const [roles, links] = await Promise.all([client.roles(session, request), client.links(session, request)]);
    return jsonResponse(200, { roles, links });
  });
}
