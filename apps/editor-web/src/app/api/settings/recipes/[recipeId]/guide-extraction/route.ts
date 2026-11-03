import { extractRecipeGuide, getRecipeGuideExtraction } from "@/server/recipe-samples-api";
import { recipeSampleApiDeps } from "@/server/recipe-sample-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ recipeId: string }> };

/** 最後に確認できる文書ガイド・固有名詞抽出案（本文は返さない）。 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { recipeId } = await context.params;
  return getRecipeGuideExtraction(request, recipeId, recipeSampleApiDeps);
}

/** 保存済みのお手本文書から、確認用の抽出案を作る。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { recipeId } = await context.params;
  return extractRecipeGuide(request, recipeId, recipeSampleApiDeps);
}
