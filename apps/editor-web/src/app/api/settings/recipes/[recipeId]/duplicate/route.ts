import { duplicateSettingsRecipe } from "@/server/settings-api";
import { settingsDeps } from "@/server/settings-deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ recipeId: string }> };

/** その人の手順と登録済みのお手本文を、別の owner-scoped 手順として複製する。 */
export async function POST(request: Request, context: Context): Promise<Response> {
  const { recipeId } = await context.params;
  return duplicateSettingsRecipe(request, recipeId, settingsDeps);
}
