import { getAuthProvider } from "@/auth";
import { ExperienceArticleAuthorityClient } from "@/server/experience-article-authority-client";
import { errorResponse, guarded, jsonResponse } from "@/server/http";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return guarded("GET /api/account/experience-options", async () => {
    const auth = getAuthProvider();
    const session = await auth.getSession(request);
    if (!session) return errorResponse("unauthorized");
    const search = new URL(request.url).searchParams;
    if ([...search.keys()].some((key) => key !== "q" && key !== "cursor") || search.getAll("q").length > 1 || search.getAll("cursor").length > 1) return errorResponse("bad_request");
    const query = search.get("q") ?? "";
    const cursor = search.get("cursor") ?? "";
    if (query.length > 100 || (cursor !== "" && (cursor.length > 160 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cursor)))) return errorResponse("bad_request");
    const client = new ExperienceArticleAuthorityClient();
    let categories: Awaited<ReturnType<ExperienceArticleAuthorityClient["categories"]>>;
    let candidates: Awaited<ReturnType<ExperienceArticleAuthorityClient["candidates"]>>;
    try {
      [categories, candidates] = await Promise.all([client.categories(), client.candidates(session.userId, query || undefined, cursor || undefined)]);
    } catch {
      return errorResponse("unavailable");
    }
    return jsonResponse(200, { categories, candidates: candidates.items, nextCursor: candidates.nextCursor });
  });
}
