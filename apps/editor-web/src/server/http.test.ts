import { describe, expect, it, vi } from "vitest";
import { AuthTemporarilyUnavailable } from "../auth/types";
import { MAX_BODY_BYTES, expectedOrigin, guarded, isSameOriginRequest, readJsonBody } from "./http";

function post(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request("http://editor.test/api/pages", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
}

function streamOf(size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) return controller.close();
      const chunk = new Uint8Array(Math.min(64 * 1024, size - sent)).fill(0x20);
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

describe("readJsonBody", () => {
  it("parses JSON within the limit", async () => {
    const result = await readJsonBody(post('{"title":"x"}'));
    expect(result).toEqual({ ok: true, value: { title: "x" } });
  });

  it("answers 400 for a non-JSON content type, a missing body, broken JSON, or invalid UTF-8", async () => {
    const cases = [
      post('{"title":"x"}', { "content-type": "text/plain" }),
      new Request("http://editor.test/api/pages", { method: "POST", body: "{}" }),
      post(null),
      post("{"),
      post(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])),
    ];
    for (const request of cases) {
      const result = await readJsonBody(request);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(400);
    }
  });

  it("answers 413 above 1 MiB, from Content-Length or while streaming", async () => {
    const declared = await readJsonBody(post("{}", { "content-length": String(MAX_BODY_BYTES + 1) }));
    expect(declared.ok).toBe(false);
    if (!declared.ok) expect(declared.response.status).toBe(413);

    const streamed = await readJsonBody(
      new Request("http://editor.test/api/pages", { method: "POST", body: streamOf(MAX_BODY_BYTES + 10), headers: { "content-type": "application/json" }, duplex: "half" } as RequestInit),
    );
    expect(streamed.ok).toBe(false);
    if (!streamed.ok) expect(streamed.response.status).toBe(413);

    const atLimit = await readJsonBody(post(`"${"a".repeat(MAX_BODY_BYTES - 2)}"`));
    expect(atLimit.ok).toBe(true);
  });
});

describe("same-origin check", () => {
  const request = (headers: Record<string, string>) => new Request("http://editor.test/api/pages", { method: "PATCH", headers });

  it("accepts only the request's own origin", () => {
    expect(isSameOriginRequest(request({ host: "editor.test", origin: "http://editor.test" }), {})).toBe(true);
    expect(isSameOriginRequest(request({ host: "editor.test", origin: "https://evil.example" }), {})).toBe(false);
    expect(isSameOriginRequest(request({ host: "editor.test", origin: "null" }), {})).toBe(false);
    expect(isSameOriginRequest(request({ host: "editor.test" }), {})).toBe(false);
  });

  it("follows the forwarded protocol and host, or a configured origin", () => {
    const forwarded = request({ host: "internal:8080", "x-forwarded-host": "editor.example.com", "x-forwarded-proto": "https", origin: "https://editor.example.com" });
    expect(expectedOrigin(forwarded, {})).toBe("https://editor.example.com");
    expect(isSameOriginRequest(forwarded, {})).toBe(true);
    expect(isSameOriginRequest(request({ host: "editor.test", origin: "http://editor.test" }), { EDITOR_ORIGIN: "https://editor.example.com" })).toBe(false);
  });
});

describe("guarded", () => {
  it("maps a temporary authentication outage to a sanitized 503 for every central-guarded route", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await guarded("GET /api/pages", async () => {
      throw new AuthTemporarilyUnavailable("provider response contained sensitive metadata");
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"unavailable"}');
    expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive");
    log.mockRestore();
  });
});
