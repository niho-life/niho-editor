import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PageActionError,
  deletePageRequest,
  duplicatePageRequest,
  exportPageToGoogleDoc,
  getPageShare,
  googleDocExportStatus,
  newGoogleDocExportId,
  listPageVersions,
  pageExportUrl,
  restorePageVersion,
  rotatePageShare,
  startPageShare,
  stopPageShare,
} from "./page-actions-client";

const ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const PUBLIC = { status: "PUBLIC", publicId: "p".repeat(22), url: `https://editor.test/s/${"t".repeat(43)}`, updatedAt: "2026-01-01T00:00:00.000Z" };
const PRIVATE = { status: "PRIVATE", publicId: null, url: null, updatedAt: null };

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("page actions client", () => {
  it("calls the share endpoints with the right method and same-origin, uncached requests", async () => {
    const cases: Array<[() => Promise<unknown>, string, string, unknown]> = [
      [() => getPageShare(ID), "GET", `/api/pages/${ID}/share`, PRIVATE],
      [() => startPageShare(ID), "PUT", `/api/pages/${ID}/share`, PUBLIC],
      [() => rotatePageShare(ID), "POST", `/api/pages/${ID}/share/rotate`, PUBLIC],
      [() => stopPageShare(ID), "DELETE", `/api/pages/${ID}/share`, PRIVATE],
    ];
    for (const [run, method, path, share] of cases) {
      const fetchMock = mockFetch(200, { share: { ...(share as object), extra: "dropped" } });
      expect(await run()).toEqual(share);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(path, { method, credentials: "same-origin", cache: "no-store" });
    }
  });

  it("encodes the page id into the path", async () => {
    const fetchMock = mockFetch(404, { error: "not_found" });
    await expect(getPageShare("../search?q=x")).rejects.toThrow(PageActionError);
    expect(fetchMock).toHaveBeenCalledWith("/api/pages/..%2Fsearch%3Fq%3Dx/share", expect.anything());
    expect(pageExportUrl("a/b")).toBe("/api/pages/a%2Fb/export.md");
    expect(pageExportUrl(ID)).toBe(`/api/pages/${ID}/export.md`);
  });

  it("throws PageActionError with the status on an error response", async () => {
    for (const status of [401, 403, 404, 500, 503]) {
      mockFetch(status, { error: "x" });
      await expect(startPageShare(ID)).rejects.toMatchObject({ name: "PageActionError", status });
    }
  });

  it("refuses a malformed share state", async () => {
    for (const share of [undefined, null, { status: "OPEN", publicId: null, url: null, updatedAt: null }, { status: "PUBLIC", publicId: 1, url: null, updatedAt: null }, { status: "PRIVATE", publicId: "x", url: "https://x/s/y", updatedAt: null }]) {
      mockFetch(200, { share });
      await expect(getPageShare(ID)).rejects.toMatchObject({ status: 500 });
    }
  });

  it("duplicates a page and returns the new id, title and kind (for the top of the list)", async () => {
    const newId = "7f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d12";
    const fetchMock = mockFetch(201, { page: { id: newId, title: "合成のコピー", kind: "rec", blocks: [] } });
    expect(await duplicatePageRequest(ID)).toEqual({ id: newId, title: "合成のコピー", kind: "rec" });
    expect(fetchMock).toHaveBeenCalledWith(`/api/pages/${ID}/duplicate`, { method: "POST", credentials: "same-origin", cache: "no-store" });
    // 読めない種類は note として扱う（複製はできているので失敗にしない）
    mockFetch(201, { page: { id: newId, title: "", kind: "unknown" } });
    expect(await duplicatePageRequest(ID)).toEqual({ id: newId, title: "", kind: "note" });
    mockFetch(201, { page: { id: "not-a-uuid", title: "x" } });
    await expect(duplicatePageRequest(ID)).rejects.toMatchObject({ status: 500 });
    mockFetch(201, { page: { id: newId } });
    await expect(duplicatePageRequest(ID)).rejects.toMatchObject({ status: 500 });
    mockFetch(404, { error: "not_found" });
    await expect(duplicatePageRequest(ID)).rejects.toMatchObject({ status: 404 });
  });

  it("deletes a page with DELETE (204), and keeps the status and code of a refusal", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(deletePageRequest(ID)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(`/api/pages/${ID}`, expect.objectContaining({ method: "DELETE", credentials: "same-origin", cache: "no-store" }));
    // 応答が来ないまま待ち続けない
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeInstanceOf(AbortSignal);

    mockFetch(409, { error: "published" });
    await expect(deletePageRequest(ID)).rejects.toMatchObject({ name: "PageActionError", status: 409, code: "published" });
    mockFetch(404, { error: "not_found" });
    await expect(deletePageRequest(ID)).rejects.toMatchObject({ status: 404, code: "not_found" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    await expect(deletePageRequest(ID)).rejects.toMatchObject({ status: 502, code: null });
    const encoded = mockFetch(404, { error: "not_found" });
    await expect(deletePageRequest("../trash")).rejects.toThrow(PageActionError);
    expect(encoded).toHaveBeenCalledWith("/api/pages/..%2Ftrash", expect.anything());
  });
  it("lists the versions newest first as the server sent them, and refuses a malformed list", async () => {
    const rows = [
      { version: 3, reason: "restore", createdAt: "2026-01-03T00:00:00.000Z", blockCount: 2 },
      { version: 2, reason: "ai", createdAt: "2026-01-02T00:00:00.000Z", blockCount: 0 },
      { version: 1, reason: "autosave", createdAt: "2026-01-01T00:00:00.000Z", blockCount: 1 },
    ];
    const fetchMock = mockFetch(200, { versions: rows.map((row) => ({ ...row, blocks: ["dropped"] })) });
    expect(await listPageVersions(ID)).toEqual(rows);
    expect(fetchMock).toHaveBeenCalledWith(`/api/pages/${ID}/versions`, { method: "GET", credentials: "same-origin", cache: "no-store" });
    mockFetch(200, { versions: [] });
    expect(await listPageVersions(ID)).toEqual([]);
    for (const versions of [undefined, null, [{ ...rows[0], version: 0 }], [{ ...rows[0], blockCount: -1 }], [{ ...rows[0], reason: 1 }], [{ ...rows[0], createdAt: null }], ["x"]]) {
      mockFetch(200, { versions });
      await expect(listPageVersions(ID)).rejects.toMatchObject({ name: "PageActionError", status: 500 });
    }
    mockFetch(404, { error: "not_found" });
    await expect(listPageVersions(ID)).rejects.toMatchObject({ status: 404 });
  });

  it("restores a version with the base revision (JSON, same origin, with a time limit) and returns the restored page", async () => {
    const restored = { id: ID, title: "合成の題名", blocks: [{ type: "paragraph" }], revision: 8, updatedAt: "2026-01-04T00:00:00.000Z", cover: null, lead: null };
    const fetchMock = mockFetch(200, { page: { ...restored, kind: "note", lang: "ja", parent: null } });
    expect(await restorePageVersion(ID, 2, 7)).toEqual(restored);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/pages/${ID}/versions/2/restore`);
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(init.body))).toEqual({ baseRevision: 7 });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    // 競合・戻せない版・無い版は status と code を持つ
    for (const [status, error] of [[409, "conflict"], [422, "unrestorable"], [404, "not_found"], [401, "unauthorized"]] as const) {
      mockFetch(status, { error, page: restored });
      await expect(restorePageVersion(ID, 2, 7)).rejects.toMatchObject({ name: "PageActionError", status, code: error });
    }
    // 形の違う応答・別のページの応答は使わない
    for (const page of [undefined, { ...restored, id: "7f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d12" }, { ...restored, revision: 0 }, { ...restored, blocks: null }, { ...restored, title: 1 }]) {
      mockFetch(200, { page });
      await expect(restorePageVersion(ID, 2, 7)).rejects.toMatchObject({ status: 500 });
    }
  });
});

describe("Google ドキュメントへの書き出し", () => {
  const EXPORT_ID = "4b1a0f26-0b0e-4a6a-9f36-2b7c4a8e5d10";
  const DOCUMENT_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-012345";
  const completed = { exportId: EXPORT_ID, status: "completed", documentId: DOCUMENT_ID, url: `https://docs.google.com/document/d/${DOCUMENT_ID}/edit` };

  it("送るのは受付の id だけ（本文は送らない）", async () => {
    const fetchMock = mockFetch(200, completed);
    expect(await exportPageToGoogleDoc(ID, EXPORT_ID)).toEqual({ status: "completed", documentId: DOCUMENT_ID, url: completed.url });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/pages/${ID}/export/google-doc`);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    expect(JSON.parse(init.body as string)).toEqual({ exportId: EXPORT_ID });
  });

  it("受付の状態は exportId の path を読む", async () => {
    const fetchMock = mockFetch(202, { exportId: EXPORT_ID, status: "pending", retryable: true });
    expect(await googleDocExportStatus(EXPORT_ID)).toEqual({ status: "pending", retryable: true });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`/api/google-docs/exports/${EXPORT_ID}`);
  });

  it("documentId と合わない url の応答は受け付けない", async () => {
    for (const body of [
      { status: "completed", documentId: DOCUMENT_ID, url: "https://evil.test/document/d/x/edit" },
      { status: "completed", documentId: DOCUMENT_ID, url: `https://docs.google.com/document/d/${DOCUMENT_ID}/edit?x=1` },
      { status: "completed", documentId: DOCUMENT_ID },
      { status: "completed", url: completed.url },
      { status: "unknown" },
      {},
    ]) {
      mockFetch(200, body);
      await expect(exportPageToGoogleDoc(ID, EXPORT_ID)).rejects.toThrow(PageActionError);
    }
  });

  it("断られたときは status と短い code を持つ", async () => {
    mockFetch(409, { error: "drive_not_connected" });
    const error = await exportPageToGoogleDoc(ID, EXPORT_ID).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PageActionError);
    expect((error as PageActionError).status).toBe(409);
    expect((error as PageActionError).code).toBe("drive_not_connected");
  });

  it("受付の id は小文字の UUID", async () => {
    const id = newGoogleDocExportId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(newGoogleDocExportId()).not.toBe(id);
  });
});
