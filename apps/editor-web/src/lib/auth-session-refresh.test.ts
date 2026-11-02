// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextAuthRefreshDelay, refreshAuthSession } from "./auth-session-refresh";

const LAST_REFRESH_KEY = "niho-editor-auth-refreshed-at";

describe("auth session refresh", () => {
  beforeEach(() => localStorage.clear());

  it("keeps the refresh deadline tied to the last success across remounts", () => {
    const now = Date.now();
    localStorage.setItem(LAST_REFRESH_KEY, String(now - 30 * 60 * 1000));
    expect(nextAuthRefreshDelay(now)).toBe(5 * 60 * 1000);
  });

  it("refreshes the HttpOnly cookies through the same-origin route and records success", async () => {
    const now = Date.now();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(refreshAuthSession({ fetcher, now: () => now })).resolves.toBe("refreshed");
    expect(fetcher).toHaveBeenCalledWith("/auth/refresh", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    }));
    expect(localStorage.getItem(LAST_REFRESH_KEY)).toBe(String(now));
  });

  it("does not retry a fresh success unless login recovery explicitly asks", async () => {
    const now = Date.now();
    localStorage.setItem(LAST_REFRESH_KEY, String(now - 60_000));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(refreshAuthSession({ fetcher, now: () => now })).resolves.toBe("skipped");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(refreshAuthSession({ fetcher, now: () => now, force: true })).resolves.toBe("refreshed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("classifies an expired session separately from a temporary upstream failure", async () => {
    const now = Date.now();
    const unauthorized = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(refreshAuthSession({ fetcher: unauthorized, now: () => now })).resolves.toBe("unauthorized");
    await expect(refreshAuthSession({ fetcher: unavailable, now: () => now })).resolves.toBe("unavailable");
  });
});
