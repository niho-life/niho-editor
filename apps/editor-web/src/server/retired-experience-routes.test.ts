import { describe, expect, it, vi } from "vitest";

const notFound = vi.hoisted(() => vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }));
vi.mock("next/navigation", () => ({ notFound }));

import ExperienceDestinationPage from "../app/(editor)/destinations/experience/page";
import { GET as listArticleLinks } from "../app/api/account/article-links/route";
import { POST as decideArticleLink } from "../app/api/account/article-links/[id]/[decision]/route";
import { GET as experienceOptions } from "../app/api/account/experience-options/route";
import { POST as publicationAuthority } from "../app/internal/article-authority/v1/publication/route";

describe("retired Experience routes", () => {
  it("returns an uncacheable 404 for options, invitations, decisions, and publication authority", async () => {
    const responses = [listArticleLinks(), decideArticleLink(), experienceOptions(), await publicationAuthority()];
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });

  it("closes the former destination settings page", () => {
    expect(() => ExperienceDestinationPage()).toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});
