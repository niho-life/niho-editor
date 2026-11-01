import { describe, expect, it } from "vitest";
import { autoFormResponse } from "./auto-form";

function nonce(response: Response): string {
  const value = /script-src 'nonce-([^']+)'/.exec(response.headers.get("content-security-policy") ?? "")?.[1];
  if (!value) throw new Error("nonce missing");
  return value;
}

describe("standalone auth auto-form", () => {
  it("uses a fresh document nonce, strict CSP, origin referrer, and escaped form values", async () => {
    const make = () => autoFormResponse({
      target: "https://target.example.invalid/auth/callback",
      formAction: "https://target.example.invalid",
      fields: { code: `A&\"<>'` },
      title: `移動&\"<>'`,
      message: "移動しています。",
      submitLabel: "続ける",
    });
    const first = make();
    const second = make();
    expect(nonce(first)).not.toBe(nonce(second));
    const html = await first.text();
    expect(html).toContain("value=\"A&amp;&quot;&lt;&gt;&#39;\"");
    expect(html).toContain("<script nonce=\"");
    expect(html).toContain("document.getElementById(\"auth-form\").submit();");
    expect(first.headers.get("content-security-policy")).toBe(
      `default-src 'none'; script-src 'nonce-${nonce(first)}'; form-action https://target.example.invalid; base-uri 'none'; frame-ancestors 'none'; object-src 'none'`,
    );
    expect(first.headers.get("referrer-policy")).toBe("origin");
    expect(first.headers.get("cache-control")).toBe("no-store");
  });
});
