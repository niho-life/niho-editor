import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getPublication: vi.fn(),
  getDraftPage: vi.fn(),
  getPublicationVersion: vi.fn(),
}));

vi.mock("@niho/editor-store", () => ({
  isPageId: (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value),
  getPublication: mocks.getPublication,
  getDraftPage: mocks.getDraftPage,
  getPublicationVersion: mocks.getPublicationVersion,
}));

import type { PublicationAuthorityDeps } from "./article-publication-authority-api";
import { publicationAuthorityRoute } from "./article-publication-authority-api";

const ID = "00000000-0000-4000-8000-000000000042";
const DB = { query: vi.fn() } as never;

function deps(verify: PublicationAuthorityDeps["verify"] = vi.fn(async () => ({ ok: true as const }))): PublicationAuthorityDeps {
  return {
    settings: () => ({ enabled: true, audience: "editor-authority", allowedEmails: ["runtime@example-project.iam.gserviceaccount.com"] }),
    verify,
    db: () => DB,
  };
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://editor.example.invalid/internal/article-authority/v1/publication", {
    method: "POST",
    headers: { authorization: "Bearer google.signed.token", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPublication.mockResolvedValue({ pageId: ID, dest: "exp", handle: "exp", version: 3, stoppedAt: null });
  mocks.getDraftPage.mockResolvedValue({ id: ID, ownerId: "synthetic-niho-writer" });
  mocks.getPublicationVersion.mockResolvedValue({ pageId: ID, version: 3, handle: "exp", snapshot: { related: ["morning-walk"] } });
});

describe("publicationAuthorityRoute", () => {
  it("returns only the current exp publication's server-side owner and related slugs", async () => {
    const response = await publicationAuthorityRoute(request({ publicationId: ID, version: 3 }), deps());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ version: 1, writerNihoUserId: "synthetic-niho-writer", slugs: ["morning-walk"] });
  });

  it("rejects ordinary API keys, cookies, Origin requests, and unallowed Google identities before reading data", async () => {
    for (const [headers, verify] of [
      [{ authorization: "" }, vi.fn()],
      [{ authorization: "ApiKey photo-key", cookie: "session=browser" }, vi.fn()],
      [{ origin: "https://editor.example.invalid" }, vi.fn(async () => ({ ok: true as const }))],
      [{}, vi.fn(async () => ({ ok: false as const, code: "bad_email" as const }))],
    ] as const) {
      const response = await publicationAuthorityRoute(request({ publicationId: ID, version: 3 }, headers), deps(verify));
      expect([401, 403]).toContain(response.status);
    }
    expect(mocks.getPublication).not.toHaveBeenCalled();
  });

  it("uses the same 404 for stopped, wrong-destination, missing, and version-mismatched publications", async () => {
    const rows = [
      null,
      { pageId: ID, dest: "niho", handle: "niho", version: 3, stoppedAt: null },
      { pageId: ID, dest: "exp", handle: "exp", version: 2, stoppedAt: null },
      { pageId: ID, dest: "exp", handle: "exp", version: 3, stoppedAt: "2030-01-03T00:00:00.000Z" },
    ];
    for (const row of rows) {
      mocks.getPublication.mockResolvedValueOnce(row);
      const response = await publicationAuthorityRoute(request({ publicationId: ID, version: 3 }), deps());
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });

  it("rejects malformed snapshots and strict-body/version violations without returning an old permission", async () => {
    mocks.getPublicationVersion.mockResolvedValueOnce({ pageId: ID, version: 3, handle: "exp", snapshot: { related: ["duplicate", "duplicate"] } });
    expect((await publicationAuthorityRoute(request({ publicationId: ID, version: 3 }), deps())).status).toBe(404);
    expect((await publicationAuthorityRoute(request({ publicationId: ID, version: 3, writerNihoUserId: "claimed" }), deps())).status).toBe(400);
    expect((await publicationAuthorityRoute(request({ publicationId: ID, version: 0 }), deps())).status).toBe(400);
  });
});
