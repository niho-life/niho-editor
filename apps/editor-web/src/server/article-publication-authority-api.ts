import "server-only";
import { getDraftPage, getPublication, getPublicationVersion, isPageId, type Queryable } from "@niho/editor-store";
import { verifyGoogleOidc, type OidcVerifyResult } from "./google-oidc";
import { errorResponse, guarded, jsonResponse, notFoundResponse, readJsonBody } from "./http";

const BEARER = /^Bearer ([A-Za-z0-9._-]{1,16384})$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface PublicationAuthorityDeps {
  readonly settings: () => { enabled: boolean; audience: string; allowedEmails: readonly string[] };
  readonly verify: (token: string, expected: { audience: string; allowedEmail: string }) => Promise<OidcVerifyResult>;
  readonly db: () => Queryable | null;
}

export function publicationAuthoritySettings(env: Readonly<Record<string, string | undefined>> = process.env) {
  if (env.EDITOR_ARTICLE_AUTHORITY_API_ENABLED !== "true") return { enabled: false, audience: "", allowedEmails: [] };
  const audience = env.EDITOR_ARTICLE_AUTHORITY_AUDIENCE?.trim() ?? "";
  const allowedEmails = [...new Set((env.EDITOR_ARTICLE_AUTHORITY_SERVICE_ACCOUNT_EMAILS ?? "").split(",").map((item) => item.trim()).filter((item) => /^[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9-]*\.iam\.gserviceaccount\.com$/.test(item)))];
  return { enabled: Boolean(audience && allowedEmails.length), audience, allowedEmails };
}

function relatedOf(snapshot: unknown): readonly string[] | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const related = (snapshot as Record<string, unknown>).related;
  if (!Array.isArray(related) || related.length > 20 || new Set(related).size !== related.length || related.some((slug) => typeof slug !== "string" || slug.length > 160 || !SLUG.test(slug))) return null;
  return related as string[];
}

export function publicationAuthorityRoute(request: Request, deps: PublicationAuthorityDeps): Promise<Response> {
  return guarded("POST /internal/article-authority/v1/publication", async () => {
    const settings = deps.settings();
    if (!settings.enabled) return notFoundResponse();
    const token = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return errorResponse("unauthorized");
    let verified = false;
    for (const allowedEmail of settings.allowedEmails) {
      if ((await deps.verify(token, { audience: settings.audience, allowedEmail })).ok) { verified = true; break; }
    }
    if (!verified) return errorResponse("unauthorized");
    if (request.headers.get("origin") !== null) return errorResponse("forbidden");
    const db = deps.db();
    if (!db) return errorResponse("unavailable");
    const parsed = await readJsonBody(request, 4096);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) return errorResponse("bad_request");
    const body = parsed.value as Record<string, unknown>;
    if (Object.keys(body).sort().join(",") !== "publicationId,version" || typeof body.publicationId !== "string" || !isPageId(body.publicationId)
      || !Number.isSafeInteger(body.version) || (body.version as number) < 1) return errorResponse("bad_request");
    const publication = await getPublication(db, body.publicationId);
    if (!publication || publication.dest !== "exp" || publication.handle !== "exp" || publication.stoppedAt !== null || publication.version !== body.version) return notFoundResponse();
    const [page, version] = await Promise.all([getDraftPage(db, body.publicationId), getPublicationVersion(db, body.publicationId, body.version as number)]);
    const slugs = version ? relatedOf(version.snapshot) : null;
    if (!page || !version || version.handle !== "exp" || slugs === null) return notFoundResponse();
    return jsonResponse(200, { version: 1, writerNihoUserId: page.ownerId, slugs });
  });
}

export const defaultPublicationAuthorityVerifier = verifyGoogleOidc;
