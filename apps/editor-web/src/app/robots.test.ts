// @vitest-environment node
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import nextConfig, { ALL_BUT_PUBLIC_API, AUTH_FORM_HEADERS, ROBOTS_HEADERS } from "../../next.config";
import { metadata } from "./layout";
import robots from "./robots";

/** next.config.ts の header の規則を Next の照合で当てた結果。 */
async function configHeaders(path: string): Promise<Headers> {
  return (await unstable_getResponseFromNextConfig({ url: `https://editor.niho.life${path}`, nextConfig })).headers;
}

describe("noindex, nofollow", () => {
  it("sends X-Robots-Tag on every path but the public API through one catch-all header rule", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const catchAll = rules.find((rule) => rule.source === ALL_BUT_PUBLIC_API);
    expect(catchAll).toBeDefined();
    expect(catchAll?.headers).toEqual(expect.arrayContaining(ROBOTS_HEADERS));
    expect(ROBOTS_HEADERS).toEqual([{ key: "X-Robots-Tag", value: "noindex, nofollow" }]);
    // 一部の path だけに条件を付けた規則で上書きしない
    for (const rule of rules) expect(rule.has ?? rule.missing).toBeUndefined();
    // 公開 API 以外の全ての path（`/v1` そのものと `/v1` で始まる別の名前も含む）
    for (const path of ["/", "/p/new", "/api/pages", "/s/token", "/robots.txt", "/sw.js", "/_next/static/x.js", "/no-such-route", "/v1", "/v1x/y", "/v2/exp/published.json"]) {
      expect((await configHeaders(path)).get("X-Robots-Tag"), path).toBe("noindex, nofollow");
    }
  });

  it("leaves the public API's contract headers to its handler (Next would drop the handler's value if config set one)", async () => {
    // Content-Type はどの規則も付けない（テストの応答は空の本文の text/plain になるので、規則そのものを見る）
    const rules = (await nextConfig.headers?.()) ?? [];
    for (const rule of rules) for (const header of rule.headers) expect(header.key.toLowerCase(), rule.source).not.toBe("content-type");
    for (const path of ["/v1/exp/published.json", "/v1/site-alpha/published/0f0e0d0c-0b0a-4908-8706-050403020100.json", "/v1/preview/pv_x.json", "/v1/unknown"]) {
      const headers = await configHeaders(path);
      for (const name of ["X-Robots-Tag", "Cache-Control", "Vary", "ETag", "WWW-Authenticate", "Allow", "Retry-After"]) {
        expect(headers.get(name), `${path} ${name}`).toBeNull();
      }
      // 契約と重ならない守りの header は付ける
      expect(headers.get("X-Content-Type-Options"), path).toBe("nosniff");
      expect(headers.get("Strict-Transport-Security"), path).toContain("max-age=");
      expect(headers.get("Content-Security-Policy"), path).toContain("default-src 'none'");
    }
  });

  it("puts <meta name=robots content=noindex, nofollow> on every page through the root layout", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("does not block crawling in robots.txt (a Disallow would hide the noindex)", () => {
    const result = robots();
    expect(JSON.stringify(result).toLowerCase()).not.toContain("disallow");
    expect(result.rules).toEqual({ userAgent: "*", allow: "/" });
  });

  it("overrides Referrer-Policy only on the two exact auth form handlers", async () => {
    expect(AUTH_FORM_HEADERS).toEqual([{ key: "Referrer-Policy", value: "origin" }]);
    for (const path of ["/auth/login/start", "/auth/login/start?next=%2Fsettings", "/auth/callback"]) {
      expect((await configHeaders(path)).get("Referrer-Policy"), path).toBe("origin");
    }
    for (const path of ["/auth/login", "/auth/login/start/extra", "/auth/callback/extra", "/settings"]) {
      expect((await configHeaders(path)).get("Referrer-Policy"), path).toBe("same-origin");
    }
    expect((await configHeaders("/s/synthetic-token")).get("Referrer-Policy")).toBe("no-referrer");
  });
});
