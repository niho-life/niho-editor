import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProvider, Session } from "../auth/types";

const mocks = vi.hoisted(() => ({
  requestHeaders: new Headers(),
  docsProvider: null as AuthProvider | null,
  photoProvider: null as AuthProvider | null,
  redirect: vi.fn((location: string): never => { throw new Error(`redirect:${location}`); }),
}));

vi.mock("next/headers", () => ({ headers: async () => mocks.requestHeaders }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("../auth", () => ({
  getAuthProvider: () => mocks.docsProvider,
  getPhotoAuthProvider: () => mocks.photoProvider,
}));

import { currentPhotoSession, currentSession, requirePhotoSession } from "./session";

function provider(mode: "google" | "niho", session: Session | null, seen: string[]): AuthProvider {
  return {
    mode,
    getSession: async ({ headers }) => {
      seen.push(headers.get("cookie") ?? "");
      return session;
    },
    beginLogin: async () => { throw new Error("not used"); },
    completeLogin: async () => { throw new Error("not used"); },
    logout: async () => { throw new Error("not used"); },
  };
}

describe("server sessions", () => {
  beforeEach(() => {
    mocks.requestHeaders = new Headers({
      cookie: "editor_session=synthetic-google; __Host-editor-niho-session=synthetic-niho",
      "x-editor-path": "/photo/trash",
    });
    mocks.docsProvider = null;
    mocks.photoProvider = null;
    mocks.redirect.mockClear();
  });

  it("keeps the Google Docs actor and NIHO photo actor independent on the same request", async () => {
    const docsSeen: string[] = [];
    const photoSeen: string[] = [];
    mocks.docsProvider = provider("google", { userId: "google-sub", mode: "google" }, docsSeen);
    mocks.photoProvider = provider("niho", {
      userId: "canonical-niho",
      mode: "niho",
      sessionId: "photo-session",
      expiresAt: "2026-11-03T00:00:00.000Z",
    }, photoSeen);
    expect((await currentSession())?.userId).toBe("google-sub");
    expect((await currentPhotoSession())?.userId).toBe("canonical-niho");
    expect(docsSeen[0]).toContain("editor_session=synthetic-google");
    expect(photoSeen[0]).toContain("__Host-editor-niho-session=synthetic-niho");
  });

  it("never falls back to the Docs actor when photo auth is missing", async () => {
    const docsSeen: string[] = [];
    mocks.docsProvider = provider("google", { userId: "google-sub", mode: "google" }, docsSeen);
    mocks.photoProvider = null;
    expect(await currentPhotoSession()).toBeNull();
    expect(docsSeen).toEqual([]);
    await expect(requirePhotoSession()).rejects.toThrow("redirect:/photo/auth/login?next=%2Fphoto%2Ftrash");
  });

  it("sanitizes an explicit non-photo return path before redirecting", async () => {
    mocks.photoProvider = provider("niho", null, []);
    await expect(requirePhotoSession("/settings")).rejects.toThrow("redirect:/photo/auth/login");
    expect(mocks.redirect).toHaveBeenCalledWith("/photo/auth/login");
  });
});
