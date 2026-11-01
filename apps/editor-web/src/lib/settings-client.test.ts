import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_MESSAGES } from "@/settings/messages";
import { loadStorageUsage } from "./settings-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadStorageUsage", () => {
  it("loads owner-scoped media byte totals without browser caching", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ usage: { totalBytes: "12", imageBytes: "10", audioBytes: "2" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    expect(await loadStorageUsage()).toEqual({ ok: true, usage: { totalBytes: "12", imageBytes: "10", audioBytes: "2" } });
    expect(fetch).toHaveBeenCalledWith("/api/storage/usage", { credentials: "same-origin", cache: "no-store" });
  });

  it("rejects malformed or inconsistent totals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ usage: { totalBytes: "11", imageBytes: "10", audioBytes: "2" } }), { status: 200 })));

    expect(await loadStorageUsage()).toMatchObject({ ok: false, message: SETTINGS_MESSAGES.storageUsageFailed });
  });
});
