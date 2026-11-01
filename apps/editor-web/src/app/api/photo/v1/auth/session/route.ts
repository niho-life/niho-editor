import { PhotoAuthError, verifyPhotoActor } from "@/server/photo-auth";
import { photoAuthRuntimeDeps } from "@/server/photo-auth/runtime";

export const dynamic = "force-dynamic";

const SAFE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
} as const;

export async function GET(request: Request): Promise<Response> {
  try {
    const result = await verifyPhotoActor(request, photoAuthRuntimeDeps);
    return Response.json({
      sessionId: result.actor.sessionId,
      userId: result.actor.userId,
      expiresAt: result.actor.expiresAt,
      refreshRequired: result.refreshRequired,
    }, { headers: SAFE_HEADERS });
  } catch (error) {
    if (error instanceof PhotoAuthError) {
      return Response.json({ error: error.code, retryable: error.retryable }, {
        status: error.status,
        headers: SAFE_HEADERS,
      });
    }
    return Response.json({ error: "internal" }, { status: 500, headers: SAFE_HEADERS });
  }
}
