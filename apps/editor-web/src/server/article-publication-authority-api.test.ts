import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { publicationAuthorityRoute } from "./article-publication-authority-api";

describe("publicationAuthorityRoute", () => {
  it("is always a no-store 404 and has no request-dependent work", async () => {
    for (const input of [undefined, { publicationId: "legacy", version: 1 }]) {
      void input;
      const response = await publicationAuthorityRoute();
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });
});
