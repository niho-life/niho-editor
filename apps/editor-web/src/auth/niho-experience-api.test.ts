import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { AuthProvider, Session, SessionRequest } from "./types";
import { NihoExperienceApiClient } from "./niho-experience-api";

const ORIGIN = "https://niho.example.invalid";
const SESSION: Session = { userId: "synthetic-user", mode: "niho", sessionId: "synthetic-session", expiresAt: "2030-01-01T00:00:00.000Z" };
const REQUEST = { headers: new Headers({ cookie: "__Host-editor-experience-id=server-only" }) };
const ID = "00000000-0000-4000-8000-000000000042";

function link(state = "PENDING") {
  return {
    id: ID, state, providerName: "Synthetic Provider", inviterName: "Synthetic Host", writerName: "Synthetic Writer",
    writerLabel: "記事ライター", expiresAt: "2030-01-04T00:00:00.000Z", acceptedAt: null, createdAt: "2030-01-01T00:00:00.000Z",
  };
}

function client(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const articleApiToken = vi.fn(async (_session: Session, _request: SessionRequest, _purpose: "roles" | "article-links") => "server-token");
  const auth = { articleApiToken } as unknown as AuthProvider;
  const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => handler(new URL(String(input)), init ?? {})) as unknown as typeof fetch;
  return { value: new NihoExperienceApiClient(auth, fetchImpl, ORIGIN), articleApiToken, fetchImpl };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const streamed = (chunks: readonly Uint8Array[], contentType = "application/json") => {
  const pending = [...chunks];
  return new Response(new ReadableStream<Uint8Array>({
  pull(controller) {
    const next = pending.shift();
    if (next) controller.enqueue(next);
    else controller.close();
  },
}), { headers: { "content-type": contentType } });
};

describe("NihoExperienceApiClient", () => {
  it("uses only the fixed role and article-link paths with their purpose-bound server token", async () => {
    const seen: string[] = [];
    const { value, articleApiToken } = client((url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer server-token");
      expect(init.redirect).toBe("error");
      seen.push(`${init.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.endsWith("/roles")) return json({ version: 1, roles: ["writer"], destinations: ["exp"] });
      if (url.pathname.endsWith("/article-links")) return json({ items: [link()] });
      return json({ ...link(), state: "ACCEPTED", acceptedAt: "2030-01-02T00:00:00.000Z" });
    });

    await expect(value.roles(SESSION, REQUEST)).resolves.toMatchObject({ roles: ["writer"], destinations: ["exp"] });
    await expect(value.links(SESSION, REQUEST)).resolves.toHaveLength(1);
    await expect(value.decide(SESSION, REQUEST, ID, "accept")).resolves.toMatchObject({ state: "ACCEPTED" });
    expect(articleApiToken.mock.calls.map((call) => call[2])).toEqual(["roles", "article-links", "article-links"]);
    expect(seen).toEqual([
      "GET /api/auth/experience-editor-connect/roles",
      "GET /api/auth/experience-editor-connect/article-links",
      `POST /api/auth/experience-editor-connect/article-links/${ID}/accept`,
    ]);
  });

  it("fails closed on an unknown version, state, extra field, or upstream failure", async () => {
    const cases = [
      { version: 2, roles: ["writer"], destinations: ["exp"] },
      { version: 1, roles: ["admin"], destinations: ["exp"] },
      { version: 1, roles: ["writer"], destinations: ["exp"], token: "leak" },
    ];
    for (const body of cases) {
      const { value } = client(() => json(body));
      await expect(value.roles(SESSION, REQUEST)).rejects.toThrow();
    }
    const invalidLink = client(() => json({ items: [{ ...link(), state: "UNKNOWN" }] }));
    await expect(invalidLink.value.links(SESSION, REQUEST)).rejects.toThrow();
    const unavailable = client(() => json({ error: "unavailable" }, 503));
    await expect(unavailable.value.roles(SESSION, REQUEST)).rejects.toThrow("unavailable");
  });

  it("stops chunked oversized and malformed UTF-8 responses before JSON parsing", async () => {
    const oversized = client(() => {
      const chunks = [new Uint8Array(40_000), new Uint8Array(40_000)];
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) { const chunk = chunks.shift(); chunk ? controller.enqueue(chunk) : controller.close(); } }), { headers: { "content-type": "application/json" } });
    });
    await expect(oversized.value.roles(SESSION, REQUEST)).rejects.toThrow();
    const malformed = client(() => streamed([Uint8Array.of(0xc3, 0x28)]));
    await expect(malformed.value.roles(SESSION, REQUEST)).rejects.toThrow();
  });
});
