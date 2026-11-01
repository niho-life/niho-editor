import { runtimePhotoCatalogRoutes } from "@/server/photo-catalog/routes";
export const dynamic = "force-dynamic";
export function GET(request: Request, context: RouteContext<"/api/photo/v1/photos/[photoId]">): Promise<Response> {
  return context.params.then(({ photoId }) => runtimePhotoCatalogRoutes().photo(request, photoId));
}
