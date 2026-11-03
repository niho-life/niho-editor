import { adoptTranslationRoute } from "@/server/translation-api";
import { translationDeps } from "@/server/translation-deps";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; proposalId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  const { id, proposalId } = await context.params;
  return adoptTranslationRoute(request, id, proposalId, translationDeps);
}
