import { describe, expect, it, vi } from "vitest";
import { stubAuthProvider } from "../auth/stub";
import type { AuthProvider } from "../auth/types";
import { finishLogin, logout, refresh, startLogin, type AuthRoutesDeps } from "./auth-routes";

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
function recordingProvider() {
  const calls: { returnTo: string; url: string }[] = [];
  const respond = (location: string) =>
    new Response(null, { status: 303, headers: { Location: location, "Set-Cookie": "editor_login=synthetic; HttpOnly; Path=/auth" } });
  const provider: AuthProvider = {
    mode: "niho",
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
    const { provider } = recordingProvider();
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
