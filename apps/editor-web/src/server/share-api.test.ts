import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DocsPageShareState } from "@niho/docs-core";
import { duplicateTitle, type Block, type DuplicatedPage, type PageShareState } from "@niho/editor-store";
import type { AuthProvider } from "../auth/types";
import {
  duplicatePageRoute,
  enableShareRoute,
  exportContentDisposition,
  exportFileBaseName,
  exportMarkdownRoute,
  getShareRoute,
  readShareFlag,
  rotateShareRoute,
  sharePublicId,
  stopShareRoute,
  type PageActionsStore,
  type ShareApiDeps,
} from "./share-api";

const ORIGIN = "http://editor.test";

type Row = { id: string; owner: string; title: string; blocks: Block[]; kind?: string; deleted: boolean; token: string | null; createdAt: string; rotatedAt: string | null };

/** owner ごとに分けた、メモリの中だけの合成の store（packages/editor-store と同じ約束: 自分の・ゴミ箱でない行だけ、無ければ null）。 */
function memoryStore(rows: Row[]) {
  const calls: string[] = [];
  const find = (owner: string, id: string) => rows.find((row) => row.id === id && row.owner === owner && !row.deleted) ?? null;
  const state = (row: Row): PageShareState =>
    row.token ? { shared: true, token: row.token, createdAt: row.createdAt, rotatedAt: row.rotatedAt } : { shared: false };
  const newToken = () => randomBytes(32).toString("base64url");
  const store: PageActionsStore = {
    getShare: async (owner, id) => {
      calls.push(`get:${owner}`);
      const row = find(owner, id);
      return row ? state(row) : null;
    },
    enableShare: async (owner, id) => {
      calls.push(`enable:${owner}`);
      const row = find(owner, id);
      if (!row) return null;
      row.token ??= newToken();
      return state(row);
    },
    rotateShare: async (owner, id) => {
      calls.push(`rotate:${owner}`);
      const row = find(owner, id);
      if (!row) return null;
      if (row.token) row.rotatedAt = new Date(Date.parse(row.createdAt) + 1000).toISOString();
      row.token = newToken();
      return state(row);
    },
    stopShare: async (owner, id) => {
      calls.push(`stop:${owner}`);
      const row = find(owner, id);
      if (!row) return null;
      row.token = null;
      row.rotatedAt = null;
      return { shared: false };
    },
    duplicatePage: async (owner, id) => {
      calls.push(`duplicate:${owner}`);
      const row = find(owner, id);
      if (!row) return null;
      const copy: Row = { ...row, id: randomUUID(), title: duplicateTitle(row.title), token: null, rotatedAt: null };
      rows.push(copy);
      const page: DuplicatedPage = {
        id: copy.id, kind: "note", title: copy.title, lang: "ja", blocks: copy.blocks, cover: null, lead: null, parent: null, recipe: null, stepStatus: null, page: null,
        createdAt: copy.createdAt, updatedAt: copy.createdAt,
      };
      return page;
    },
    getPage: async (owner, id) => {
      calls.push(`page:${owner}`);
      const row = find(owner, id);
      return row ? { title: row.title, blocks: row.blocks, ...(row.kind ? { kind: row.kind } : {}) } : null;
    },
  };
  return { store, calls };
}

function row(owner: string, extra: Partial<Row> = {}): Row {
  return { id: randomUUID(), owner, title: "合成の題名", blocks: [{ type: "paragraph", content: [{ type: "text", text: "合成の本文" }] }], deleted: false, token: null, createdAt: new Date(0).toISOString(), rotatedAt: null, ...extra };
}

/** 共有・複製・書き出しの API が呼ぶのは getSession だけ。ログインの経路（AuthProvider の残り）は使わない。 */
const notUsed = async (): Promise<Response> => {
  throw new Error("the page action APIs never call the login routes");
};

function authAs(userId: string | null): AuthProvider {
  return {
    mode: "stub",
    getSession: async () => (userId ? { userId, mode: "stub" } : null),
    beginLogin: notUsed,
    completeLogin: notUsed,
    logout: notUsed,
  };
}

function deps(userId: string | null, store: PageActionsStore | null, env: Record<string, string | undefined> = {}): ShareApiDeps {
  return { auth: () => authAs(userId), store: () => store, env };
}

function request(method: string, path: string, headers: Record<string, string> = {}): Request {
  const sameOrigin: Record<string, string> = method === "GET" ? {} : { origin: ORIGIN };
  return new Request(`${ORIGIN}${path}`, { method, headers: { host: "editor.test", ...sameOrigin, ...headers } });
}

type Handler = (request: Request, id: string, deps: ShareApiDeps) => Promise<Response>;
const ROUTES: Array<[string, string, string, Handler]> = [
  ["GET share", "GET", "/share", getShareRoute],
  ["PUT share", "PUT", "/share", enableShareRoute],
  ["POST share/rotate", "POST", "/share/rotate", rotateShareRoute],
  ["DELETE share", "DELETE", "/share", stopShareRoute],
  ["POST duplicate", "POST", "/duplicate", duplicatePageRoute],
  ["GET export.md", "GET", "/export.md", exportMarkdownRoute],
];
const call = (handler: Handler, method: string, suffix: string, id: string, d: ShareApiDeps, headers: Record<string, string> = {}) =>
  handler(request(method, `/api/pages/${id}${suffix}`, headers), id, d);

async function snapshot(response: Response) {
  return { status: response.status, headers: [...response.headers.entries()].sort(), body: await response.text() };
}

async function shareOf(response: Response): Promise<DocsPageShareState> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { share: DocsPageShareState };
  expect(Object.keys(body)).toEqual(["share"]);
  expect(Object.keys(body.share).sort()).toEqual(["publicId", "status", "updatedAt", "url"]);
  return body.share;
}

const tokenOf = (share: DocsPageShareState) => share.url!.slice(`${ORIGIN}/s/`.length);

describe("share API", () => {
  it("starts sharing idempotently and answers the DocsPageShareState with the /s/{token} URL", async () => {
    const mine = row("user-a");
    const { store } = memoryStore([mine]);
    const d = deps("user-a", store);

    expect(await shareOf(await call(getShareRoute, "GET", "/share", mine.id, d))).toEqual({ status: "PRIVATE", publicId: null, url: null, updatedAt: null });
    const first = await shareOf(await call(enableShareRoute, "PUT", "/share", mine.id, d));
    expect(first.status).toBe("PUBLIC");
    expect(first.url).toMatch(/^http:\/\/editor\.test\/s\/[A-Za-z0-9_-]{43}$/);
    expect(first.updatedAt).toBe(mine.createdAt);
    expect(first.publicId).toBe(sharePublicId(tokenOf(first)));
    expect(first.publicId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(tokenOf(first)).not.toContain(first.publicId!);
    expect(await shareOf(await call(enableShareRoute, "PUT", "/share", mine.id, d))).toEqual(first);
    expect(await shareOf(await call(getShareRoute, "GET", "/share", mine.id, d))).toEqual(first);
  });

  it("rotates to a new link and stops sharing", async () => {
    const mine = row("user-a");
    const { store } = memoryStore([mine]);
    const d = deps("user-a", store);
    const first = await shareOf(await call(enableShareRoute, "PUT", "/share", mine.id, d));
    const rotated = await shareOf(await call(rotateShareRoute, "POST", "/share/rotate", mine.id, d));
    expect(rotated.status).toBe("PUBLIC");
    expect(rotated.url).not.toBe(first.url);
    expect(rotated.publicId).not.toBe(first.publicId);
    expect(rotated.updatedAt).toBe(mine.rotatedAt);
    expect(await shareOf(await call(stopShareRoute, "DELETE", "/share", mine.id, d))).toEqual({ status: "PRIVATE", publicId: null, url: null, updatedAt: null });
    expect(await shareOf(await call(stopShareRoute, "DELETE", "/share", mine.id, d))).toEqual({ status: "PRIVATE", publicId: null, url: null, updatedAt: null });
  });

  it("builds the URL from EDITOR_ORIGIN or the forwarded host, and leaves it null when the origin cannot be told", async () => {
    const mine = row("user-a", { token: "A".repeat(43) });
    const { store } = memoryStore([mine]);
    const configured = await shareOf(
      await getShareRoute(request("GET", `/api/pages/${mine.id}/share`), mine.id, deps("user-a", store, { EDITOR_ORIGIN: "https://editor.niho.life/ignored" })),
    );
    expect(configured.url).toBe(`https://editor.niho.life/s/${"A".repeat(43)}`);
    const forwarded = await shareOf(
      await getShareRoute(request("GET", `/api/pages/${mine.id}/share`, { "x-forwarded-host": "editor.example", "x-forwarded-proto": "https" }), mine.id, deps("user-a", store)),
    );
    expect(forwarded.url).toBe(`https://editor.example/s/${"A".repeat(43)}`);
    const unknown = await shareOf(await getShareRoute(request("GET", `/api/pages/${mine.id}/share`), mine.id, deps("user-a", store, { EDITOR_ORIGIN: "not a url" })));
    expect(unknown).toMatchObject({ status: "PUBLIC", url: null });
    expect(unknown.publicId).toBe(sharePublicId("A".repeat(43)));
  });

  it("answers 401 without a session and 503 without a database on every route, before touching the store", async () => {
    const mine = row("user-a");
    const { store, calls } = memoryStore([mine]);
    for (const [label, method, suffix, handler] of ROUTES) {
      const unauthorized = await call(handler, method, suffix, mine.id, deps(null, store));
      expect(unauthorized.status, label).toBe(401);
      expect(await unauthorized.text()).toBe('{"error":"unauthorized"}');
      const unavailable = await call(handler, method, suffix, mine.id, deps("user-a", null));
      expect(unavailable.status, label).toBe(503);
      expect(await unavailable.text()).toBe('{"error":"unavailable"}');
    }
    expect(calls).toEqual([]);
  });

  it("refuses writes from another origin or without an Origin, but serves reads without one", async () => {
    const mine = row("user-a");
    const { store, calls } = memoryStore([mine]);
    for (const [label, method, suffix, handler] of ROUTES.filter(([, method]) => method !== "GET")) {
      for (const origin of ["https://evil.example", "null"]) {
        const response = await call(handler, method, suffix, mine.id, deps("user-a", store), { origin });
        expect(response.status, `${label} from ${origin}`).toBe(403);
        expect(await response.text()).toBe('{"error":"forbidden"}');
      }
      const noOrigin = await handler(new Request(`${ORIGIN}/api/pages/${mine.id}${suffix}`, { method, headers: { host: "editor.test" } }), mine.id, deps("user-a", store));
      expect(noOrigin.status, label).toBe(403);
    }
    expect(calls).toEqual([]);
    expect(mine.token).toBeNull();
    expect((await call(getShareRoute, "GET", "/share", mine.id, deps("user-a", store), { origin: "https://evil.example" })).status).toBe(200);
  });

  it("answers the same 404 (body and headers) for another owner's page, an unknown id, a malformed id, and a page in the trash", async () => {
    const theirs = row("user-b", { token: "B".repeat(43) });
    const removed = row("user-a", { deleted: true, token: "C".repeat(43) });
    const { store } = memoryStore([theirs, removed]);
    const d = deps("user-a", store);
    for (const [label, method, suffix, handler] of ROUTES) {
      const results = [];
      for (const id of [theirs.id, randomUUID(), "not-a-uuid", removed.id]) results.push(await snapshot(await call(handler, method, suffix, id, d)));
      expect(results[0]!.status, label).toBe(404);
      expect(results[0]!.body, label).toBe('{"error":"not_found"}');
      for (const result of results.slice(1)) expect(result, label).toEqual(results[0]);
    }
    expect(theirs.token).toBe("B".repeat(43));
    expect(removed.token).toBe("C".repeat(43));
  });

  it("duplicates the signed-in owner's page with 201", async () => {
    const mine = row("user-a", { title: "元の題名" });
    const theirs = row("user-b");
    const { store, calls } = memoryStore([mine, theirs]);
    const response = await call(duplicatePageRoute, "POST", "/duplicate", mine.id, deps("user-a", store));
    expect(response.status).toBe(201);
    const { page } = (await response.json()) as { page: DuplicatedPage };
    expect(page.id).not.toBe(mine.id);
    expect(page.title).toBe("元の題名のコピー");
    expect(calls).toEqual(["page:user-a", "duplicate:user-a"]);
  });

  it("refuses to share, rotate, duplicate or export.md a folder with 400 (reason folder), and writes nothing", async () => {
    const folder = row("user-a", { kind: "folder", blocks: [] });
    const { store, calls } = memoryStore([folder]);
    const d = deps("user-a", store);
    for (const [label, method, suffix, handler] of ROUTES.filter(([label]) => label !== "GET share" && label !== "DELETE share")) {
      const response = await call(handler, method, suffix, folder.id, d);
      expect(response.status, label).toBe(400);
      expect(await response.json(), label).toEqual({ error: "bad_request", reason: "folder" });
    }
    expect(folder.token).toBeNull();
    expect(calls.filter((entry) => !entry.startsWith("page:"))).toEqual([]);
    // 別の人のフォルダは同じ 404
    const theirs = row("user-b", { kind: "folder", blocks: [] });
    const other = memoryStore([theirs]);
    expect((await call(enableShareRoute, "PUT", "/share", theirs.id, deps("user-a", other.store))).status).toBe(404);
  });

  it("answers 500 without internal details or the token when the store fails", async () => {
    const mine = row("user-a");
    const failing: PageActionsStore = {
      ...memoryStore([mine]).store,
      enableShare: async () => {
        throw Object.assign(new Error(`duplicate key value violates unique constraint: Key (token)=(${"Z".repeat(43)}) already exists`), { code: "23505" });
      },
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await call(enableShareRoute, "PUT", "/share", mine.id, deps("user-a", failing));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"internal"}');
    expect(JSON.stringify(log.mock.calls)).not.toContain("Z".repeat(43));
    expect(log.mock.calls[0]?.[1]).toEqual({ route: "PUT /api/pages/[id]/share", name: "Error", code: "23505" });
    log.mockRestore();
  });

  it("marks every JSON response noindex, nofollow and uncacheable", async () => {
    const mine = row("user-a");
    const { store } = memoryStore([mine]);
    for (const [label, method, suffix, handler] of ROUTES.filter(([label]) => label !== "GET export.md")) {
      for (const response of [
        await call(handler, method, suffix, mine.id, deps("user-a", store)),
        await call(handler, method, suffix, "not-a-uuid", deps("user-a", store)),
        await call(handler, method, suffix, mine.id, deps(null, store)),
      ]) {
        expect(response.headers.get("x-robots-tag"), label).toBe("noindex, nofollow");
        expect(response.headers.get("cache-control"), label).toBe("private, no-store");
        expect(response.headers.get("content-type"), label).toBe("application/json; charset=utf-8");
      }
    }
  });
});

describe("GET /api/pages/{id}/export.md", () => {
  it("keeps new blocks and returns a reason when Markdown cannot represent a cell", async () => {
    const task = { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "完了" }] }] }] };
    const mine = row("user-a", { blocks: [task] });
    const { store } = memoryStore([mine]);
    const response = await call(exportMarkdownRoute, "GET", "/export.md", mine.id, deps("user-a", store));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("- [x] 完了");

    const invalid = row("user-a", { blocks: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableHeader", attrs: { colspan: 2 }, content: [{ type: "paragraph" }] }] }] }] });
    const rejected = await call(exportMarkdownRoute, "GET", "/export.md", invalid.id, deps("user-a", memoryStore([invalid]).store));
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ error: "unsupported_markdown", reason: expect.stringMatching(/結合セル/) });
  });
  it("answers the Markdown of the saved blocks as an attachment that is not cached or sniffed", async () => {
    const mine = row("user-a", {
      title: "合成の題名",
      blocks: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "見出し" }] },
        { type: "paragraph", content: [{ type: "text", text: "<script>本文</script>" }] },
      ],
    });
    const { store } = memoryStore([mine]);
    const response = await call(exportMarkdownRoute, "GET", "/export.md", mine.id, deps("user-a", store));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("## 見出し\n\n\\<script\\>本文\\</script\\>\n");
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="page.md"; filename*=UTF-8''${encodeURIComponent("合成の題名.md")}`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("answers an empty body for an empty page", async () => {
    const mine = row("user-a", { title: "", blocks: [] });
    const { store } = memoryStore([mine]);
    const response = await call(exportMarkdownRoute, "GET", "/export.md", mine.id, deps("user-a", store));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="page.md"; filename*=UTF-8''page.md`);
  });

  it("makes a safe file name from the title", () => {
    expect(exportFileBaseName("")).toBe("page");
    expect(exportFileBaseName("  ...  ")).toBe("page");
    expect(exportFileBaseName('a/b\\c:d*e?f"g<h>i|j')).toBe("abcdefghij");
    expect(exportFileBaseName("改行\nと\tタブ\u0000")).toBe("改行とタブ");
    expect(exportFileBaseName("右から\u202e左")).toBe("右から左");
    expect(exportFileBaseName("../../etc/passwd")).toBe("etcpasswd");
    expect(exportFileBaseName(".hidden")).toBe("hidden");
    expect(Array.from(exportFileBaseName("あ".repeat(200))).length).toBe(80);
    expect(exportFileBaseName("😀".repeat(100))).toBe("😀".repeat(80));
    const header = exportContentDisposition("It's (draft) 50%; \"quoted\"");
    expect(header).toBe(`attachment; filename="page.md"; filename*=UTF-8''It%27s%20%28draft%29%2050%25%3B%20quoted.md`);
    // RFC 5987 の attr-char 以外（' ( ) * など）は %XX になっている
    expect(header.split("''")[1]).toMatch(/^[A-Za-z0-9!#$&+\-.^_`|~%]+$/);
  });
});

describe("readShareFlag (the 共有中 mark when a page opens)", () => {
  const OWNER = "user-flag";
  const PAGE = "00000000-0000-4000-8000-0000000000f1";

  it("says only whether the page is shared (never the link), and null when it cannot tell", async () => {
    const token = randomBytes(32).toString("base64url");
    const shared = { getShare: vi.fn(async () => ({ shared: true, token, createdAt: "2026-01-01T00:00:00.000Z", rotatedAt: null }) satisfies PageShareState) };
    expect(await readShareFlag(shared, OWNER, PAGE)).toBe(true);
    expect(shared.getShare).toHaveBeenCalledWith(OWNER, PAGE);
    expect(await readShareFlag({ getShare: async () => ({ shared: false }) }, OWNER, PAGE)).toBe(false);
    // ページが無い・DB が無い
    expect(await readShareFlag({ getShare: async () => null }, OWNER, PAGE)).toBeNull();
    expect(await readShareFlag(null, OWNER, PAGE)).toBeNull();
  });

  it("does not stop the page from opening when the read fails, and logs only the error's name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const secret = randomBytes(32).toString("base64url");
      const failing = { getShare: async () => Promise.reject(new Error(`connection lost near ${secret}`)) };
      expect(await readShareFlag(failing, OWNER, PAGE)).toBeNull();
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    } finally {
      log.mockRestore();
    }
  });
});
