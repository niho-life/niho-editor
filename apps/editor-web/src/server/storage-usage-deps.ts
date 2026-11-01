import "server-only";
import { getMediaStorageUsage } from "@niho/editor-store";
import { getAuthProvider } from "../auth";
import { getPool } from "./db";
import type { StorageUsageApiDeps } from "./storage-usage-api";

/** 保存容量 route の実行時依存。DB 接続は要求ごとに遅延して決め、getStore と Pool を共有する。 */
export const storageUsageDeps: StorageUsageApiDeps = {
  auth: () => getAuthProvider(),
  usage: () => {
    const pool = getPool();
    return pool ? (owner) => getMediaStorageUsage(pool, owner) : null;
  },
};
