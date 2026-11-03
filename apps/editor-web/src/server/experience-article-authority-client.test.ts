import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ExperienceArticleAuthorityClient, experienceFactsSource } from "./experience-article-authority-client";

const SETTINGS = { origin: "https://experience.example.invalid", audience: "synthetic-audience" };
const json = (body: unknown, status = 200) => Response.json(body, { status });

function client(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => handler(new URL(String(input)), init ?? {}));
  const token = vi.fn(async () => "google-service-token");
  return { value: new ExperienceArticleAuthorityClient(fetchImpl as unknown as typeof fetch, token, () => SETTINGS), fetchImpl, token };
}

describe("ExperienceArticleAuthorityClient", () => {
  it("uses a dedicated service token for fixed internal paths and keeps public category reads token-free", async () => {
    const { value, token, fetchImpl } = client((url, init) => {
      if (url.pathname.endsWith("/categories")) {
        expect(new Headers(init.headers).get("authorization")).toBeNull();
        return json({ version: 1, items: [{ slug: "walks", labelEn: "Walks", labelJa: "散策", displayOrder: 4, revision: 7 }] });
      }
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer google-service-token");
      if (url.pathname.endsWith("/candidates")) return json({ version: 1, items: [{ slug: "morning-walk", title: "Morning walk", providerName: "Synthetic Provider" }], nextCursor: null });
      return json({ version: 1, allowedSlugs: ["morning-walk"] });
    });
    await expect(value.categories()).resolves.toEqual([{ slug: "walks", labelEn: "Walks", labelJa: "散策", displayOrder: 4, revision: 7 }]);
    await expect(value.candidates("writer", "morning", "opaque-cursor")).resolves.toMatchObject({ items: [{ slug: "morning-walk" }] });
    await expect(value.checkRelated("writer", ["morning-walk"])).resolves.toEqual(["morning-walk"]);
    expect(token).toHaveBeenCalledTimes(2);
    const candidateCall = fetchImpl.mock.calls.find(([input]) => new URL(String(input)).pathname.endsWith("/candidates"));
    expect(JSON.parse(String(candidateCall?.[1]?.body))).toEqual({ writerNihoUserId: "writer", query: "morning", cursor: "opaque-cursor" });
  });

  it("fails closed on non-200, unknown versions, malformed labels, and unrequested permissions", async () => {
    await expect(client(() => json({ error: "unavailable" }, 503)).value.categories()).rejects.toThrow();
    await expect(client(() => json({ version: 2, items: [] })).value.categories()).rejects.toThrow();
    await expect(client(() => json({ version: 1, items: [{ slug: "walks", labelEn: "", labelJa: "散策", displayOrder: 0, revision: 1 }] })).value.categories()).rejects.toThrow();
    await expect(client(() => json({ version: 1, allowedSlugs: ["../private"] })).value.checkRelated("writer", ["morning-walk"])).rejects.toThrow();
  });

  it("builds category display only from the current Experience response and requires every related slug in order", async () => {
    const { value } = client((url) => url.pathname.endsWith("/categories")
      ? json({ version: 1, items: [{ slug: "walks", labelEn: "Walks", labelJa: "散策", displayOrder: 4, revision: 7 }] })
      : json({ version: 1, allowedSlugs: ["morning-walk"] }));
    const facts = await experienceFactsSource("writer", value).read({ actorId: "writer", pageId: "page", dest: "exp", handle: "exp", category: "walks", related: ["morning-walk"] });
    expect(facts).toEqual({ relatedLive: true, categoryCurrent: true, categoryDisplay: { labelEn: "Walks", labelJa: "散策", displayOrder: 4, revision: 7 } });
    await expect(experienceFactsSource("writer", value).read({ actorId: "writer", pageId: "page", dest: "exp", handle: "exp", category: "disabled", related: ["morning-walk"] }))
      .resolves.toMatchObject({ categoryCurrent: false });
  });

  it("stops chunked oversized authority and metadata-token responses and rejects malformed UTF-8", async () => {
    const chunks = () => [new Uint8Array(40_000), new Uint8Array(40_000)];
    const oversizedAuthority = client(() => {
      const pending = chunks();
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) { const chunk = pending.shift(); chunk ? controller.enqueue(chunk) : controller.close(); } }), { headers: { "content-type": "application/json" } });
    });
    await expect(oversizedAuthority.value.categories()).rejects.toThrow();

    const malformed = client(() => new Response(Uint8Array.of(0xc3, 0x28), { headers: { "content-type": "application/json" } }));
    await expect(malformed.value.categories()).rejects.toThrow();

    const fetchImpl = vi.fn(async () => {
      const pending = [new Uint8Array(10_000), new Uint8Array(10_000)];
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) { const chunk = pending.shift(); chunk ? controller.enqueue(chunk) : controller.close(); } }));
    }) as unknown as typeof fetch;
    const withMetadataToken = new ExperienceArticleAuthorityClient(fetchImpl, undefined, () => SETTINGS);
    await expect(withMetadataToken.candidates("writer")).rejects.toThrow("too large");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
