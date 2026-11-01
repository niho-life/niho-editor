import { logoutPhoto } from "@/server/auth-routes";
import { runtimeDeps } from "@/server/deps";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return logoutPhoto(request, runtimeDeps);
}
