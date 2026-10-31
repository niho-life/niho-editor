import { randomUUID } from "node:crypto";
import { EMPTY_PAGE_FIELDS, type Block, type Page, type PageFields, type PageFieldsPatch, type PageSummary } from "@niho/editor-store";
import { describe, expect, it, vi } from "vitest";
import { stubAuthProvider } from "../auth/stub";
import type { AuthProvider } from "../auth/types";
import type { FolderExportPhoto } from "../export/folder";
import { exportFolder, getPageFields, listPageChildren, movePageOrder, parseOrderMove, patchPageFields, recordPageOpen, type FolderApiDeps } from "./folder-api";

/**
 * フォルダまわりの API（並び・子の一覧・欄・「最近」・書き出し。#37）。DB の決まりは editor-store の
 * test/order-fields-opens.integration.test.ts が持ち、ここは route の約束（401/403/404/400・本文の形）を見る。値はすべて合成。
 */

const ORIGIN = "http://editor.test";
const OWNER = "synthetic-owner-a";
const FOLDER = "00000000-0000-4000-8000-00000000000a";
const INSIDE = "00000000-0000-4000-8000-00000000000b";
const ASSET = "11111111-1111-4111-8111-111111111111";

function authAs(userId: string | null): AuthProvider {
  return { ...stubAuthProvider, getSession: async () => (userId ? { userId, mode: "stub" } : null) };
}

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

function pageOf(id: string, title: string, blocks: Block[] = [paragraph("合成の本文")]): Page {
  const at = "2026-11-01T00:00:00.000Z";
  return { id, kind: "note", title, lang: "ja", blocks, cover: null, lead: null, parent: null, recipe: null, stepStatus: null, sortOrder: 0, revision: 1, createdAt: at, updatedAt: at };
}

const summaryOf = (page: Page): PageSummary => ({
  id: page.id,
  kind: page.kind,
  title: page.title,
  lang: page.lang,
  parent: page.parent,
  stepStatus: page.stepStatus,
  sortOrder: page.sortOrder,
  createdAt: page.createdAt,
  updatedAt: page.updatedAt,
  publication: null,
});

/** 覚えておくだけの store（EditorStore と同じ約束: 本人のページでなければ null / 空）。 */
function memoryDeps(options: { userId?: string | null; rows?: Page[]; fields?: PageFields; photos?: Map<string, FolderExportPhoto> | null; db?: boolean } = {}) {
  const rows = options.rows ?? [pageOf(FOLDER, "鎌倉の記事", [paragraph("取材の背景")]), { ...pageOf(INSIDE, "取材メモ"), parent: FOLDER }];
  const fields = { value: options.fields ?? EMPTY_PAGE_FIELDS };
  const opens: string[] = [];
  const orders: { id: string; move: string }[] = [];
  const db = options.db !== false;
  const deps: FolderApiDeps = {
    auth: () => authAs(options.userId === undefined ? OWNER : options.userId),
    store: () =>
      db
        ? {
            getPage: async (owner, id) => (owner === OWNER ? (rows.find((row) => row.id === id) ?? null) : null),
            movePageOrder: async (owner, id, move) => {
              if (owner !== OWNER || !rows.some((row) => row.id === id)) return null;
              orders.push({ id, move });
              return id === FOLDER ? "edge" : "moved";
            },
            listPageChildren: async (owner, parent) => (owner === OWNER ? rows.filter((row) => row.parent === parent).map(summaryOf) : []),
            listPageTree: async (owner, rootId) => {
              if (owner !== OWNER) return [];
              const root = rows.find((row) => row.id === rootId);
              return root ? [root, ...rows.filter((row) => row.parent === rootId)] : [];
            },
          }
        : null,
    fields: () =>
      db
        ? {
            get: async () => fields.value,
            save: async (_owner, _pageId, patch: PageFieldsPatch) => {
              fields.value = { ...fields.value, ...patch };
              return fields.value;
            },
          }
        : null,
    opens: () =>
      db
        ? async (owner, pageId) => {
            if (owner !== OWNER || !rows.some((row) => row.id === pageId)) return false;
            opens.push(pageId);
            return true;
          }
        : null,
    photos: () => (options.photos === null ? null : { read: async (_owner, assetId) => options.photos?.get(assetId) ?? null }),
    env: {},
  };
  return { deps, opens, orders, fields };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method, headers: { host: "editor.test", ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }), ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

describe("parseOrderMove", () => {
  it("takes up and down only", () => {
    expect(parseOrderMove({ move: "up" })).toEqual({ ok: true, move: "up" });
    expect(parseOrderMove({ move: "down" })).toEqual({ ok: true, move: "down" });
    for (const body of [{}, { move: "sideways" }, { move: 1 }, { move: "up", extra: 1 }, null, [], "up"]) {
      expect(parseOrderMove(body).ok, JSON.stringify(body)).toBe(false);
    }
  });
});

describe("PATCH /api/pages/{id}/order", () => {
  const move = (id: string, body: unknown, deps: FolderApiDeps, headers?: Record<string, string>) => movePageOrder(request("PATCH", `/api/pages/${id}/order`, body, headers), id, deps);

  it("moves one step and says so, and says moved:false at the end of the list", async () => {
    const { deps, orders } = memoryDeps();
    const response = await move(INSIDE, { move: "up" }, deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ moved: true });
    expect(orders).toEqual([{ id: INSIDE, move: "up" }]);

    const edge = await move(FOLDER, { move: "up" }, deps);
    expect(edge.status).toBe(200);
    expect(await edge.json()).toEqual({ moved: false });
  });

  it("answers 401 without a session, 403 from another origin, 503 without a database and 400 for a body the screen could not send", async () => {
    expect((await move(INSIDE, { move: "up" }, memoryDeps({ userId: null }).deps)).status).toBe(401);
    expect((await move(INSIDE, { move: "up" }, memoryDeps().deps, { origin: "http://evil.test" })).status).toBe(403);
    expect((await move(INSIDE, { move: "up" }, memoryDeps({ db: false }).deps)).status).toBe(503);
    expect((await move(INSIDE, { move: "sideways" }, memoryDeps().deps)).status).toBe(400);
  });

  it("answers the same 404 for a page that is not the person's own", async () => {
    const { deps, orders } = memoryDeps();
    expect((await move(randomUUID(), { move: "up" }, deps)).status).toBe(404);
    expect((await move(INSIDE, { move: "up" }, memoryDeps({ userId: "synthetic-owner-b" }).deps)).status).toBe(404);
    expect(orders).toEqual([]);
  });
});

describe("GET /api/pages/{id}/children", () => {
  it("answers the rows inside the page (what the 参考ページ and the 書き出し read)", async () => {
    const { deps } = memoryDeps();
    const response = await listPageChildren(request("GET", `/api/pages/${FOLDER}/children`), FOLDER, deps);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { pages: PageSummary[] };
    expect(body.pages.map((page) => [page.id, page.title])).toEqual([[INSIDE, "取材メモ"]]);
  });

  it("answers 401 without a session, 503 without a database and the same 404 for another person's page", async () => {
    expect((await listPageChildren(request("GET", "/x"), FOLDER, memoryDeps({ userId: null }).deps)).status).toBe(401);
    expect((await listPageChildren(request("GET", "/x"), FOLDER, memoryDeps({ db: false }).deps)).status).toBe(503);
    expect((await listPageChildren(request("GET", "/x"), FOLDER, memoryDeps({ userId: "synthetic-owner-b" }).deps)).status).toBe(404);
    expect((await listPageChildren(request("GET", "/x"), randomUUID(), memoryDeps().deps)).status).toBe(404);
  });
});

describe("GET・PATCH /api/pages/{id}/fields", () => {
  it("reads the empty 欄 and saves what was passed", async () => {
    const { deps, fields } = memoryDeps();
    const read = await getPageFields(request("GET", "/x"), FOLDER, deps);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ fields: { entities: [], terms: [] } });

    const saved = await patchPageFields(request("PATCH", "/x", { entities: [{ name: "田中", reading: "たなか", role: "店主", note: "" }] }), FOLDER, deps);
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { fields: PageFields }).fields.entities).toHaveLength(1);
    expect(fields.value.entities).toHaveLength(1);
  });

  it("refuses a body the screen could not send with 400, writing nothing", async () => {
    const { deps, fields } = memoryDeps();
    for (const body of [{ background: "" }, { entities: [{ name: "" }] }, { terms: [{ term: "", reading: "", variants: [], note: "" }] }, { entities: "no" }]) {
      const response = await patchPageFields(request("PATCH", "/x", body), FOLDER, deps);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(fields.value).toEqual({ entities: [], terms: [] });
  });

  it("answers 401・403・503 and the same 404 for another person's page", async () => {
    expect((await getPageFields(request("GET", "/x"), FOLDER, memoryDeps({ userId: null }).deps)).status).toBe(401);
    expect((await patchPageFields(request("PATCH", "/x", { terms: [] }, { origin: "http://evil.test" }), FOLDER, memoryDeps().deps)).status).toBe(403);
    expect((await getPageFields(request("GET", "/x"), FOLDER, memoryDeps({ db: false }).deps)).status).toBe(503);
    expect((await patchPageFields(request("PATCH", "/x", { terms: [] }), randomUUID(), memoryDeps().deps)).status).toBe(404);
  });
});

describe("POST /api/pages/{id}/open", () => {
  it("records the open and answers 204, and the same 404 for a page that is not the person's own", async () => {
    const { deps, opens } = memoryDeps();
    const response = await recordPageOpen(request("POST", "/x", undefined), INSIDE, deps);
    expect(response.status).toBe(204);
    expect(opens).toEqual([INSIDE]);
    expect((await recordPageOpen(request("POST", "/x"), randomUUID(), deps)).status).toBe(404);
    expect((await recordPageOpen(request("POST", "/x"), INSIDE, memoryDeps({ userId: null }).deps)).status).toBe(401);
    expect((await recordPageOpen(request("POST", "/x", undefined, { origin: "http://evil.test" }), INSIDE, memoryDeps().deps)).status).toBe(403);
    expect((await recordPageOpen(request("POST", "/x"), INSIDE, memoryDeps({ db: false }).deps)).status).toBe(503);
  });
});

describe("GET /api/pages/{id}/export.zip", () => {
  const photo: FolderExportPhoto = { sha256: "a".repeat(64), contentType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) };

  it("answers a zip named after the folder", async () => {
    const { deps } = memoryDeps();
    const response = await exportFolder(request("GET", "/x"), FOLDER, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=\"page.zip\"; filename*=UTF-8''%E9%8E%8C%E5%80%89%E3%81%AE%E8%A8%98%E4%BA%8B.zip");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
  });

  it("reads each photo in the bodies once, and never a photo that is not in them", async () => {
    const photos = new Map([[ASSET, photo]]);
    const rows = [pageOf(FOLDER, "フォルダ", []), { ...pageOf(INSIDE, "写真", [{ type: "image", attrs: { assetId: ASSET, alt: "店", credit: null } }, { type: "image", attrs: { assetId: ASSET } }]), parent: FOLDER }];
    const { deps } = memoryDeps({ rows, photos });
    const read = vi.fn(async (_owner: string, assetId: string) => photos.get(assetId) ?? null);
    const response = await exportFolder(request("GET", "/x"), FOLDER, { ...deps, photos: () => ({ read }) });
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("answers 401 without a session, 503 without a database and the same 404 for another person's page", async () => {
    expect((await exportFolder(request("GET", "/x"), FOLDER, memoryDeps({ userId: null }).deps)).status).toBe(401);
    expect((await exportFolder(request("GET", "/x"), FOLDER, memoryDeps({ db: false }).deps)).status).toBe(503);
    expect((await exportFolder(request("GET", "/x"), FOLDER, memoryDeps({ userId: "synthetic-owner-b" }).deps)).status).toBe(404);
    expect((await exportFolder(request("GET", "/x"), randomUUID(), memoryDeps().deps)).status).toBe(404);
  });

  it("answers 413 when the folder is over the limits and 400 when there is nothing to write", async () => {
    const many = Array.from({ length: 101 }, (_, index) => ({ ...pageOf(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, `p${index}`), parent: FOLDER }));
    const over = memoryDeps({ rows: [pageOf(FOLDER, "フォルダ", []), ...many] });
    expect((await exportFolder(request("GET", "/x"), FOLDER, over.deps)).status).toBe(413);

    const nothing = memoryDeps({ rows: [pageOf(FOLDER, "フォルダ", [])] });
    expect((await exportFolder(request("GET", "/x"), FOLDER, nothing.deps)).status).toBe(400);
  });
});
