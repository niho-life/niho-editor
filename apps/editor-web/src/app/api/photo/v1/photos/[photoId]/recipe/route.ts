import { photoRecipesRoutes } from "@/server/photo-recipes/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request, context: { params: Promise<{ photoId: string }> }): Promise<Response> {
  const { photoId } = await context.params;
  return photoRecipesRoutes.putRecipe(request, photoId);
}
