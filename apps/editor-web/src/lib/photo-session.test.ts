import { afterEach, describe, expect, it, vi } from "vitest";
import { library } from "@niho/photo-library-contract/fixtures";
import { loadPhotoSession } from "./photo-session";

const session = { userId: library.owner.userId, sessionId: "session-a", expiresAt: "2099-01-01T00:00:00Z", refreshRequired: false };
const response = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });

afterEach(() => vi.unstubAllGlobals());

describe("photo session gate", () => {
  it("keeps 401 closed and distinguishes retryable 503", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(401, {})).mockResolvedValueOnce(response(503, {})));
    const signal = new AbortController().signal;
    expect(await loadPhotoSession(signal)).toEqual({ kind: "login" });
    expect(await loadPhotoSession(signal)).toEqual({ kind: "unavailable" });
  });

  it("rejects expired or malformed sessions and a library owned by another user", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(200, { ...session, expiresAt: "2000-01-01T00:00:00Z" }))
      .mockResolvedValueOnce(response(200, { ...session, expiresAt: "not-a-date" }))
      .mockResolvedValueOnce(response(200, session)).mockResolvedValueOnce(response(200, {
        ...library, owner: { type: "user", userId: "different-user" },
      }));
    vi.stubGlobal("fetch", fetcher);
    expect(await loadPhotoSession(new AbortController().signal)).toEqual({ kind: "login" });
    expect(await loadPhotoSession(new AbortController().signal)).toEqual({ kind: "login" });
    expect(await loadPhotoSession(new AbortController().signal)).toEqual({ kind: "error" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("refreshes the photo-only session once, then reads its library with the rotated cookie", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { ...session, refreshRequired: true }))
      .mockResolvedValueOnce(response(200, { sessionId: "rotated-session", userId: session.userId,
        expiresAt: "2099-01-01T00:00:00Z", refreshRequired: false }))
      .mockResolvedValueOnce(response(200, { ...session, sessionId: "rotated-session", refreshRequired: false }))
      .mockResolvedValueOnce(response(200, library));
    vi.stubGlobal("fetch", fetcher);

    const result = await loadPhotoSession(new AbortController().signal);

    expect(result.kind).toBe("ready");
    expect(fetcher).toHaveBeenNthCalledWith(2, "/photo/auth/refresh", expect.objectContaining({
      method: "POST", credentials: "same-origin", cache: "no-store",
    }));
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("rejects malformed capability and quota metadata before the screen uses it", async () => {
    const malformed = {
      ...library,
      capabilities: { ...library.capabilities, renderer: { ...library.capabilities.renderer, settingsVersions: null } },
    };
    const fetcher = vi.fn().mockResolvedValueOnce(response(200, session)).mockResolvedValueOnce(response(200, malformed));
    vi.stubGlobal("fetch", fetcher);
    expect(await loadPhotoSession(new AbortController().signal)).toEqual({ kind: "error" });

    const invalidQuota = { ...library, usage: { ...library.usage, availableBytes: -1 } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(200, session)).mockResolvedValueOnce(response(200, invalidQuota)));
    expect(await loadPhotoSession(new AbortController().signal)).toEqual({ kind: "error" });
  });

  it("changes the cache scope with the user, library, or session", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, session)).mockResolvedValueOnce(response(200, library))
      .mockResolvedValueOnce(response(200, { ...session, sessionId: "session-b" })).mockResolvedValueOnce(response(200, library))
      .mockResolvedValueOnce(response(200, session)).mockResolvedValueOnce(response(200, { ...library, id: "library-b" }))
      .mockResolvedValueOnce(response(200, { ...session, userId: "user-b" })).mockResolvedValueOnce(response(200, {
        ...library, owner: { type: "user", userId: "user-b" },
      }));
    vi.stubGlobal("fetch", fetcher);
    const first = await loadPhotoSession(new AbortController().signal);
    const second = await loadPhotoSession(new AbortController().signal);
    const third = await loadPhotoSession(new AbortController().signal);
    const fourth = await loadPhotoSession(new AbortController().signal);
    expect(first.kind).toBe("ready");
    expect(second.kind).toBe("ready");
    expect(third.kind).toBe("ready");
    expect(fourth.kind).toBe("ready");
    if (first.kind === "ready" && second.kind === "ready" && third.kind === "ready" && fourth.kind === "ready") {
      expect(first.scopeKey).not.toBe(second.scopeKey);
      expect(first.scopeKey).not.toBe(third.scopeKey);
      expect(first.scopeKey).not.toBe(fourth.scopeKey);
      expect(first.scopeKey).toMatch(/^[a-f0-9]{64}$/);
      expect(first.scopeKey).not.toContain(session.sessionId);
    }
    expect(fetcher).toHaveBeenCalledWith("/api/photo/v1/auth/session", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });
});
