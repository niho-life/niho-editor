import { getPool } from "@/server/db";
import { defaultPublicationAuthorityVerifier, publicationAuthorityRoute, publicationAuthoritySettings } from "@/server/article-publication-authority-api";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return publicationAuthorityRoute(request, {
    settings: () => publicationAuthoritySettings(process.env),
    verify: defaultPublicationAuthorityVerifier,
    db: () => getPool(),
  });
}
