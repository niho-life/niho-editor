import { publicationAuthorityRoute } from "@/server/article-publication-authority-api";

export const dynamic = "force-dynamic";

export function POST(): Promise<Response> {
  return publicationAuthorityRoute();
}
