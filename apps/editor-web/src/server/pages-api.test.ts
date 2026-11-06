import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidPageCursorError,
  type Block,
  type CreatePageInput,
  type CreateTabInput,
  type DeleteResult,
  type MovePageResult,
  type MoveTabResult,
  type Page,
  type PageChunk,
  type PageChunkOptions,
  type PagePatch,
  type PageSummary,
  type PageVersion,
  type PageVersionSummary,
  type ResolvedPage,
  type RestoreOptions,
  type RestoreResult,
  type SaveOptions,
  type SaveResult,
  type TrashedPage,
  type VersionReason,
} from "@niho/editor-store";
import { stubAuthProvider } from "../auth/stub";
import { AuthTemporarilyUnavailable, type AuthProvider } from "../auth/types";
import { PAGE_BODY_MAX_BYTES } from "./http";
import { createPage, createTab, deletePage, discardPage, getPage, getTabs, listPages, movePage, patchPage, patchTab, reorderTabs, type PagesApiDeps, type PagesStore } from "./pages-api";
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
    /** EditorStore と同じ約束（親は本人の生きているフォルダだけ。違えば null。フォルダに本文・親は付けられない）。 */
    async createPage(owner: string, input: CreatePageInput = {}): Promise<Page> {
      const now = new Date().toISOString();
      const parent = input.parent ?? null;
      if (input.kind === "folder" && (parent !== null || (input.blocks?.length ?? 0) > 0)) throw new TypeError("editor-store: folder has no body");
      // 型は EditorStore の重ね書き（親なし＝Page）に合わせ、親があって入れられないときだけ null を返す
      if (parent !== null && visible(owner, parent)?.kind !== "folder") return null as unknown as Page;
      const page: Page = { id: randomUUID(), kind: input.kind ?? "note", title: input.title ?? "", lang: input.lang ?? "ja", blocks: input.blocks ?? [], cover: null, lead: null, parent, recipe: null, stepStatus: null, sortOrder: 0, revision: 1, page: null, role: null, madeFrom: null, lastTab: null, tabName: null, createdAt: now, updatedAt: now };
      rows.set(page.id, { ...page, owner, deleted: false, deletedAt: null });
      return page;
    },
    /** cursor は前の区切りの最後の id（知らない id は読めない cursor）。 */
    async listPageChunk(owner: string, options: PageChunkOptions = {}): Promise<PageChunk> {
      // 何を 1 行にするか（EditorStore の viewFilter と同じ）: tabs（既定）は入れ物を出さない、pages はタブを出さない、all は全部
      const inView = (row: Row) => (options.view === "all" ? true : options.view === "pages" ? row.page === null : row.kind !== "page");
      const sorted = [...rows.values()]
        .filter((row) => row.owner === owner && !row.deleted && inView(row))
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
      if (patch.kind !== undefined && patch.kind !== row.kind && (patch.kind === "folder" || row.kind === "folder")) throw new TypeError("editor-store: kind cannot change to or from folder");
      if (row.kind === "folder" && (patch.blocks?.length ?? 0) > 0) throw new TypeError("editor-store: folder has no body");
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
      if (parent !== null && (visible(owner, parent)?.kind !== "folder" || row.kind === "folder")) return "not_folder";
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
    /** EditorStore と同じ約束の簡略版（題名・本文が空なら消す。関わる行の判定は editor-store の DB のテストで確かめる）。 */
    async discardEmptyPage(owner: string, id: string): Promise<{ discarded: boolean } | null> {
      const row = visible(owner, id);
      if (!row) return null;
      if (row.title.trim() !== "" || row.blocks.length > 0) return { discarded: false };
      rows.delete(id);
      return { discarded: true };
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
    /** タブ（#307）: 入れ物は `kind='page'` の行、タブは `page` で入れ物を指す。EditorStore と同じ約束（自分の生きている行だけ）。 */
    async createTab(owner: string, id: string, input: CreateTabInput = {}): Promise<Page | null> {
      if (!UUID.test(id)) return null;
      const target = visible(owner, id);
      if (!target) return null;
      if (target.kind === "folder") throw new TypeError("editor-store: a folder has no tabs");
      const now = new Date().toISOString();
      let holder: Row | null = target.kind === "page" ? target : target.page ? visible(owner, target.page) : null;
      if (!holder) {
        // 入れ物の無い 1 枚だけのページ: その場で入れ物を作って結ぶ（EditorStore と同じ）
        holder = { ...target, id: randomUUID(), kind: "page", blocks: [], page: null, lastTab: target.id, createdAt: now, updatedAt: now };
        rows.set(holder.id, holder);
        target.page = holder.id;
      }
      // 題名はページの名前（入れ物と同じ）。名前は付けたときだけ（#308）
      const tab: Row = { ...holder, id: randomUUID(), kind: "note", title: holder.title, lang: input.lang ?? holder.lang, blocks: [], page: holder.id, lastTab: null, tabName: input.name ?? null, createdAt: now, updatedAt: now };
      rows.set(tab.id, tab);
      holder.lastTab = tab.id;
      return strip(tab);
    },
    async renameTab(owner: string, id: string, name: string | null): Promise<boolean | null> {
      const row = visible(owner, id);
      if (!row) return null;
      if (!row.page) return false;
      Object.assign(row, { tabName: name === null || name.trim() === "" ? null : name.trim() });
      return true;
    },
    async resolvePage(owner: string, id: string): Promise<ResolvedPage | null> {
      if (!UUID.test(id)) return null;
      const row = visible(owner, id);
      if (!row) return null;
      const tabsOf = (holder: string): PageSummary[] =>
        [...rows.values()]
          .filter((r) => r.owner === owner && !r.deleted && r.page === holder)
          .map(({ id, kind, title, lang, parent, stepStatus, sortOrder, page, role, tabName, createdAt, updatedAt }, index) => ({ id, kind, title, lang, parent, stepStatus, sortOrder, page, role, tabName, tabPos: index + 1, createdAt, updatedAt, publication: null }));
      if (row.kind === "page") {
        const tabs = tabsOf(row.id);
        const chosen = tabs.find((t) => t.id === row.lastTab) ?? tabs[0];
        const tab = chosen ? visible(owner, chosen.id) : null;
        return tab ? { page: strip(row), tab: strip(tab), tabs } : null;
      }
      const holder = row.page ? visible(owner, row.page) : null;
      if (holder && holder.kind === "page") return { page: strip(holder), tab: strip(row), tabs: tabsOf(holder.id) };
      return { page: null, tab: strip(row), tabs: [] };
    },
    async touchLastTab(owner: string, id: string): Promise<boolean> {
      const row = visible(owner, id);
      const holder = row?.page ? visible(owner, row.page) : null;
      if (!row || !holder) return false;
      Object.assign(rows.get(holder.id)!, { lastTab: row.id });
      return true;
    },
    async reorderTabs(owner: string, id: string, ids: readonly string[]): Promise<boolean | null> {
      const row = visible(owner, id);
      if (!row) return null;
      const holder = row.kind === "page" ? row : row.page ? visible(owner, row.page) : null;
      if (!holder) return false;
      const tabs = [...rows.values()].filter((r) => r.owner === owner && !r.deleted && r.page === holder.id).map((r) => r.id);
      if (tabs.length !== ids.length || !tabs.every((t) => ids.includes(t))) return false;
      ids.forEach((tabId, index) => Object.assign(rows.get(tabId)!, { sortOrder: index + 1 }));
      return true;
    },
    async moveTab(owner: string, id: string, to: string): Promise<MoveTabResult | null> {
      const row = visible(owner, id);
      if (!row) return null;
      if (!row.page || row.kind === "page" || row.kind === "folder") return "not_page";
      const target = visible(owner, to);
      if (!target) return null;
      const holder = target.kind === "page" ? target : target.page ? visible(owner, target.page) : null;
      if (!holder) return "not_page";
      Object.assign(rows.get(row.id)!, { page: holder.id, parent: holder.parent });
      return "moved";
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

  it("answers 413 above the page body limit and 400 to bodies that are not JSON, not the right shape, or without a valid baseRevision", async () => {
    const store = memoryStore();
    const page = await store.createPage("user-a");
    const big = JSON.stringify({ title: "x", baseRevision: 1, blocks: [{ type: "paragraph", content: [{ type: "text", text: "a".repeat(PAGE_BODY_MAX_BYTES) }] }] });
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
    // 何を 1 行にするか（#307 #308）: tabs（既定）・pages・all。ほかは 400
    for (const view of ["tabs", "pages", "all"]) expect((await listPages(request("GET", `/api/pages?view=${view}`), deps("user-a", store))).status, view).toBe(200);
    expect((await listPages(request("GET", "/api/pages?view=x"), deps("user-a", store))).status).toBe(400);
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

describe("POST /api/pages/{id}/discard", () => {
  const discard = (id: string, store: MemoryStore | null, userId: string | null = "user-a", headers?: Record<string, string>) =>
    discardPage(request("POST", `/api/pages/${id}/discard`, undefined, headers), id, deps(userId, store));

  it("deletes an empty page for good and keeps a page with something in it, both 200", async () => {
    const store = memoryStore();
    const empty = await store.createPage("user-a");
    const titled = await store.createPage("user-a", { title: "合成の題名" });
    const removed = await discard(empty.id, store);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ discarded: true });
    expect(store.rows.has(empty.id)).toBe(false);
    // ゴミ箱にも入らない
    expect(await store.listTrash("user-a")).toEqual([]);
    const kept = await discard(titled.id, store);
    expect(kept.status).toBe(200);
    expect(await kept.json()).toEqual({ discarded: false });
    expect(store.rows.has(titled.id)).toBe(true);
  });

  it("needs no body, so a keepalive request from pagehide works", async () => {
    const store = memoryStore();
    const empty = await store.createPage("user-a");
    const keepalive = new Request(`${ORIGIN}/api/pages/${empty.id}/discard`, { method: "POST", headers: { host: "editor.test", origin: ORIGIN }, keepalive: true });
    expect((await discardPage(keepalive, empty.id, deps("user-a", store))).status).toBe(200);
  });

  it("answers 401, 403 for another origin, 503 without the store, and the same 404 for someone else's, a missing and a malformed id", async () => {
    const store = memoryStore();
    const mine = await store.createPage("user-a");
    const spy = vi.spyOn(store, "discardEmptyPage");
    expect((await discard(mine.id, store, null)).status).toBe(401);
    expect((await discard(mine.id, store, "user-a", { origin: "https://elsewhere.example" })).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    expect((await discard(mine.id, null)).status).toBe(503);
    const notFound = await snapshot(await discard(mine.id, store, "user-b"));
    expect(notFound.status).toBe(404);
    expect(await snapshot(await discard(randomUUID(), store))).toEqual(notFound);
    expect(await snapshot(await discard("not-a-uuid", store))).toEqual(notFound);
    expect(store.rows.has(mine.id)).toBe(true);
  });
});

describe("/api/pages/{id}/parent", () => {
  const move = (id: string, parent: string | null, store: MemoryStore | null, userId: string | null = "user-a", headers?: Record<string, string>) =>
    movePage(request("PATCH", `/api/pages/${id}/parent`, { parent }, headers), id, deps(userId, store));

  it("puts a page into a folder and takes it out again, changing nothing but the parent", async () => {
    const store = memoryStore();
    const folder = await store.createPage("user-a", { kind: "folder", title: "鎌倉の記事" });
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
    const folder = await store.createPage("user-a", { kind: "folder", title: "フォルダ" });
    const note = await store.createPage("user-a", { kind: "rec", title: "ページ" });
    const sub = await store.createPage("user-a", { kind: "step", title: "サブページ" });
    const deeper = await store.createPage("user-a", { title: "その下" });
    expect((await move(note.id, folder.id, store)).status).toBe(200);
    // 工程のサブページは step_runs が録音を親に作る（movePage を通らない）
    store.rows.get(sub.id)!.parent = note.id;

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

  it("answers 409 not_folder when the new parent is not a folder, or a folder goes into a folder, and writes nothing", async () => {
    const store = memoryStore();
    const folder = await store.createPage("user-a", { kind: "folder", title: "フォルダ" });
    const other = await store.createPage("user-a", { kind: "folder", title: "別のフォルダ" });
    const note = await store.createPage("user-a", { title: "ページ" });
    const rec = await store.createPage("user-a", { kind: "rec", title: "録音" });
    for (const [id, parent] of [[note.id, rec.id], [rec.id, note.id], [other.id, folder.id]] as const) {
      const response = await move(id, parent, store);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "not_folder" });
      expect(store.rows.get(id)?.parent).toBe(null);
    }
  });
});

describe("POST /api/pages with a folder", () => {
  it("creates an empty folder, and a page inside a folder with { kind, parent }", async () => {
    const store = memoryStore();
    const made = await createPage(request("POST", "/api/pages", { kind: "folder", title: "合成のフォルダ" }), deps("user-a", store));
    expect(made.status).toBe(201);
    const { page: folder } = (await made.json()) as { page: Page };
    expect(folder).toMatchObject({ kind: "folder", blocks: [], parent: null });

    const inside = await createPage(request("POST", "/api/pages", { kind: "rec", parent: folder.id }), deps("user-a", store));
    expect(inside.status).toBe(201);
    expect(((await inside.json()) as { page: Page }).page).toMatchObject({ kind: "rec", parent: folder.id });
  });

  it("answers 400 for a folder with a body or a parent, and the same 404 when the parent is not the person's living folder", async () => {
    const store = memoryStore();
    const folder = await store.createPage("user-a", { kind: "folder", title: "フォルダ" });
    const note = await store.createPage("user-a", { title: "ページ" });
    const theirs = await store.createPage("user-b", { kind: "folder", title: "別の人のフォルダ" });
    const trashed = await store.createPage("user-a", { kind: "folder", title: "ゴミ箱のフォルダ" });
    await store.deletePage("user-a", trashed.id);
    expect((await createPage(request("POST", "/api/pages", { kind: "folder", blocks: [paragraph("本文")] }), deps("user-a", store))).status).toBe(400);
    expect((await createPage(request("POST", "/api/pages", { kind: "folder", parent: folder.id }), deps("user-a", store))).status).toBe(400);
    expect((await createPage(request("POST", "/api/pages", { parent: "not-a-uuid" }), deps("user-a", store))).status).toBe(400);
    const expected = await snapshot(await createPage(request("POST", "/api/pages", { parent: randomUUID() }), deps("user-a", store)));
    expect(expected.status).toBe(404);
    for (const parent of [note.id, theirs.id, trashed.id]) {
      expect(await snapshot(await createPage(request("POST", "/api/pages", { parent }), deps("user-a", store)))).toEqual(expected);
    }
  });

  it("refuses to save a body into a folder or change a kind to or from folder with 400 (reason folder)", async () => {
    const store = memoryStore();
    const folder = await store.createPage("user-a", { kind: "folder", title: "フォルダ" });
    const note = await store.createPage("user-a", { title: "ページ" });
    const save = (id: string, body: unknown) => patchPage(request("PATCH", `/api/pages/${id}`, body), id, deps("user-a", store));
    for (const [id, body] of [[folder.id, { baseRevision: 1, blocks: [paragraph("本文")] }], [folder.id, { baseRevision: 1, kind: "note" }], [note.id, { baseRevision: 1, kind: "folder" }]] as const) {
      const response = await save(id, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request", reason: "folder" });
    }
    // 題名だけは直せる
    expect((await save(folder.id, { baseRevision: 1, title: "新しい名前" })).status).toBe(200);
    expect(store.rows.get(folder.id)).toMatchObject({ title: "新しい名前", blocks: [] });
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

describe("/api/pages/{id}/tabs and /tab (#307)", () => {
  const make = async (store: MemoryStore, body: unknown, user = "user-a") =>
    ((await (await createPage(request("POST", "/api/pages", body), deps(user, store))).json()) as { page: Page }).page;

  it("adds a blank tab to the page's holder, lists the tabs, remembers the last opened tab, reorders and moves tabs", async () => {
    const store = memoryStore();
    const first = await make(store, { title: "記事本文" });
    const added = await createTab(request("POST", `/api/pages/${first.id}/tabs`, { name: " 英語版 " }), first.id, deps("user-a", store));
    expect(added.status).toBe(201);
    const { page: tab } = (await added.json()) as { page: Page };
    // 題名はページの名前（入れ物と同じ）。名前は前後の空白を除く（#308）
    expect(tab).toMatchObject({ kind: "note", title: "記事本文", blocks: [], tabName: "英語版" });
    expect(tab.page).toBeTruthy();

    const listed = await getTabs(request("GET", `/api/pages/${first.id}/tabs`), first.id, deps("user-a", store));
    expect(listed.status).toBe(200);
    const resolved = (await listed.json()) as ResolvedPage;
    expect(resolved.page?.id).toBe(tab.page);
    expect(resolved.tabs.map((t) => [t.id, t.tabName, t.tabPos])).toEqual([[first.id, null, 1], [tab.id, "英語版", 2]]);

    // 名前を変える・外す（`{ name }`。空は外す）。入れ物・入れ物の無いページには付かない（409 not_page）
    expect((await patchTab(request("PATCH", `/api/pages/${first.id}/tab`, { name: "下書き" }), first.id, deps("user-a", store))).status).toBe(200);
    expect(store.rows.get(first.id)?.tabName).toBe("下書き");
    expect((await patchTab(request("PATCH", `/api/pages/${first.id}/tab`, { name: "" }), first.id, deps("user-a", store))).status).toBe(200);
    expect(store.rows.get(first.id)?.tabName).toBeNull();
    expect((await patchTab(request("PATCH", `/api/pages/${tab.page}/tab`, { name: "x" }), tab.page!, deps("user-a", store))).status).toBe(409);
    expect((await patchTab(request("PATCH", `/api/pages/${first.id}/tab`, { name: "あ".repeat(101) }), first.id, deps("user-a", store))).status).toBe(400);
    expect((await patchTab(request("PATCH", `/api/pages/${first.id}/tab`, {}), first.id, deps("user-a", store))).status).toBe(400);
    expect((await patchTab(request("PATCH", `/api/pages/${first.id}/tab`, { name: "x" }), first.id, deps("user-b", store))).status).toBe(404);
    // 入れ物の id で聞くと最後に開いたタブ（足したタブ）
    const byHolder = await getTabs(request("GET", `/api/pages/${tab.page}/tabs`), tab.page!, deps("user-a", store));
    expect(((await byHolder.json()) as ResolvedPage).tab.id).toBe(tab.id);

    // 並び: 入れ物の生きているタブ全部を望む順に。足りなければ 409 order
    expect((await reorderTabs(request("PATCH", `/api/pages/${first.id}/tabs`, { ids: [tab.id, first.id] }), first.id, deps("user-a", store))).status).toBe(200);
    expect((await reorderTabs(request("PATCH", `/api/pages/${first.id}/tabs`, { ids: [first.id] }), first.id, deps("user-a", store))).status).toBe(409);
    expect((await reorderTabs(request("PATCH", `/api/pages/${first.id}/tabs`, { ids: [] }), first.id, deps("user-a", store))).status).toBe(400);

    // 別の入れ物へ移す。入れ物でない・タブでないものは 409 not_page
    const other = await make(store, { title: "別" });
    await createTab(request("POST", `/api/pages/${other.id}/tabs`, {}), other.id, deps("user-a", store));
    const moved = await patchTab(request("PATCH", `/api/pages/${tab.id}/tab`, { page: other.id }), tab.id, deps("user-a", store));
    expect(moved.status).toBe(200);
    const lone = await make(store, { title: "入れ物なし" });
    expect((await patchTab(request("PATCH", `/api/pages/${lone.id}/tab`, { page: first.id }), lone.id, deps("user-a", store))).status).toBe(409);
    expect((await patchTab(request("PATCH", `/api/pages/${tab.id}/tab`, { page: "x" }), tab.id, deps("user-a", store))).status).toBe(400);
  });

  it("answers 400 to unknown keys, a folder or kind 'page', 403 across origins, and the same 404 to others' pages", async () => {
    const store = memoryStore();
    const page = await make(store, {});
    expect((await createTab(request("POST", `/api/pages/${page.id}/tabs`, { blocks: [] }), page.id, deps("user-a", store))).status).toBe(400);
    expect((await createTab(request("POST", `/api/pages/${page.id}/tabs`, { title: "2" }), page.id, deps("user-a", store))).status).toBe(400);
    const folder = await make(store, { kind: "folder" });
    expect((await createTab(request("POST", `/api/pages/${folder.id}/tabs`, {}), folder.id, deps("user-a", store))).status).toBe(400);
    expect((await createTab(request("POST", `/api/pages/${page.id}/tabs`, {}, { origin: "http://evil.test" }), page.id, deps("user-a", store))).status).toBe(403);
    expect((await createTab(request("POST", `/api/pages/${page.id}/tabs`, {}), page.id, deps("user-b", store))).status).toBe(404);
    expect((await getTabs(request("GET", `/api/pages/${page.id}/tabs`), page.id, deps("user-b", store))).status).toBe(404);
    expect((await getTabs(request("GET", "/api/pages/not-a-uuid/tabs"), "not-a-uuid", deps("user-a", store))).status).toBe(404);
    expect((await createPage(request("POST", "/api/pages", { kind: "page" }), deps("user-a", store))).status).toBe(400);
  });
});
