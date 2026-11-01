import type { MediaStorageUsage, OwnerId } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import { errorResponse, guarded, jsonResponse } from "./http";

/** 保存容量 API が使う集計。 */
export type StorageUsageApiDeps = {
  auth: () => AuthProvider;
  usage: () => ((owner: OwnerId) => Promise<MediaStorageUsage>) | null;
};

/** GET /api/storage/usage — 認証済み owner のクラウドメディア使用量。上限値はまだ設けない。 */
export function getStorageUsage(request: Request, deps: StorageUsageApiDeps): Promise<Response> {
  return guarded("GET /api/storage/usage", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const readUsage = deps.usage();
    if (!readUsage) return errorResponse("unavailable");
    return jsonResponse(200, { usage: await readUsage(session.userId) });
  });
}
