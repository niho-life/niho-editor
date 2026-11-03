import { reviewTranslationRoute } from "@/server/translation-api";
import { translationDeps } from "@/server/translation-deps";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return reviewTranslationRoute(request, id, translationDeps);
}
