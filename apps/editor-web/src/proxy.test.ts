// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { EDITOR_PATH_HEADER } from "./lib/editor-path";
import { config, proxy } from "./proxy";

function nonceOf(policy: string | null): string {
  const match = /'nonce-([^']+)'/.exec(policy ?? "");
  if (!match?.[1]) throw new Error("no nonce in the policy");
  return match[1];
}

describe("proxy", () => {
  it("puts a Content-Security-Policy with a fresh nonce on every response", () => {
    const first = proxy(new NextRequest("https://editor.example.test/"));
    const second = proxy(new NextRequest("https://editor.example.test/"));
    expect(nonceOf(first.headers.get("Content-Security-Policy"))).not.toBe(nonceOf(second.headers.get("Content-Security-Policy")));
    expect(first.headers.get("Content-Security-Policy")).toContain("script-src 'self' 'nonce-");
  });

  it("hands Next the same policy on the request, so the nonce lands on Next's own scripts", () => {
    const response = proxy(new NextRequest("https://editor.example.test/p/x"));
    // Next は forwarded な要求の header を `x-middleware-request-<name>` と `x-middleware-override-headers` で伝える
    const forwarded = response.headers.get("x-middleware-request-content-security-policy");
    expect(forwarded).toBe(response.headers.get("Content-Security-Policy"));
    expect(response.headers.get("x-middleware-override-headers")?.toLowerCase()).toContain("content-security-policy");
  });

  it("ignores a Content-Security-Policy sent by the client", () => {
    const request = new NextRequest("https://editor.example.test/", {
      headers: { "Content-Security-Policy": "script-src 'nonce-attacker'" },
    });
    const response = proxy(request);
    expect(response.headers.get("x-middleware-request-content-security-policy")).not.toContain("attacker");
    expect(response.headers.get("Content-Security-Policy")).not.toContain("attacker");
  });

  it("leaves only the three standalone auth handlers free of proxy CSP/path headers", () => {
    for (const path of ["/auth/login/start", "/auth/login/start?next=%2Fsettings", "/auth/callback", "/auth/callback?rejected=1", "/photo/auth/start", "/photo/auth/start?next=%2Fphoto%2Ftrash"]) {
      const response = proxy(new NextRequest(`https://editor.example.test${path}`, {
        headers: {
          "Content-Security-Policy": "script-src 'nonce-attacker'",
          [EDITOR_PATH_HEADER]: "//evil.invalid",
        },
      }));
      expect(response.headers.get("Content-Security-Policy"), path).toBeNull();
      expect(response.headers.get("x-middleware-request-content-security-policy"), path).toBeNull();
      expect(response.headers.get(`x-middleware-request-${EDITOR_PATH_HEADER}`), path).toBeNull();
      expect(response.headers.get("x-middleware-override-headers"), path).not.toContain("content-security-policy");
    }

    for (const path of ["/auth/login", "/auth/login/start/extra", "/auth/callback/extra", "/photo", "/photo/auth/login", "/photo/auth/start/extra", "/photo/auth/logout", "/photo/auth/refresh", "/settings"]) {
      const response = proxy(new NextRequest(`https://editor.example.test${path}`));
      expect(response.headers.get("Content-Security-Policy"), path).toContain("script-src 'self' 'nonce-");
      expect(response.headers.get(`x-middleware-request-${EDITOR_PATH_HEADER}`), path).toBe(path);
    }
  });

  it("skips the API, static assets and prefetches", () => {
    const [rule] = config.matcher;
    expect(rule?.source).toBe("/((?!api|v1/|_next/static|_next/image|favicon.ico).*)");
    expect(rule?.missing).toEqual(
      expect.arrayContaining([
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ]),
    );
  });

  it("forwards the current path and search, overwriting a client-supplied value (the login return target)", () => {
    const request = new NextRequest("http://editor.test/p/new?from=recording", { headers: { [EDITOR_PATH_HEADER]: "//evil.com" } });
    const response = proxy(request);
    expect(response.headers.get(`x-middleware-request-${EDITOR_PATH_HEADER}`)).toBe("/p/new?from=recording");
    expect(response.headers.get("location")).toBeNull();
  });

  it("runs for every screen (the login screen needs the CSP too), not for /api, the public API (/v1/), static files or the favicon", () => {
    const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });
    for (const path of ["/", "/p/new", "/p/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11", "/settings", "/destinations/my-site", "/auth/login", "/no-such-route", "/v1"]) {
      expect(matches(`http://editor.test${path}`), path).toBe(true);
    }
    for (const path of ["/api", "/api/pages", "/v1/exp/published.json", "/v1/preview/pv_x.json", "/_next/static/chunks/x.js", "/_next/image", "/favicon.ico"]) {
      expect(matches(`http://editor.test${path}`), path).toBe(false);
    }
  });
});
