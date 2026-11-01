import { describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "../auth/types";
import { getStorageUsage, type StorageUsageApiDeps } from "./storage-usage-api";

const ORIGIN = "http://editor.test";
const usageValue = { imageBytes: "1073741824", audioBytes: "42", totalBytes: "1073741866" };
const notUsed = async (): Promise<Response> => {
  throw new Error("the storage usage API does not call login routes");
};

function authAs(userId: string | null): AuthProvider {
  return {
    mode: "stub",
    getSession: async () => (userId ? { userId, mode: "stub" } : null),
    beginLogin: notUsed,
    completeLogin: notUsed,
    logout: notUsed,
  };
}

function request(): Request {
  return new Request(`${ORIGIN}/api/storage/usage`, { headers: { host: "editor.test" } });
}

function deps(userId: string | null, read: StorageUsageApiDeps["usage"]): StorageUsageApiDeps {
  return { auth: () => authAs(userId), usage: read };
}

describe("GET /api/storage/usage", () => {
  it("requires a session and a database-backed usage reader", async () => {
    const read = vi.fn(async () => usageValue);
    expect((await getStorageUsage(request(), deps(null, () => read))).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect((await getStorageUsage(request(), deps("synthetic-owner", () => null))).status).toBe(503);
  });

  it("scopes the query to the authenticated owner and returns private no-store JSON", async () => {
    const read = vi.fn(async (owner: string) => {
      expect(owner).toBe("synthetic-owner-a");
      return usageValue;
    });
    const response = await getStorageUsage(request(), deps("synthetic-owner-a", () => read));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ usage: usageValue });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
