import { importRecipeSample } from "@/server/recipe-samples-api";
import { recipeSampleApiDeps } from "@/server/recipe-sample-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ recipeId: string }> };

/** お手本文書を利用者の手順に取り込む（本文は設定JSONへ含めない）。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { recipeId } = await context.params;
  return importRecipeSample(request, recipeId, recipeSampleApiDeps);
}
