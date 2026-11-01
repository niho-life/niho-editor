import { describe, expect, it, vi } from "vitest";
import { stubAuthProvider } from "../auth/stub";
import type { AuthMode } from "../auth/config";
import type { AuthProvider } from "../auth/types";
import { finishLogin, logout, logoutPhoto, refresh, refreshPhoto, startLogin, startPhotoLogin, type AuthRoutesDeps } from "./auth-routes";

const ORIGIN = "http://editor.test";
const ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

function deps(provider: AuthProvider): AuthRoutesDeps {
  return { auth: () => provider, env: {} };
}

function get(path: string): Request {
  return new Request(`${ORIGIN}${path}`, { headers: { host: "editor.test" } });
}

function post(path: string, origin: string | null): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers: { host: "editor.test", ...(origin === null ? {} : { origin }) } });
}

/** 渡した戻り先と要求を覚え、合成の cookie を付けて返す方式（route が header を落とさないかを見る）。 */
function recordingProvider(mode: AuthMode = "niho") {
  const calls: { returnTo: string; url: string }[] = [];
  const respond = (location: string) =>
    new Response(null, { status: 303, headers: { Location: location, "Set-Cookie": "editor_login=synthetic; HttpOnly; Path=/auth" } });
  const provider: AuthProvider = {
    mode,
    getSession: async () => null,
    beginLogin: async ({ request, returnTo }) => {
      calls.push({ returnTo, url: request.url });
      return respond("https://login.example/authorize");
    },
    completeLogin: async () => respond("/"),
    logout: async () => respond("/auth/login"),
  };
  return { provider, calls };
}

describe("/auth/*", () => {
  it("passes only a sanitized return path to the provider", async () => {
    const { provider, calls } = recordingProvider();
    for (const [next, expected] of [
      [`/p/${ID}`, `/p/${ID}`],
      ["/p/new?from=recording", "/p/new?from=recording"],
      ["//evil.com", "/"],
      ["https://evil.com/p/new", "/"],
      ["/auth/logout", "/"],
      [null, "/"],
    ] as const) {
      const query = next === null ? "" : `?next=${encodeURIComponent(next)}`;
      await startLogin(get(`/auth/login/start${query}`), deps(provider));
      expect(calls.at(-1)?.returnTo, String(next)).toBe(expected);
    }
  });

  it("keeps the provider's headers and marks every answer no-store", async () => {
    const { provider } = recordingProvider("google");
    const responses = [
      await startLogin(get("/auth/login/start"), deps(provider)),
      await finishLogin(get("/auth/callback?code=synthetic&state=synthetic"), deps(provider)),
      await logout(post("/auth/logout", ORIGIN), deps(provider)),
    ];
    for (const response of responses) {
      expect(response.status).toBe(303);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    }
  });

  it("dispatches NIHO only by POST, while Google GET stays unchanged", async () => {
    const niho = recordingProvider("niho").provider;
    const nihoComplete = vi.spyOn(niho, "completeLogin");
    expect((await finishLogin(get("/auth/callback"), deps(niho))).status).toBe(405);
    expect(nihoComplete).not.toHaveBeenCalled();
    expect((await finishLogin(post("/auth/callback", "https://niho.example.invalid"), deps(niho))).status).toBe(303);
    expect(nihoComplete).toHaveBeenCalledOnce();

    const google = recordingProvider("google").provider;
    const googleComplete = vi.spyOn(google, "completeLogin");
    expect((await finishLogin(get("/auth/callback?code=synthetic&state=synthetic"), deps(google))).status).toBe(303);
    expect(googleComplete).toHaveBeenCalledOnce();
    expect((await finishLogin(post("/auth/callback", ORIGIN), deps(google))).status).toBe(405);
    expect(googleComplete).toHaveBeenCalledOnce();
  });

  it("stub: start goes straight to the return path, callback to /, logout to the login screen", async () => {
    const start = await startLogin(get(`/auth/login/start?next=${encodeURIComponent(`/p/${ID}`)}`), deps(stubAuthProvider));
    expect([start.status, start.headers.get("location")]).toEqual([303, `/p/${ID}`]);
    const callback = await finishLogin(get("/auth/callback"), deps(stubAuthProvider));
    expect([callback.status, callback.headers.get("location")]).toEqual([303, "/"]);
    const out = await logout(post("/auth/logout", ORIGIN), deps(stubAuthProvider));
    expect([out.status, out.headers.get("location")]).toEqual([303, "/auth/login"]);
  });

  it("answers 403 to a logout from another origin or without an Origin, without calling the provider", async () => {
    const { provider } = recordingProvider();
    const spy = vi.spyOn(provider, "logout");
    for (const origin of ["https://evil.example", "null", null]) {
      const response = await logout(post("/auth/logout", origin), deps(provider));
      expect(response.status, String(origin)).toBe(403);
      expect(await response.text()).toBe('{"error":"forbidden"}');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("refresh is same-origin only and keeps provider Set-Cookie headers", async () => {
    const { provider } = recordingProvider();
    provider.refresh = async () => new Response(null, {
      status: 204,
      headers: { "Set-Cookie": "__Host-editor-niho-session=synthetic; Secure; HttpOnly; Path=/" },
    });
    const ok = await refresh(post("/auth/refresh", ORIGIN), deps(provider));
    expect(ok.status).toBe(204);
    expect(ok.headers.get("set-cookie")).toContain("Secure");
    const forbidden = await refresh(post("/auth/refresh", "https://evil.invalid"), deps(provider));
    expect(forbidden.status).toBe(403);
  });

  it("answers 500 without internal details when the provider fails", async () => {
    const failing: AuthProvider = {
      ...stubAuthProvider,
      beginLogin: async () => {
        throw new Error("token endpoint https://login.example/secret failed");
      },
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await startLogin(get("/auth/login/start"), deps(failing));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"internal"}');
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
    log.mockRestore();
  });
});

describe("/photo/auth/*", () => {
  it("passes only photo UI return paths to NIHO and keeps standalone form headers/cookies", async () => {
    const { provider, calls } = recordingProvider("niho");
    const scoped: AuthRoutesDeps = { auth: () => recordingProvider("google").provider, photoAuth: () => provider, env: {} };
    for (const [next, expected] of [
      ["/photo/trash", "/photo/trash"],
      [`/photo/${ID}?x=1`, `/photo/${ID}`],
      ["/settings", "/photo"],
      ["/photo/auth/login", "/photo"],
      ["//evil.invalid", "/photo"],
    ] as const) {
      const response = await startPhotoLogin(get(`/photo/auth/start?next=${encodeURIComponent(next)}`), scoped);
      expect(response.status).toBe(303);
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      expect(calls.at(-1)?.returnTo).toBe(expected);
    }
  });

  it("does not invoke Google when the photo provider is absent or miswired", async () => {
    const google = recordingProvider("google").provider;
    const begin = vi.spyOn(google, "beginLogin");
    const complete = vi.spyOn(google, "completeLogin");
    const out = vi.spyOn(google, "logout");
    const absent: AuthRoutesDeps = { auth: () => google, photoAuth: () => null, env: {} };
    const wrong: AuthRoutesDeps = { auth: () => google, photoAuth: () => google, env: {} };

    const start = await startPhotoLogin(get("/photo/auth/start?next=%2Fphoto%2Ftrash"), absent);
    expect([start.status, start.headers.get("location")]).toEqual([303, "/photo/auth/login?next=%2Fphoto%2Ftrash&error=unavailable"]);
    const closed = [
      await finishLogin(post("/auth/callback", ORIGIN), absent),
      await logoutPhoto(post("/photo/auth/logout", ORIGIN), wrong),
      await refreshPhoto(post("/photo/auth/refresh", ORIGIN), absent),
    ];
    for (const response of closed) {
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toBe('{"error":"unavailable"}');
    }
    expect(start.headers.get("set-cookie")).toBeNull();
    expect(begin).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
  });

  it("uses NIHO only for POST callback while Google GET remains the default provider", async () => {
    const google = recordingProvider("google").provider;
    const niho = recordingProvider("niho").provider;
    const googleComplete = vi.spyOn(google, "completeLogin");
    const nihoComplete = vi.spyOn(niho, "completeLogin");
    const scoped: AuthRoutesDeps = { auth: () => google, photoAuth: () => niho, env: {} };

    expect((await finishLogin(get("/auth/callback?code=synthetic&state=synthetic"), scoped)).status).toBe(303);
    expect(googleComplete).toHaveBeenCalledOnce();
    expect(nihoComplete).not.toHaveBeenCalled();
    expect((await finishLogin(post("/auth/callback", ORIGIN), scoped)).status).toBe(303);
    expect(nihoComplete).toHaveBeenCalledOnce();
    expect(googleComplete).toHaveBeenCalledOnce();
  });

  it("rewrites only trusted provider login redirects and preserves success/external locations and cookies", async () => {
    const responses = [
      "/auth/login?next=%2Fphoto%2Ftrash&error=unavailable",
      "/photo/trash",
      "https://login.example.invalid/authorize",
    ];
    const provider = recordingProvider("niho").provider;
    provider.completeLogin = async () => new Response(null, {
      status: 303,
      headers: { Location: responses.shift()!, "Set-Cookie": "__Host-editor-niho-session=synthetic; Secure; HttpOnly; Path=/" },
    });
    const scoped: AuthRoutesDeps = { auth: () => recordingProvider("google").provider, photoAuth: () => provider, env: {} };
    const rewritten = await finishLogin(post("/auth/callback", ORIGIN), scoped);
    expect(rewritten.headers.get("location")).toBe("/photo/auth/login?next=%2Fphoto%2Ftrash&error=unavailable");
    expect(rewritten.headers.get("set-cookie")).toContain("__Host-editor-niho-session");
    expect((await finishLogin(post("/auth/callback", ORIGIN), scoped)).headers.get("location")).toBe("/photo/trash");
    expect((await finishLogin(post("/auth/callback", ORIGIN), scoped)).headers.get("location")).toBe("https://login.example.invalid/authorize");
  });

  it("rewrites a scoped start provider failure to the photo login without exposing the Docs login", async () => {
    const niho = recordingProvider("niho").provider;
    niho.beginLogin = async ({ returnTo }) => new Response(null, {
      status: 303,
      headers: {
        Location: `/auth/login?next=${encodeURIComponent(returnTo)}&error=unavailable`,
        "Set-Cookie": "__Host-editor-niho-pending=synthetic; Secure; HttpOnly; Path=/",
      },
    });
    const response = await startPhotoLogin(get("/photo/auth/start?next=%2Fphoto%2Ftrash"), {
      auth: () => recordingProvider("google").provider,
      photoAuth: () => niho,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/photo/auth/login?next=%2Fphoto%2Ftrash&error=unavailable");
    expect(response.headers.get("set-cookie")).toContain("__Host-editor-niho-pending");
  });

  it("refreshes/logs out only NIHO, keeps its cookies, and rejects the wrong Origin before provider calls", async () => {
    const niho = recordingProvider("niho").provider;
    niho.refresh = async () => new Response(null, { status: 204, headers: { "Set-Cookie": "__Host-editor-niho-session=rotated; Secure; HttpOnly; Path=/" } });
    niho.logout = async () => new Response(null, {
      status: 303,
      headers: [
        ["Location", "/auth/login"],
        ["Set-Cookie", "__Host-editor-niho-pending=; Max-Age=0; Secure; HttpOnly; Path=/"],
        ["Set-Cookie", "__Host-editor-niho-session=; Max-Age=0; Secure; HttpOnly; Path=/"],
      ],
    });
    const refreshSpy = vi.spyOn(niho, "refresh");
    const logoutSpy = vi.spyOn(niho, "logout");
    const scoped: AuthRoutesDeps = { auth: () => recordingProvider("google").provider, photoAuth: () => niho, env: {} };
    const refreshed = await refreshPhoto(post("/photo/auth/refresh", ORIGIN), scoped);
    expect(refreshed.status).toBe(204);
    expect(refreshed.headers.get("set-cookie")).toContain("rotated");
    const loggedOut = await logoutPhoto(post("/photo/auth/logout", ORIGIN), scoped);
    expect(loggedOut.headers.get("location")).toBe("/photo/auth/login");
    expect(loggedOut.headers.get("set-cookie")).toContain("__Host-editor-niho-session");
    expect(loggedOut.headers.get("set-cookie")).not.toContain("editor_session");
    for (const handler of [logoutPhoto, refreshPhoto]) {
      expect((await handler(post("/photo/auth/x", "https://evil.invalid"), scoped)).status).toBe(403);
    }
    expect(refreshSpy).toHaveBeenCalledOnce();
    expect(logoutSpy).toHaveBeenCalledOnce();
  });

  it("preserves the legacy NIHO-only deps path for the auth candidate", async () => {
    const niho = recordingProvider("niho").provider;
    expect((await startPhotoLogin(get("/photo/auth/start"), deps(niho))).status).toBe(303);
    expect((await finishLogin(post("/auth/callback", ORIGIN), deps(niho))).status).toBe(303);
  });
});
