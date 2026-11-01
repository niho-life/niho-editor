import { describe, expect, it, vi } from "vitest";

import { stubAuthProvider } from "../../auth/stub";
import { NIHO_SESSION_COOKIE } from "../../auth/niho";
import { PhotoAuthError, verifyPhotoActor } from "./index";

const ORIGIN = "https://niho.example.invalid";
const EDITOR_ORIGIN = "https://editor.example.invalid";
const NOW = Date.parse("2026-11-01T00:00:00.000Z");
const MAC_EXPIRES_AT = new Date(NOW + 60 * 60_000).toISOString();

describe("photo auth", () => {
  it("constructs a browser VerifiedPhotoActor only from the introspected server session", async () => {
    const result = await verifyPhotoActor(new Request(`${EDITOR_ORIGIN}/api/photo/v1/auth/session`), {
      auth: () => ({
        ...stubAuthProvider,
        mode: "niho",
        getSession: async () => ({
          userId: "canonical-user-a",
          sessionId: "session-a",
          expiresAt: MAC_EXPIRES_AT,
          refreshRequired: true,
          mode: "niho",
        }),
      }),
    });
    expect(result).toEqual({
      actor: {
        userId: "canonical-user-a",
        sessionId: "session-a",
        transport: "browser-session",
        expiresAt: MAC_EXPIRES_AT,
      },
      refreshRequired: true,
    });
  });

  it("forwards a Mac bearer only to the fixed verifier endpoint and checks audience/client/source", async () => {
    const fetch = vi.fn(async (...args: Parameters<typeof globalThis.fetch>) => {
      void args;
      return Response.json({
        actor: { id: "canonical-user-a" },
        sessionId: "native-connection-a",
        expiresAt: MAC_EXPIRES_AT,
        clientId: "niho-editor",
        audience: "niho-photo",
        refreshRequired: false,
        sourceClientId: "niho-camera",
      });
    });
    const result = await verifyPhotoActor(new Request(`${EDITOR_ORIGIN}/api/photo/v1/auth/session`, {
      headers: { authorization: "Bearer synthetic-native-id-token" },
    }), { auth: () => stubAuthProvider, env: { EDITOR_NIHO_ORIGIN: ORIGIN }, fetch: fetch as typeof globalThis.fetch, now: () => NOW });
    expect(result.actor).toMatchObject({ userId: "canonical-user-a", transport: "mac-bearer" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(`${ORIGIN}/api/auth/editor-connect/mac-session`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
  });

  it("keeps native bearer verification independent from a missing browser photo provider", async () => {
    const fetch = vi.fn(async () => Response.json({
      actor: { id: "canonical-native" },
      sessionId: "native-connection",
      expiresAt: MAC_EXPIRES_AT,
      clientId: "niho-editor",
      audience: "niho-photo",
      refreshRequired: false,
      sourceClientId: "niho-camera",
    }));
    const docsSession = vi.fn();
    const result = await verifyPhotoActor(new Request(`${EDITOR_ORIGIN}/api/photo/v1/auth/session`, {
      headers: { authorization: "Bearer synthetic-native" },
    }), {
      auth: () => ({ ...stubAuthProvider, mode: "google", getSession: docsSession }),
      photoAuth: () => null,
      env: { EDITOR_NIHO_ORIGIN: ORIGIN },
      fetch: fetch as typeof globalThis.fetch,
      now: () => NOW,
    });
    expect(result.actor).toMatchObject({ userId: "canonical-native", transport: "mac-bearer" });
    expect(docsSession).not.toHaveBeenCalled();
  });

  it.each<{ headers: Record<string, string>; code: string }>([
    { headers: { authorization: "Bearer token", cookie: `${NIHO_SESSION_COOKIE}=v1.33333333-3333-4333-8333-333333333333.${"D".repeat(43)}` }, code: "ambiguous_authentication" },
    { headers: { "x-owner-id": "another-user" }, code: "identity_header_forbidden" },
  ])("rejects ambiguous or request-owned identity input", async ({ headers, code }) => {
    await expect(verifyPhotoActor(new Request("https://editor.example.invalid/api/photo/v1/auth/session", {
      headers: new Headers(headers),
    }), {
      auth: () => stubAuthProvider,
    })).rejects.toMatchObject({ code });
  });

  it("treats a wrong private audience as unavailable, never as a verified actor", async () => {
    const fetch = vi.fn(async (...args: Parameters<typeof globalThis.fetch>) => {
      void args;
      return Response.json({
        actor: { id: "canonical-user-a" }, sessionId: "x", expiresAt: MAC_EXPIRES_AT,
        clientId: "niho-editor", audience: "wrong", refreshRequired: false, sourceClientId: "niho-camera",
      });
    });
    await expect(verifyPhotoActor(new Request("https://editor.example.invalid", {
      headers: { authorization: "Bearer synthetic" },
    }), { auth: () => stubAuthProvider, env: { EDITOR_NIHO_ORIGIN: ORIGIN }, fetch: fetch as typeof globalThis.fetch, now: () => NOW }))
      .rejects.toEqual(new PhotoAuthError(503, "photo_auth_unavailable", true));
  });

  it.each([undefined, "null", "https://evil.example.invalid"])("rejects cookie mutations without the exact Origin: %s", async (origin) => {
    const headers = new Headers({ cookie: `${NIHO_SESSION_COOKIE}=synthetic` });
    if (origin !== undefined) headers.set("origin", origin);
    await expect(verifyPhotoActor(new Request(`${EDITOR_ORIGIN}/api/photo/v1/photos`, {
      method: "POST", headers,
    }), {
      auth: () => ({
        ...stubAuthProvider,
        mode: "niho",
        getSession: async () => ({ userId: "canonical-user-a", mode: "niho", sessionId: "session-a", expiresAt: MAC_EXPIRES_AT }),
      }),
      env: { EDITOR_ORIGIN },
    })).rejects.toEqual(new PhotoAuthError(403, "origin_rejected"));
  });

  it("accepts an exact Origin for cookie mutations and rejects a non-NIHO browser session", async () => {
    const request = new Request(`${EDITOR_ORIGIN}/api/photo/v1/photos`, {
      method: "POST",
      headers: { cookie: `${NIHO_SESSION_COOKIE}=synthetic`, origin: EDITOR_ORIGIN },
    });
    const niho = await verifyPhotoActor(request, {
      auth: () => ({
        ...stubAuthProvider,
        mode: "niho",
        getSession: async () => ({ userId: "canonical-user-a", mode: "niho", sessionId: "session-a", expiresAt: MAC_EXPIRES_AT }),
      }),
      env: { EDITOR_ORIGIN },
    });
    expect(niho.actor.transport).toBe("browser-session");
    await expect(verifyPhotoActor(new Request(`${EDITOR_ORIGIN}/api/photo/v1/auth/session`), {
      auth: () => stubAuthProvider,
    })).rejects.toEqual(new PhotoAuthError(401, "unauthorized"));
  });

  it("uses an explicit photo provider for browser cookies and never calls the Google provider", async () => {
    const googleSession = vi.fn(async () => ({ userId: "google-sub", mode: "google" as const }));
    const photoSession = vi.fn(async ({ headers }: { headers: Pick<Headers, "get"> }) => {
      expect(headers.get("cookie")).toContain("editor_session=synthetic-google");
      expect(headers.get("cookie")).toContain(`${NIHO_SESSION_COOKIE}=synthetic-niho`);
      return { userId: "canonical-niho", mode: "niho" as const, sessionId: "photo-session", expiresAt: MAC_EXPIRES_AT };
    });
    const result = await verifyPhotoActor(new Request(`${EDITOR_ORIGIN}/api/photo/v1/auth/session`, {
      headers: { cookie: `editor_session=synthetic-google; ${NIHO_SESSION_COOKIE}=synthetic-niho` },
    }), {
      auth: () => ({ ...stubAuthProvider, mode: "google", getSession: googleSession }),
      photoAuth: () => ({ ...stubAuthProvider, mode: "niho", getSession: photoSession }),
    });
    expect(result.actor.userId).toBe("canonical-niho");
    expect(photoSession).toHaveBeenCalledOnce();
    expect(googleSession).not.toHaveBeenCalled();
  });

  it("fails explicit null or wrong-mode photo seams as 503 without trying Docs auth", async () => {
    const docsSession = vi.fn(async () => ({ userId: "google-sub", mode: "google" as const }));
    const docs = { ...stubAuthProvider, mode: "google" as const, getSession: docsSession };
    for (const photoAuth of [() => null, () => docs]) {
      await expect(verifyPhotoActor(new Request(`${EDITOR_ORIGIN}/api/photo/v1/auth/session`), {
        auth: () => docs,
        photoAuth,
      })).rejects.toEqual(new PhotoAuthError(503, "photo_auth_unavailable", true));
    }
    expect(docsSession).not.toHaveBeenCalled();
  });

  it("maps abnormal, oversized, errored, expired, and overlong Mac responses to the same typed 503", async () => {
    const valid = (expiresAt: string) => ({
      actor: { id: "canonical-user-a" }, sessionId: "native-a", expiresAt,
      clientId: "niho-editor", audience: "niho-photo", refreshRequired: false, sourceClientId: "niho-camera",
    });
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 + 1));
        controller.close();
      },
    });
    const errored = new ReadableStream<Uint8Array>({ pull() { throw new Error("provider secret"); } });
    const responses = [
      new Response("not-json", { headers: { "content-type": "application/json" } }),
      new Response(oversized, { headers: { "content-type": "application/json" } }),
      new Response(errored, { headers: { "content-type": "application/json" } }),
      Response.json(valid(new Date(NOW).toISOString())),
      Response.json(valid(new Date(NOW + 3 * 60 * 60_000).toISOString())),
    ];
    for (const response of responses) {
      const fetch = vi.fn(async () => response) as unknown as typeof globalThis.fetch;
      await expect(verifyPhotoActor(new Request(`${EDITOR_ORIGIN}/api/photo/v1/auth/session`, {
        headers: { authorization: "Bearer synthetic" },
      }), { auth: () => stubAuthProvider, env: { EDITOR_NIHO_ORIGIN: ORIGIN }, fetch, now: () => NOW }))
        .rejects.toEqual(new PhotoAuthError(503, "photo_auth_unavailable", true));
    }
  });
});
