import { startPhotoLogin } from "@/server/auth-routes";
import { runtimeDeps } from "@/server/deps";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return startPhotoLogin(request, runtimeDeps);
}
