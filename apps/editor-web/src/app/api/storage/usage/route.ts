import { getStorageUsage } from "@/server/storage-usage-api";
import { storageUsageDeps } from "@/server/storage-usage-deps";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return getStorageUsage(request, storageUsageDeps);
}
