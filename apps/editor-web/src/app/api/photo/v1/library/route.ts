import { runtimePhotoCatalogRoutes } from "@/server/photo-catalog/routes";
export const dynamic = "force-dynamic";
export function GET(request: Request): Promise<Response> { return runtimePhotoCatalogRoutes().library(request); }
