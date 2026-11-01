import { runtimePhotoCatalogRoutes } from "@/server/photo-catalog/routes";
export const dynamic = "force-dynamic";
export function POST(request: Request): Promise<Response> { return runtimePhotoCatalogRoutes().lookup(request); }
