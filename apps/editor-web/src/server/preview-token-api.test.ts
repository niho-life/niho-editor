// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isPreviewToken, type Author } from "@niho/editor-publish-contract";
import { createReferenceServer, type ReferenceWorld } from "@niho/editor-publish-contract/test-support";
import type { AuthProvider } from "../auth/types";
import { createPublicApi } from "../public-api/handler";
import { draftContent, minutesFrom } from "../public-api/testing/synthetic";
import { worldFaces, worldSource } from "../public-api/testing/world-source";
import { issuePreviewTokenRoute, PREVIEW_TOKEN_TTL_MS, type PreviewTokenApiDeps, type PreviewTokenRecord } from "./preview-token-api";

const ORIGIN = "http://editor.test";
const OWNER = "owner-a";
const NOW = "2026-10-01T00:00:00.000Z";
const WRITER: Author = { name: "Example Writer", handle: null, url: null };

type Page = { id: string; owner: string; deleted: boolean };

/** メモリの保存先（packages/editor-store と同じ約束：本人の・ゴミ箱でないページだけに書き、それ以外は false）。 */
function memory(pages: Page[]) {
  const rows: PreviewTokenRecord[] = [];
  return {
    rows,
    store: {
      async issue(owner: string, record: PreviewTokenRecord) {
        if (!pages.some((page) => page.id === record.pageId && page.owner === owner && !page.deleted)) return false;
        rows.push(record);
        return true;
      },
    },
  };
}

function auth(userId: string | null): AuthProvider {
  return {
    mode: "stub",
    getSession: async () => (userId ? { userId, mode: "stub" as const } : null),
    beginLogin: async () => new Response(null),
    completeLogin: async () => new Response(null),
    logout: async () => new Response(null),
  };
}

function setup(
  options: { user?: string | null; roles?: string[]; connections?: string[]; pages?: Page[]; db?: boolean; author?: () => Promise<Author> } = {},
) {
  const pageId = randomUUID();
  const pages = options.pages ?? [{ id: pageId, owner: OWNER, deleted: false }];
  const saved = memory(pages);
  const connections = options.connections ?? ["site-alpha"];
  const deps: PreviewTokenApiDeps = {
    auth: () => auth(options.user === undefined ? OWNER : options.user),
    store: () => (options.db === false ? null : saved.store),
    roles: (session) => ({ read: async (actor) => (actor === OWNER && session.userId === OWNER ? options.roles ?? [] : []) }),
    authors: (session) => ({
      read: async (actor) => {
        if (actor !== session.userId) throw new Error("another actor");
        return options.author ? options.author() : WRITER;
      },
    }),
    connections: () => (options.db === false ? null : { has: async (actor, handle) => actor === OWNER && connections.includes(handle) }),
    categoryActive: async (_session, category) => category === "walks",
    clock: { now: () => NOW },
    env: {},
  };
  return { pageId, deps, rows: saved.rows };
}

function post(id: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/pages/${id}/preview-token`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, host: "editor.test", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/pages/{id}/preview-token", () => {
  it("issues a 15-minute pv_ token for the owner's connection and stores only its hash", async () => {
    const { pageId, deps, rows } = setup();
    const response = await issuePreviewTokenRoute(post(pageId, { handle: "site-alpha" }), pageId, deps);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = (await response.json()) as { token: string; expiresAt: string; url: string };
    expect(isPreviewToken(body.token)).toBe(true);
    expect(body.expiresAt).toBe(new Date(Date.parse(NOW) + PREVIEW_TOKEN_TTL_MS).toISOString());
    expect(body.url).toBe(`https://api.editor.niho.life/v1/preview/${body.token}.json`);
    expect(rows).toEqual([{
      pageId,
      handle: "site-alpha",
      sha256: createHash("sha256").update(body.token).digest("hex"),
      issuedAt: NOW,
      expiresAt: body.expiresAt,
      author: WRITER,
    }]);
    expect(JSON.stringify(rows)).not.toContain(body.token);
  });

  it("binds the owner's author to the token, and issues without one when it cannot be read or does not fit", async () => {
    const full: Author = { name: "Example Writer", handle: "example-writer", url: "https://writer.example.com/" };
    const cases: [string, () => Promise<Author>, Author | null][] = [
      ["full author", async () => full, full],
      ["no profile", async () => { throw new Error("author profile is not available"); }, null],
      ["blank name", async () => ({ name: "   ", handle: null, url: null }), null],
      ["long name", async () => ({ name: "a".repeat(257), handle: null, url: null }), null],
      ["control character", async () => ({ name: "Example\u0007Writer", handle: null, url: null }), null],
      ["blank handle", async () => ({ name: "Example Writer", handle: "", url: null }), null],
      ["http url", async () => ({ name: "Example Writer", handle: null, url: "http://writer.example.com/" }), null],
    ];
    for (const [label, author, expected] of cases) {
      const { pageId, deps, rows } = setup({ author });
      const response = await issuePreviewTokenRoute(post(pageId, { handle: "site-alpha" }), pageId, deps);
      expect(response.status, label).toBe(201);
      expect(rows.map((row) => row.author), label).toEqual([expected]);
    }
  });

  it("issues for a face only when the owner's NIHO roles open it", async () => {
    const writer = setup({ roles: ["writer"] });
    expect((await issuePreviewTokenRoute(post(writer.pageId, { handle: "exp", category: "walks" }), writer.pageId, writer.deps)).status).toBe(201);
    expect((await issuePreviewTokenRoute(post(writer.pageId, { handle: "niho" }), writer.pageId, writer.deps)).status).toBe(404);
    const nobody = setup({ roles: [] });
    expect((await issuePreviewTokenRoute(post(nobody.pageId, { handle: "exp", category: "walks" }), nobody.pageId, nobody.deps)).status).toBe(404);
    expect(nobody.rows).toEqual([]);
    const disabled = setup({ roles: ["writer"] });
    expect((await issuePreviewTokenRoute(post(disabled.pageId, { handle: "exp", category: "disabled" }), disabled.pageId, disabled.deps)).status).toBe(404);
    expect(disabled.rows).toEqual([]);
    const outage = setup({ roles: ["writer"] });
    outage.deps.categoryActive = async () => { throw new Error("upstream unavailable"); };
    expect((await issuePreviewTokenRoute(post(outage.pageId, { handle: "exp", category: "walks" }), outage.pageId, outage.deps)).status).toBe(503);
    expect(outage.rows).toEqual([]);
  });

  it("answers the same 404 for another person's page, a page in the trash, a missing or malformed id and a connection that is not the owner's", async () => {
    const otherPage = randomUUID();
    const trashed = randomUUID();
    const { pageId, deps, rows } = setup({
      pages: [
        { id: randomUUID(), owner: OWNER, deleted: false },
        { id: otherPage, owner: "someone-else", deleted: false },
        { id: trashed, owner: OWNER, deleted: true },
      ],
    });
    const responses = await Promise.all([
      issuePreviewTokenRoute(post(otherPage, { handle: "site-alpha" }), otherPage, deps),
      issuePreviewTokenRoute(post(trashed, { handle: "site-alpha" }), trashed, deps),
      issuePreviewTokenRoute(post(pageId, { handle: "site-alpha" }), pageId, deps),
      issuePreviewTokenRoute(post("not-a-uuid", { handle: "site-alpha" }), "not-a-uuid", deps),
      issuePreviewTokenRoute(post(otherPage, { handle: "site-beta" }), otherPage, deps),
    ]);
    const shapes = new Set(await Promise.all(responses.map(async (response) => JSON.stringify([response.status, [...response.headers], await response.text()]))));
    expect(shapes.size).toBe(1);
    expect(responses[0]?.status).toBe(404);
    expect(rows).toEqual([]);
  });

  it("refuses without a session (401), from another origin (403), without a DB (503) and with a malformed body (400)", async () => {
    const anonymous = setup({ user: null });
    expect((await issuePreviewTokenRoute(post(anonymous.pageId, { handle: "site-alpha" }), anonymous.pageId, anonymous.deps)).status).toBe(401);
    const { pageId, deps, rows } = setup();
    expect((await issuePreviewTokenRoute(post(pageId, { handle: "site-alpha" }, { origin: "https://evil.example" }), pageId, deps)).status).toBe(403);
    const offline = setup({ db: false });
    expect((await issuePreviewTokenRoute(post(offline.pageId, { handle: "site-alpha" }), offline.pageId, offline.deps)).status).toBe(503);
    for (const body of [{}, { handle: "Site_Alpha" }, { handle: "admin" }, { handle: "exp" }, { handle: "exp", category: "Not A Slug" }, { handle: "site-alpha", extra: 1 }, ["site-alpha"], "nope", { handle: 1 }]) {
      const response = await issuePreviewTokenRoute(post(pageId, body), pageId, deps);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(rows).toEqual([]);
  });

  it("issues a token the public API serves to that destination's credential only, for 15 minutes", async () => {
    const { pageId, deps, rows } = setup();
    const response = await issuePreviewTokenRoute(post(pageId, { handle: "site-alpha" }), pageId, deps);
    const { token } = (await response.json()) as { token: string };
    const key = `ek_${"A".repeat(42)}Q`;
    const otherKey = `ek_${"B".repeat(42)}Q`;
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const world = (now: string): ReferenceWorld => ({
      now,
      pages: [{ id: pageId, ownerId: OWNER, draft: { revision: 3, savedAt: NOW, content: draftContent("preview-me") } }],
      publications: [],
      connections: [
        { id: "c-alpha", handle: "site-alpha", ownerId: OWNER, removedAt: null, keys: [{ sha256: hash(key), revokedAt: null }] },
        { id: "c-beta", handle: "site-beta", ownerId: "owner-b", removedAt: null, keys: [{ sha256: hash(otherKey), revokedAt: null }] },
      ],
      faceCredentials: [],
      previewTokens: rows.map((row) => ({ sha256: row.sha256, pageId: row.pageId, handle: row.handle, issuedAt: row.issuedAt, expiresAt: row.expiresAt })),
    });
    const read = async (now: string, credential: string) => {
      const request = { method: "GET", url: `/v1/preview/${token}.json`, headers: { authorization: `Bearer ${credential}` }, requestId: "req_preview" };
      const production = await createPublicApi({ source: worldSource(world(now)), faces: worldFaces(world(now)), clock: { now: () => now } }).handle(request);
      expect(production).toEqual(await createReferenceServer(world(now)).handle(request));
      return production.status;
    };
    expect(await read(minutesFrom(NOW, 1), key)).toBe(200);
    expect(await read(minutesFrom(NOW, 1), otherKey)).toBe(404);
    expect(await read(minutesFrom(NOW, 15), key)).toBe(404);
  });
});
