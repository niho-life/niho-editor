import { refresh } from "@/server/auth-routes";
import { runtimeDeps } from "@/server/deps";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return refresh(request, runtimeDeps);
}
