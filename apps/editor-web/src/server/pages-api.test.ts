import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidPageCursorError,
  type Block,
  type CreatePageInput,
  type DeleteResult,
  type MovePageResult,
  type Page,
  type PageChunk,
  type PageChunkOptions,
  type PagePatch,
  type PageSummary,
  type PageVersion,
  type PageVersionSummary,
  type RestoreOptions,
  type RestoreResult,
  type SaveOptions,
  type SaveResult,
  type TrashedPage,
  type VersionReason,
} from "@niho/editor-store";
import { stubAuthProvider } from "../auth/stub";
import { AuthTemporarilyUnavailable, type AuthProvider } from "../auth/types";
import { MAX_BODY_BYTES } from "./http";
import { createPage, deletePage, getPage, listPages, movePage, patchPage, type PagesApiDeps, type PagesStore } from "./pages-api";
import { listTrash, restoreFromTrash } from "./trash-api";
import { getVersion, listVersions, restoreVersion } from "./versions-api";

const ORIGIN = "http://editor.test";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Page & { owner: string; deleted: boolean; deletedAt: string | null };
type VersionRow = PageVersion & { pageId: string };

/**
 * owner ごとに分けた、メモリの中だけの合成の store（EditorStore と同じ約束: 該当なしは null、revision の不一致は conflict）。
 * 版は「本文が変わる保存のたび」に残す（間隔は見ない。間隔の規則は editor-store の DB のテストで確かめる）。
 */
function memoryStore() {
  const rows = new Map<string, Row>();
  const versions: VersionRow[] = [];
  const published = new Set<string>();
  const visible = (owner: string, id: string) => {
    if (!UUID.test(id)) return null;
    const row = rows.get(id);
    return row && row.owner === owner && !row.deleted ? row : null;
  };
  const strip = (row: Row): Page => {
    const page: Partial<Row> = { ...row };
    delete page.owner;
    delete page.deleted;
    delete page.deletedAt;
    return page as Page;
  };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const snapshot = (row: Row, reason: VersionReason) => {
    const latest = versions.filter((version) => version.pageId === row.id).at(-1);
    if (row.blocks.length === 0 || (latest && same(latest.blocks, row.blocks))) return;
    versions.push({ pageId: row.id, version: (latest?.version ?? 0) + 1, reason, createdAt: new Date().toISOString(), blocks: row.blocks });
  };
  const write = (row: Row, patch: PagePatch) => {
    Object.assign(row, patch, { revision: row.revision + 1, updatedAt: new Date().toISOString() });
    return strip(row);
  };
  const store = {
    rows,
    versions,
    published,
    async createPage(owner: string, input: CreatePageInput = {}): Promise<Page> {
      const now = new Date().toISOString();
      const page: Page = { id: randomUUID(), kind: input.kind ?? "note", title: input.title ?? "", lang: input.lang ?? "ja", blocks: input.blocks ?? [], cover: null, lead: null, parent: null, recipe: null, stepStatus: null, sortOrder: 0, revision: 1, createdAt: now, updatedAt: now };
      rows.set(page.id, { ...page, owner, deleted: false, deletedAt: null });
      return page;
    },
    /** cursor は前の区切りの最後の id（知らない id は読めない cursor）。 */
    async listPageChunk(owner: string, options: PageChunkOptions = {}): Promise<PageChunk> {
      const sorted = [...rows.values()]
        .filter((row) => row.owner === owner && !row.deleted)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
      let start = 0;
      if (options.cursor !== undefined && options.cursor !== null) {
        start = sorted.findIndex((row) => row.id === options.cursor) + 1;
        if (start === 0) throw new InvalidPageCursorError();
      }
      const limit = options.limit ?? 100;
      const pages: PageSummary[] = sorted.slice(start, start + limit).map(({ id, kind, title, lang, parent, stepStatus, sortOrder, createdAt, updatedAt }) => ({ id, kind, title, lang, parent, stepStatus, sortOrder, createdAt, updatedAt, publication: null }));
      return { pages, next: start + limit < sorted.length ? (pages.at(-1)?.id ?? null) : null };
    },
    async getPage(owner: string, id: string): Promise<Page | null> {
      const row = visible(owner, id);
      return row ? strip(row) : null;
    },
    async savePage(owner: string, id: string, patch: PagePatch, options: SaveOptions): Promise<SaveResult | null> {
      const row = visible(owner, id);
      if (!row) return null;
      if (row.revision !== options.baseRevision) return { status: "conflict", page: strip(row) };
      if (options.overwrite === true) snapshot(row, "overwrite");
      else if (patch.blocks !== undefined && !same(patch.blocks, row.blocks)) snapshot(row, "autosave");
      return { status: "saved", page: write(row, patch) };
    },
    async listVersions(owner: string, id: string): Promise<PageVersionSummary[] | null> {
      if (!visible(owner, id)) return null;
      return versions
        .filter((version) => version.pageId === id)
        .reverse()
        .slice(0, 100)
        .map(({ version, reason, createdAt, blocks }) => ({ version, reason, createdAt, blockCount: blocks.length }));
    },
    async getVersion(owner: string, id: string, number: number): Promise<PageVersion | null> {
      if (!visible(owner, id)) return null;
      const found = versions.find((version) => version.pageId === id && version.version === number);
      return found ? { version: found.version, reason: found.reason, createdAt: found.createdAt, blocks: found.blocks } : null;
    },
    async restoreVersion(owner: string, id: string, number: number, options: RestoreOptions): Promise<RestoreResult | null> {
      const row = visible(owner, id);
      if (!row) return null;
      const found = versions.find((version) => version.pageId === id && version.version === number);
      if (!found) return null;
      if (row.revision !== options.baseRevision) return { status: "conflict", page: strip(row) };
      const accepted = options.accept(found.blocks);
      if (accepted === null) return { status: "unrestorable" };
      snapshot(row, "restore");
      return { status: "restored", page: write(row, { blocks: accepted }) };
    },
    /** EditorStore と同じ約束（段は 2 まで・循環は断る・変えるのは親だけ）。段の数え方は editor-store の DB のテストで確かめる。 */
    async movePage(owner: string, id: string, parent: string | null): Promise<MovePageResult | null> {
      const row = visible(owner, id);
      if (!row) return null;
      if (parent !== null && !UUID.test(parent)) return null;
      if (parent === id) return "cycle";
      if (parent !== null && !visible(owner, parent)) return null;
      const depthOf = (start: string): number => {
        let depth = 0;
        for (let at = visible(owner, start); at?.parent; at = visible(owner, at.parent)) depth++;
        return depth;
      };
      const heightOf = (start: string): number => {
        const children = [...rows.values()].filter((item) => item.owner === owner && !item.deleted && item.parent === start);
        return children.length === 0 ? 0 : 1 + Math.max(...children.map((child) => heightOf(child.id)));
      };
      const inside = (candidate: string): boolean => {
        for (let at = visible(owner, candidate); at; at = at.parent ? visible(owner, at.parent) : null) if (at.id === id) return true;
        return false;
      };
      if (parent !== null && inside(parent)) return "cycle";
      if ((parent === null ? -1 : depthOf(parent)) + 1 + heightOf(id) > 2) return "too_deep";
      row.parent = parent;
      return "moved";
    },
    async deletePage(owner: string, id: string): Promise<DeleteResult | null> {
      const row = visible(owner, id);
      if (!row) return null;
      if (published.has(id)) return "published";
      Object.assign(row, { deleted: true, deletedAt: new Date().toISOString() });
      return "deleted";
    },
    async listTrash(owner: string): Promise<TrashedPage[]> {
      return [...rows.values()]
        .filter((row) => row.owner === owner && row.deleted)
        .map(({ id, kind, title, deletedAt }) => ({ id, kind, title, deletedAt: deletedAt! }));
    },
    async restoreFromTrash(owner: string, id: string): Promise<boolean> {
      if (!UUID.test(id)) return false;
      const row = rows.get(id);
      if (!row || row.owner !== owner || !row.deleted) return false;
      Object.assign(row, { deleted: false, deletedAt: null });
      return true;
    },
  };
  return store satisfies PagesStore;
}

type MemoryStore = ReturnType<typeof memoryStore>;

function authAs(userId: string | null): AuthProvider {
  return { ...stubAuthProvider, getSession: async () => (userId ? { userId, mode: "stub" } : null) };
}

function deps(userId: string | null, store: MemoryStore | null): PagesApiDeps {
  return { auth: () => authAs(userId), store: () => store, env: {} };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method, headers: { host: "editor.test", ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }), ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

/** date 以外の header を並べたもの（同じ応答かどうかを比べる）。 */
async function snapshot(response: Response) {
  const headers = [...response.headers.entries()].filter(([name]) => name !== "date").sort();
  return { status: response.status, headers, body: await response.text() };
}

const paragraph = (text: string): Block => ({ type: "paragraph", content: [{ type: "text", text }] });

describe("/api/pages", () => {
  it("creates an empty page, saves it, and reads it back", async () => {
    const store = memoryStore();
    const created = await createPage(request("POST", "/api/pages", {}), deps("user-a", store));
    expect(created.status).toBe(201);
    const { page } = (await created.json()) as { page: Page };
    expect(page.title).toBe("");
    expect(page.blocks).toEqual([]);
    expect(page.revision).toBe(1);

    const blocks = [paragraph("合成の本文")];
    const saved = await patchPage(request("PATCH", `/api/pages/${page.id}`, { title: "合成", blocks, baseRevision: page.revision }), page.id, deps("user-a", store));
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { page: Page }).page.revision).toBe(2);

    const read = await getPage(request("GET", `/api/pages/${page.id}`), page.id, deps("user-a", store));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { page: Page }).page).toMatchObject({ id: page.id, title: "合成", blocks, revision: 2 });

    const list = await listPages(request("GET", "/api/pages"), deps("user-a", store));
    expect(((await list.json()) as { pages: PageSummary[] }).pages.map((item) => item.id)).toEqual([page.id]);
  });

  it("stores a body as the limited AST: drops display-only attributes and refuses HTML, script and unsafe links with the same 400", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", {});
    const patch = (body: Record<string, unknown>) =>
      patchPage(request("PATCH", `/api/pages/${page.id}`, { ...body, baseRevision: store.rows.get(page.id)!.revision }), page.id, deps("user-a", store));
    const link = { type: "link", attrs: { href: "https://niho.life/", target: "_blank", rel: "noopener noreferrer nofollow", class: null, title: null } };

    const saved = await patch({ blocks: [{ type: "paragraph", content: [{ type: "text", text: "NIHO", marks: [link] }] }] });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { page: Page }).page.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "NIHO", marks: [{ type: "link", attrs: { href: "https://niho.life/" } }] }] },
    ]);

    const refused = [
      [{ type: "script", content: [{ type: "text", text: "alert(1)" }] }],
      [{ type: "html", html: "<img src=x onerror=alert(1)>" }],
      [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }],
      [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "x" }] }],
      [{ type: "image", attrs: { assetId: "not-a-uuid", src: "https://example.com/a.png" } }],
    ];
    for (const blocks of refused) {
      const response = await patch({ blocks });
      expect(response.status, JSON.stringify(blocks)).toBe(400);
      expect(await response.text()).toBe('{"error":"bad_request"}');
    }
  });

  it("answers 409 with the current page to a stale baseRevision and writes nothing", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { title: "最初", blocks: [paragraph("最初")] });
    // 別の画面の保存
    await store.savePage("user-a", page.id, { title: "別の画面", blocks: [paragraph("別の画面")] }, { baseRevision: 1 });
    const before = structuredClone(store.rows.get(page.id));

    const response = await patchPage(request("PATCH", `/api/pages/${page.id}`, { title: "この画面", blocks: [paragraph("この画面")], baseRevision: 1 }), page.id, deps("user-a", store));
    expect(response.status).toBe(409);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = (await response.json()) as { error: string; page: Page };
    expect(Object.keys(body).sort()).toEqual(["error", "page"]);
    expect(body.error).toBe("conflict");
    expect(body.page).toMatchObject({ id: page.id, title: "別の画面", blocks: [paragraph("別の画面")], revision: 2 });
    expect(typeof body.page.updatedAt).toBe("string");
    expect(body.page).not.toHaveProperty("owner");
    expect(store.rows.get(page.id)).toEqual(before);

    // 「この内容で上書き」: 競合の応答の revision を取り直して overwrite で再送する
    const spy = vi.spyOn(store, "savePage");
    const overwritten = await patchPage(
      request("PATCH", `/api/pages/${page.id}`, { blocks: [paragraph("この画面")], baseRevision: body.page.revision, overwrite: true }),
      page.id,
      deps("user-a", store),
    );
    expect(overwritten.status).toBe(200);
    expect(spy.mock.calls[0]?.[3]).toEqual({ baseRevision: 2, overwrite: true });
    expect(store.versions.at(-1)).toMatchObject({ reason: "overwrite", blocks: [paragraph("別の画面")] });
    expect(((await overwritten.json()) as { page: Page }).page.revision).toBe(3);
  });

  it("answers the same 404 for another owner's page, an unknown id, a malformed id, and a deleted page — even when the baseRevision would conflict", async () => {
    const store = memoryStore();
    const theirs = await store.createPage("user-b", { title: "theirs", blocks: [paragraph("theirs")] });
    await store.savePage("user-b", theirs.id, { title: "theirs" }, { baseRevision: 1 });
    await store.savePage("user-b", theirs.id, { blocks: [paragraph("theirs 2")] }, { baseRevision: 2 });
    const removed = await store.createPage("user-a", { title: "removed" });
    await store.deletePage("user-a", removed.id);
    const ids = [theirs.id, randomUUID(), "not-a-uuid", "../../etc", removed.id];

    const reads = await Promise.all(ids.map(async (id) => snapshot(await getPage(request("GET", `/api/pages/${encodeURIComponent(id)}`), id, deps("user-a", store)))));
    for (const read of reads) expect(read).toEqual(reads[0]);
    expect(reads[0]?.status).toBe(404);
    expect(reads[0]?.body).toBe('{"error":"not_found"}');

    const calls: Array<[string, (id: string) => Promise<Response>]> = [
      // theirs の revision は 3。1（不一致）でも 3（一致）でも同じ 404
      ["PATCH stale", (id) => patchPage(request("PATCH", "/api/pages/x", { title: "overwrite", baseRevision: 1 }), id, deps("user-a", store))],
      ["PATCH current", (id) => patchPage(request("PATCH", "/api/pages/x", { title: "overwrite", baseRevision: 3 }), id, deps("user-a", store))],
      ["PATCH overwrite", (id) => patchPage(request("PATCH", "/api/pages/x", { title: "overwrite", baseRevision: 1, overwrite: true }), id, deps("user-a", store))],
      ["DELETE", (id) => deletePage(request("DELETE", "/api/pages/x"), id, deps("user-a", store))],
      ["GET versions", (id) => listVersions(request("GET", "/api/pages/x/versions"), id, deps("user-a", store))],
      ["GET version", (id) => getVersion(request("GET", "/api/pages/x/versions/1"), id, "1", deps("user-a", store))],
      ["POST restore stale", (id) => restoreVersion(request("POST", "/api/pages/x/versions/1/restore", { baseRevision: 1 }), id, "1", deps("user-a", store))],
      ["POST restore current", (id) => restoreVersion(request("POST", "/api/pages/x/versions/1/restore", { baseRevision: 3 }), id, "1", deps("user-a", store))],
    ];
    for (const [label, call] of calls) {
      const results = await Promise.all(ids.map(async (id) => snapshot(await call(id))));
      for (const result of results) expect(result, label).toEqual(reads[0]);
    }
    expect(store.rows.get(theirs.id)).toMatchObject({ title: "theirs", revision: 3, deleted: false });
    expect(store.versions.filter((version) => version.pageId === theirs.id)).toHaveLength(1);
  });

  it("answers 401 without a session on every route", async () => {
    const store = memoryStore();
    const id = randomUUID();
    const responses = [
      await listPages(request("GET", "/api/pages"), deps(null, store)),
      await createPage(request("POST", "/api/pages", {}), deps(null, store)),
      await getPage(request("GET", `/api/pages/${id}`), id, deps(null, store)),
      await patchPage(request("PATCH", `/api/pages/${id}`, { title: "x", baseRevision: 1 }), id, deps(null, store)),
      await deletePage(request("DELETE", `/api/pages/${id}`), id, deps(null, store)),
      await listVersions(request("GET", `/api/pages/${id}/versions`), id, deps(null, store)),
      await getVersion(request("GET", `/api/pages/${id}/versions/1`), id, "1", deps(null, store)),
      await restoreVersion(request("POST", `/api/pages/${id}/versions/1/restore`, { baseRevision: 1 }), id, "1", deps(null, store)),
      await listTrash(request("GET", "/api/trash"), deps(null, store)),
      await restoreFromTrash(request("POST", `/api/trash/${id}/restore`), id, deps(null, store)),
    ];
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('{"error":"unauthorized"}');
    }
    expect(store.rows.size).toBe(0);
  });

  it("answers 403 to writes from another origin or without an Origin", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [paragraph("一")] });
    await store.savePage("user-a", page.id, { blocks: [paragraph("二")] }, { baseRevision: 1 });
    const trashed = await store.createPage("user-a");
    await store.deletePage("user-a", trashed.id);
    for (const origin of ["https://evil.example", "null", ""]) {
      const headers = { origin };
      expect((await createPage(request("POST", "/api/pages", {}, headers), deps("user-a", store))).status).toBe(403);
      expect((await patchPage(request("PATCH", `/api/pages/${page.id}`, { title: "x", baseRevision: 2 }, headers), page.id, deps("user-a", store))).status).toBe(403);
      expect((await deletePage(request("DELETE", `/api/pages/${page.id}`, undefined, headers), page.id, deps("user-a", store))).status).toBe(403);
      expect((await restoreVersion(request("POST", `/api/pages/${page.id}/versions/1/restore`, { baseRevision: 2 }, headers), page.id, "1", deps("user-a", store))).status).toBe(403);
      expect((await restoreFromTrash(request("POST", `/api/trash/${trashed.id}/restore`, undefined, headers), trashed.id, deps("user-a", store))).status).toBe(403);
    }
    expect(store.rows.size).toBe(2);
    expect(store.rows.get(page.id)).toMatchObject({ title: "", revision: 2, deleted: false, blocks: [paragraph("二")] });
    expect(store.rows.get(trashed.id)?.deleted).toBe(true);
  });

  it("answers 413 above 1 MiB and 400 to bodies that are not JSON, not the right shape, or without a valid baseRevision", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a");
    const big = JSON.stringify({ title: "x", baseRevision: 1, blocks: [{ type: "paragraph", content: [{ type: "text", text: "a".repeat(MAX_BODY_BYTES) }] }] });
    expect((await patchPage(request("PATCH", `/api/pages/${page.id}`, big), page.id, deps("user-a", store))).status).toBe(413);
    expect((await createPage(request("POST", "/api/pages", big), deps("user-a", store))).status).toBe(413);

    const bad: Array<[unknown, Record<string, string>?]> = [
      ["{", undefined],
      ["title=x", { "content-type": "application/x-www-form-urlencoded" }],
      [{ title: "x", baseRevision: 1 }, { "content-type": "text/plain" }],
      [{}, undefined],
      [{ baseRevision: 1 }, undefined],
      [{ blocks: "<p>x</p>" }, undefined],
      [{ blocks: "<p>x</p>", baseRevision: 1 }, undefined],
      [{ blocks: { type: "doc" }, baseRevision: 1 }, undefined],
      [{ lang: "fr", baseRevision: 1 }, undefined],
      [{ owner: "user-b", baseRevision: 1 }, undefined],
      [{ revision: 2, title: "x", baseRevision: 1 }, undefined],
      // baseRevision は必須の正の整数
      [{ title: "x" }, undefined],
      [{ title: "x", baseRevision: 0 }, undefined],
      [{ title: "x", baseRevision: -1 }, undefined],
      [{ title: "x", baseRevision: 1.5 }, undefined],
      [{ title: "x", baseRevision: "1" }, undefined],
      [{ title: "x", baseRevision: null }, undefined],
      [{ title: "x", baseRevision: 2 ** 31 }, undefined],
      [{ title: "x", baseRevision: 1, overwrite: "yes" }, undefined],
      [{ title: "x", baseRevision: 1, overwrite: 1 }, undefined],
    ];
    for (const [body, headers] of bad) {
      const response = await patchPage(request("PATCH", `/api/pages/${page.id}`, body, headers), page.id, deps("user-a", store));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).toBe('{"error":"bad_request"}');
    }
    expect(store.rows.get(page.id)).toMatchObject({ title: "", revision: 1 });
  });

  it("pages through the list with limit and cursor, each page exactly once", async () => {
    const store = memoryStore();
    const created: string[] = [];
    for (let index = 0; index < 5; index++) created.push((await store.createPage("user-a", { title: `p${index}` })).id);
    await store.createPage("user-b", { title: "theirs" });

    const first = (await (await listPages(request("GET", "/api/pages"), deps("user-a", store))).json()) as PageChunk;
    expect(first.pages).toHaveLength(5);
    expect(first.next).toBeNull();
    expect(Object.keys(first.pages[0]!).sort()).toEqual(["createdAt", "id", "kind", "lang", "parent", "publication", "sortOrder", "stepStatus", "title", "updatedAt"]);

    const seen: string[] = [];
    let cursor: string | null = null;
    let calls = 0;
    do {
      const query: string = cursor === null ? "?limit=2" : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const response = await listPages(request("GET", `/api/pages${query}`), deps("user-a", store));
      expect(response.status).toBe(200);
      const chunk = (await response.json()) as PageChunk;
      expect(chunk.pages.length).toBeLessThanOrEqual(2);
      seen.push(...chunk.pages.map((page) => page.id));
      cursor = chunk.next;
      calls++;
    } while (cursor !== null && calls < 10);
    expect(calls).toBe(3);
    expect(seen.sort()).toEqual([...created].sort());
  });

  it("answers 400 to an unreadable limit or cursor", async () => {
    const store = memoryStore();
    await store.createPage("user-a");
    for (const query of ["limit=0", "limit=-1", "limit=1.5", "limit=abc", "limit=", "limit=01", "limit=501", "limit=10000", "cursor=", `cursor=${"x".repeat(129)}`, "cursor=not-a-cursor"]) {
      const response = await listPages(request("GET", `/api/pages?${query}`), deps("user-a", store));
      expect(response.status, query).toBe(400);
      expect(await response.text()).toBe('{"error":"bad_request"}');
    }
    expect((await listPages(request("GET", "/api/pages?limit=500"), deps("user-a", store))).status).toBe(200);
    expect((await listPages(request("GET", "/api/pages?limit=1"), deps("user-a", store))).status).toBe(200);
  });

  it("answers 503 without a database and 500 without internal details when the store fails", async () => {
    const id = randomUUID();
    expect((await listPages(request("GET", "/api/pages"), deps("user-a", null))).status).toBe(503);
    expect((await getPage(request("GET", `/api/pages/${id}`), id, deps("user-a", null))).status).toBe(503);
    expect((await listTrash(request("GET", "/api/trash"), deps("user-a", null))).status).toBe(503);
    expect((await listVersions(request("GET", `/api/pages/${id}/versions`), id, deps("user-a", null))).status).toBe(503);

    const unavailableAuth: AuthProvider = {
      ...stubAuthProvider,
      getSession: async () => { throw new AuthTemporarilyUnavailable("provider secret"); },
    };
    const authLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const authUnavailable = await listPages(request("GET", "/api/pages"), {
      auth: () => unavailableAuth,
      store: () => memoryStore(),
    });
    expect(authUnavailable.status).toBe(503);
    expect(await authUnavailable.text()).toBe('{"error":"unavailable"}');
    expect(JSON.stringify(authLog.mock.calls)).not.toContain("secret");
    authLog.mockRestore();

    const store = memoryStore();
    const failure = () => Object.assign(new Error('relation "pages" does not exist at SELECT secret_column FROM pages'), { code: "42P01" });
    store.getPage = async () => {
      throw failure();
    };
    store.deletePage = async () => {
      throw failure();
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const response of [
      await getPage(request("GET", `/api/pages/${id}`), id, deps("user-a", store)),
      await deletePage(request("DELETE", `/api/pages/${id}`), id, deps("user-a", store)),
    ]) {
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('{"error":"internal"}');
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain("SELECT");
    log.mockRestore();
  });

  it("marks every API response noindex, nofollow and uncacheable", async () => {
    const store = memoryStore();
    const id = randomUUID();
    const mine = await store.createPage("user-a", { blocks: [paragraph("一")] });
    const doomed = await store.createPage("user-a");
    const responses = [
      await listPages(request("GET", "/api/pages"), deps("user-a", store)),
      await createPage(request("POST", "/api/pages", {}), deps("user-a", store)),
      await getPage(request("GET", `/api/pages/${id}`), id, deps("user-a", store)),
      await patchPage(request("PATCH", `/api/pages/${id}`, "{"), id, deps("user-a", store)),
      await patchPage(request("PATCH", `/api/pages/${mine.id}`, { title: "x", baseRevision: 9 }), mine.id, deps("user-a", store)),
      await listVersions(request("GET", `/api/pages/${mine.id}/versions`), mine.id, deps("user-a", store)),
      await getVersion(request("GET", `/api/pages/${mine.id}/versions/1`), mine.id, "1", deps("user-a", store)),
      await restoreVersion(request("POST", `/api/pages/${mine.id}/versions/1/restore`, { baseRevision: 1 }), mine.id, "1", deps("user-a", store)),
      await listTrash(request("GET", "/api/trash"), deps("user-a", store)),
      await restoreFromTrash(request("POST", `/api/trash/${id}/restore`), id, deps("user-a", store)),
      await listPages(request("GET", "/api/pages"), deps(null, store)),
      await listPages(request("GET", "/api/pages"), deps("user-a", null)),
    ];
    for (const response of responses) {
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    }
    // 本文の無い成功（204）も同じ header（content-type だけ無い）
    const deleted = await deletePage(request("DELETE", `/api/pages/${doomed.id}`), doomed.id, deps("user-a", store));
    const restored = await restoreFromTrash(request("POST", `/api/trash/${doomed.id}/restore`), doomed.id, deps("user-a", store));
    for (const response of [deleted, restored]) {
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-type")).toBeNull();
    }
  });
});

describe("/api/pages/{id}/parent", () => {
  const move = (id: string, parent: string | null, store: MemoryStore | null, userId: string | null = "user-a", headers?: Record<string, string>) =>
    movePage(request("PATCH", `/api/pages/${id}/parent`, { parent }, headers), id, deps(userId, store));

  it("puts a page into a folder and takes it out again, changing nothing but the parent", async () => {
    const store = memoryStore();
    const folder = await store.createPage("user-a", { title: "鎌倉の記事" });
    const note = await store.createPage("user-a", { title: "取材メモ" });

    const inside = await move(note.id, folder.id, store);
    expect(inside.status).toBe(200);
    expect(await inside.json()).toEqual({ parent: folder.id });
    expect(store.rows.get(note.id)).toMatchObject({ parent: folder.id, revision: note.revision, updatedAt: note.updatedAt });

    const outside = await move(note.id, null, store);
    expect(outside.status).toBe(200);
    expect(store.rows.get(note.id)?.parent).toBe(null);
    // 一覧には両方そのまま残る
    const list = await listPages(request("GET", "/api/pages"), deps("user-a", store));
    expect(((await list.json()) as { pages: PageSummary[] }).pages.length).toBe(2);
  });

  it("answers 401 without a session, 403 from another origin, 503 without a database, and 400 for a body the screen could not send", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", {});
    expect((await move(page.id, null, store, null)).status).toBe(401);
    expect((await move(page.id, null, store, "user-a", { origin: "http://evil.test" })).status).toBe(403);
    expect((await move(page.id, null, null)).status).toBe(503);
    for (const body of [{}, { parent: "" }, { parent: "not-a-uuid" }, { parent: page.id, extra: 1 }, { parent: 1 }]) {
      const response = await movePage(request("PATCH", `/api/pages/${page.id}/parent`, body), page.id, deps("user-a", store));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("answers the same 404 for another person's page, a page that is not there, and a folder that is not the person's own", async () => {
    const store = memoryStore();
    const mine = await store.createPage("user-a", {});
    const theirs = await store.createPage("user-b", {});
    const expected = await snapshot(await move(randomUUID(), null, store));
    expect(expected.status).toBe(404);
    expect(await snapshot(await move(theirs.id, null, store))).toEqual(expected);
    expect(await snapshot(await move("not-a-uuid", null, store))).toEqual(expected);
    expect(await snapshot(await move(mine.id, theirs.id, store))).toEqual(expected);
    expect(await snapshot(await move(mine.id, randomUUID(), store))).toEqual(expected);
  });

  it("refuses a move that would make a fourth 段 with 409 too_deep, and a move into itself with 409 cycle", async () => {
    const store = memoryStore();
    const folder = await store.createPage("user-a", { title: "フォルダ" });
    const note = await store.createPage("user-a", { title: "ページ" });
    const sub = await store.createPage("user-a", { title: "サブページ" });
    const deeper = await store.createPage("user-a", { title: "その下" });
    expect((await move(note.id, folder.id, store)).status).toBe(200);
    expect((await move(sub.id, note.id, store)).status).toBe(200);

    const tooDeep = await move(deeper.id, sub.id, store);
    expect(tooDeep.status).toBe(409);
    expect(await tooDeep.json()).toEqual({ error: "too_deep" });
    expect(store.rows.get(deeper.id)?.parent).toBe(null);

    const cycle = await move(folder.id, note.id, store);
    expect(cycle.status).toBe(409);
    expect(await cycle.json()).toEqual({ error: "cycle" });
    expect((await move(folder.id, folder.id, store)).status).toBe(409);
    expect(store.rows.get(folder.id)?.parent).toBe(null);
  });
});

describe("/api/pages/{id}/versions", () => {
  async function pageWithVersions(store: MemoryStore) {
    const page = await store.createPage("user-a", { blocks: [paragraph("一版")] });
    await store.savePage("user-a", page.id, { blocks: [paragraph("二版"), paragraph("二版の二")] }, { baseRevision: 1 });
    await store.savePage("user-a", page.id, { blocks: [paragraph("三版")] }, { baseRevision: 2 });
    return page;
  }

  it("lists versions newest first without bodies and reads one with its body", async () => {
    const store = memoryStore();
    const page = await pageWithVersions(store);
    const list = await listVersions(request("GET", `/api/pages/${page.id}/versions`), page.id, deps("user-a", store));
    expect(list.status).toBe(200);
    const { versions } = (await list.json()) as { versions: PageVersionSummary[] };
    expect(versions.map(({ version, reason, blockCount }) => ({ version, reason, blockCount }))).toEqual([
      { version: 2, reason: "autosave", blockCount: 2 },
      { version: 1, reason: "autosave", blockCount: 1 },
    ]);
    for (const item of versions) expect(Object.keys(item).sort()).toEqual(["blockCount", "createdAt", "reason", "version"]);

    const one = await getVersion(request("GET", `/api/pages/${page.id}/versions/2`), page.id, "2", deps("user-a", store));
    expect(one.status).toBe(200);
    const { version } = (await one.json()) as { version: PageVersion };
    expect(version).toMatchObject({ version: 2, reason: "autosave", blocks: [paragraph("二版"), paragraph("二版の二")] });
    expect(Object.keys(version).sort()).toEqual(["blocks", "createdAt", "reason", "version"]);

    const empty = await store.createPage("user-a");
    expect(await (await listVersions(request("GET", `/api/pages/${empty.id}/versions`), empty.id, deps("user-a", store))).json()).toEqual({ versions: [] });
  });

  it("answers the page 404 to version numbers that are not positive integers or do not exist", async () => {
    const store = memoryStore();
    const page = await pageWithVersions(store);
    const missing = await snapshot(await getPage(request("GET", `/api/pages/${randomUUID()}`), randomUUID(), deps("user-a", store)));
    for (const param of ["0", "-1", "1.5", "01", "+1", "1e1", "abc", "", "3", "99999999999", "2147483648"]) {
      const read = await snapshot(await getVersion(request("GET", `/api/pages/${page.id}/versions/x`), page.id, param, deps("user-a", store)));
      expect(read, param).toEqual(missing);
      const restored = await snapshot(
        await restoreVersion(request("POST", `/api/pages/${page.id}/versions/x/restore`, { baseRevision: 3 }), page.id, param, deps("user-a", store)),
      );
      expect(restored, param).toEqual(missing);
    }
    expect(store.rows.get(page.id)?.revision).toBe(3);
  });

  it("restores a version, keeping the current body first, and answers 409 to a stale baseRevision", async () => {
    const store = memoryStore();
    const page = await pageWithVersions(store);
    const stale = await restoreVersion(request("POST", `/api/pages/${page.id}/versions/1/restore`, { baseRevision: 2 }), page.id, "1", deps("user-a", store));
    expect(stale.status).toBe(409);
    const conflict = (await stale.json()) as { error: string; page: Page };
    expect(conflict.error).toBe("conflict");
    expect(conflict.page).toMatchObject({ id: page.id, revision: 3, blocks: [paragraph("三版")] });
    expect(store.versions).toHaveLength(2);

    const restored = await restoreVersion(request("POST", `/api/pages/${page.id}/versions/1/restore`, { baseRevision: 3 }), page.id, "1", deps("user-a", store));
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as { page: Page }).page).toMatchObject({ revision: 4, blocks: [paragraph("一版")] });
    expect(store.versions.at(-1)).toMatchObject({ version: 3, reason: "restore", blocks: [paragraph("三版")] });
  });

  it("refuses to restore a stored version that does not pass today's AST check with 422 and writes nothing", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { blocks: [paragraph("今")] });
    store.versions.push(
      { pageId: page.id, version: 1, reason: "autosave", createdAt: new Date().toISOString(), blocks: [{ type: "script", content: [{ type: "text", text: "alert(1)" }] }] },
      { pageId: page.id, version: 2, reason: "autosave", createdAt: new Date().toISOString(), blocks: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "h1" }] }] },
      { pageId: page.id, version: 3, reason: "autosave", createdAt: new Date().toISOString(), blocks: [{ type: "paragraph", content: [{ type: "text", text: "表示用の属性", marks: [{ type: "link", attrs: { href: "https://niho.life/", target: "_blank" } }] }] }] },
    );
    for (const version of ["1", "2"]) {
      const response = await restoreVersion(request("POST", `/api/pages/${page.id}/versions/${version}/restore`, { baseRevision: 1 }), page.id, version, deps("user-a", store));
      expect(response.status, version).toBe(422);
      expect(await response.text()).toBe('{"error":"unrestorable"}');
    }
    expect(store.rows.get(page.id)).toMatchObject({ revision: 1, blocks: [paragraph("今")] });
    expect(store.versions).toHaveLength(3);

    // 通る版は、保存のときと同じく組み直した写しを書く
    const ok = await restoreVersion(request("POST", `/api/pages/${page.id}/versions/3/restore`, { baseRevision: 1 }), page.id, "3", deps("user-a", store));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { page: Page }).page.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "表示用の属性", marks: [{ type: "link", attrs: { href: "https://niho.life/" } }] }] },
    ]);
  });

  it("answers 400 to a restore body without a valid baseRevision", async () => {
    const store = memoryStore();
    const page = await pageWithVersions(store);
    for (const body of ["{", {}, { baseRevision: 0 }, { baseRevision: "3" }, { baseRevision: 3, blocks: [] }, { baseRevision: 3, overwrite: true }, []]) {
      const response = await restoreVersion(request("POST", `/api/pages/${page.id}/versions/1/restore`, body), page.id, "1", deps("user-a", store));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.text()).toBe('{"error":"bad_request"}');
    }
    expect(store.rows.get(page.id)?.revision).toBe(3);
  });
});

describe("trash", () => {
  it("deletes to the trash with 204, lists it in the trash only, and restores it with 204", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { title: "消す", blocks: [paragraph("本文")] });
    const response = await deletePage(request("DELETE", `/api/pages/${page.id}`), page.id, deps("user-a", store));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");

    const list = (await (await listPages(request("GET", "/api/pages"), deps("user-a", store))).json()) as { pages: PageSummary[] };
    expect(list.pages.map((item) => item.id)).not.toContain(page.id);
    expect((await getPage(request("GET", `/api/pages/${page.id}`), page.id, deps("user-a", store))).status).toBe(404);
    expect((await deletePage(request("DELETE", `/api/pages/${page.id}`), page.id, deps("user-a", store))).status).toBe(404);

    const trash = (await (await listTrash(request("GET", "/api/trash"), deps("user-a", store))).json()) as { pages: TrashedPage[] };
    expect(trash.pages).toHaveLength(1);
    expect(trash.pages[0]).toMatchObject({ id: page.id, kind: "note", title: "消す" });
    expect(Object.keys(trash.pages[0]!).sort()).toEqual(["deletedAt", "id", "kind", "title"]);
    expect(await (await listTrash(request("GET", "/api/trash"), deps("user-b", store))).json()).toEqual({ pages: [] });

    const restored = await restoreFromTrash(request("POST", `/api/trash/${page.id}/restore`), page.id, deps("user-a", store));
    expect(restored.status).toBe(204);
    expect((await getPage(request("GET", `/api/pages/${page.id}`), page.id, deps("user-a", store))).status).toBe(200);
    expect(await (await listTrash(request("GET", "/api/trash"), deps("user-a", store))).json()).toEqual({ pages: [] });
  });

  it("refuses to delete a published page with 409 published", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a", { title: "公開中" });
    store.published.add(page.id);
    const response = await deletePage(request("DELETE", `/api/pages/${page.id}`), page.id, deps("user-a", store));
    expect(response.status).toBe(409);
    expect(await response.text()).toBe('{"error":"published"}');
    expect(store.rows.get(page.id)?.deleted).toBe(false);
  });

  it("answers the same 404 to restoring a page that is not mine, unknown, malformed, or not in the trash", async () => {
    const store = memoryStore();
    const theirs = await store.createPage("user-b", { title: "theirs" });
    await store.deletePage("user-b", theirs.id);
    const alive = await store.createPage("user-a");
    const ids = [theirs.id, randomUUID(), "not-a-uuid", alive.id];
    const results = await Promise.all(ids.map(async (id) => snapshot(await restoreFromTrash(request("POST", "/api/trash/x/restore"), id, deps("user-a", store)))));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    expect(store.rows.get(theirs.id)?.deleted).toBe(true);
  });
});
