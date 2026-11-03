import { afterEach, describe, expect, it, vi } from "vitest";
import { UNCREATED_REVISION, classifySaveFailure, createPageSaver, jsonEqual, sameContent } from "./page-save";
import { PageConflictError, PageRequestError, type ConflictPage, type PageBody, type SaveRequestOptions } from "./pages-client";

const PAGE_ID = "00000000-0000-4000-8000-000000000001";
const paragraph = (text: string) => [{ type: "paragraph", content: [{ type: "text", text }] }];

type Call = { body: PageBody; options: SaveRequestOptions };

/** サーバーの代わり（revision の比較と上書きだけ）。`drop` の回は書いたあとに応答を落とす（TypeError）。 */
function fakeServer(start: { title: string; blocks: unknown[]; revision: number }) {
  const page = { ...start, updatedAt: "2026-10-31T03:40:00.000Z" };
  const calls: Call[] = [];
  let drop = 0;
  let down = false;
  const request = vi.fn(async (_id: string, body: PageBody, options: SaveRequestOptions): Promise<number> => {
    calls.push({ body, options });
    if (down) throw new TypeError("Failed to fetch");
    if (options.baseRevision !== page.revision) {
      const latest: ConflictPage = { title: page.title, blocks: page.blocks, revision: page.revision, updatedAt: page.updatedAt };
      throw new PageConflictError(latest);
    }
    if (body.title !== undefined) page.title = body.title;
    if (body.blocks !== undefined) page.blocks = body.blocks;
    page.revision += 1;
    if (drop > 0) {
      drop--;
      throw new TypeError("network connection was lost");
    }
    return page.revision;
  });
  return {
    page,
    calls,
    request,
    dropNextResponse: () => (drop = 1),
    setDown: (value: boolean) => (down = value),
    /** 別の画面が保存する。 */
    elsewhere: (title: string, blocks: unknown[]) => {
      page.title = title;
      page.blocks = blocks;
      page.revision += 1;
    },
  };
}

const NO_KEEPALIVE = { keepalive: false };

describe("jsonEqual / sameContent", () => {
  it("compares JSON values regardless of key order", () => {
    expect(jsonEqual({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({ a: undefined }, {})).toBe(true);
    expect(jsonEqual(null, {})).toBe(false);
  });

  it("treats TipTap's JSON and the stored canonical blocks as the same body", () => {
    // TipTap の getJSON（表示用の属性つき）と、サーバーが保存する限定 AST の形（jsonb はキーの順も変わる）
    const fromEditor = [
      { type: "orderedList", attrs: { start: 1, type: null }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "一" }] }] }] },
      {
        type: "paragraph",
        content: [{ type: "text", text: "リンク", marks: [{ type: "link", attrs: { href: "https://niho.life", target: "_blank", rel: "noopener", class: null, title: null } }] }],
      },
    ];
    const stored = [
      { content: [{ content: [{ content: [{ text: "一", type: "text" }], type: "paragraph" }], type: "listItem" }], type: "orderedList" },
      { content: [{ marks: [{ attrs: { href: "https://niho.life" }, type: "link" }], text: "リンク", type: "text" }], type: "paragraph" },
    ];
    expect(sameContent({ title: "t", blocks: fromEditor }, { title: "t", blocks: stored })).toBe(true);
    expect(sameContent({ title: "t", blocks: fromEditor }, { title: "u", blocks: stored })).toBe(false);
    expect(sameContent({ title: "t", blocks: paragraph("a") }, { title: "t", blocks: paragraph("b") })).toBe(false);
  });

  it("treats the editor's empty paragraph as the empty body", () => {
    expect(sameContent({ title: "", blocks: [{ type: "paragraph" }] }, { title: "", blocks: [] })).toBe(true);
  });

  it("compares the language only when both sides know it (an old draft or a response without it is compared by title and body)", () => {
    expect(sameContent({ title: "t", blocks: [], lang: "ja" }, { title: "t", blocks: [], lang: "en" })).toBe(false);
    expect(sameContent({ title: "t", blocks: [], lang: "en" }, { title: "t", blocks: [], lang: "en" })).toBe(true);
    expect(sameContent({ title: "t", blocks: [] }, { title: "t", blocks: [], lang: "en" })).toBe(true);
    expect(sameContent({ title: "t", blocks: [], lang: "ja" }, { title: "u", blocks: [], lang: "ja" })).toBe(false);
  });
});

describe("classifySaveFailure", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("splits failures into stopped, signedOut, offline and error", () => {
    expect(classifySaveFailure(new PageConflictError({ title: "", blocks: [], revision: 2, updatedAt: "" }))).toBe("stopped");
    expect(classifySaveFailure(new PageRequestError(401))).toBe("signedOut");
    expect(classifySaveFailure(new PageRequestError(500))).toBe("error");
    expect(classifySaveFailure(new PageRequestError(503))).toBe("error");
    expect(classifySaveFailure(new PageRequestError(409))).toBe("error");
    expect(classifySaveFailure(new TypeError("Failed to fetch"))).toBe("offline");
    expect(classifySaveFailure(new DOMException("timed out", "TimeoutError"))).toBe("offline");
    expect(classifySaveFailure(new Error("other"))).toBe("error");
    vi.stubGlobal("navigator", { onLine: false });
    expect(classifySaveFailure(new Error("other"))).toBe("offline");
  });
});

describe("createPageSaver", () => {
  it("keeps cover and lead on partial saves, compares them on conflicts, and can clear both explicitly", async () => {
    const request = vi.fn(async (_id: string, _body: PageBody, options: SaveRequestOptions) => options.baseRevision + 1);
    const saver = createPageSaver({
      pageId: PAGE_ID,
      revision: 5,
      content: { title: "題", blocks: [], cover: PAGE_ID, lead: "説明" },
      request,
    });
    await saver.save({ title: "新しい題" }, NO_KEEPALIVE);
    expect(saver.content).toEqual({ title: "新しい題", blocks: [], cover: PAGE_ID, lead: "説明" });
    await saver.save({ cover: null, lead: null }, NO_KEEPALIVE);
    expect(saver.content).toEqual({ title: "新しい題", blocks: [], cover: null, lead: null });
  });

  it("sends the revision it has as baseRevision and advances it from each response", async () => {
    const server = fakeServer({ title: "", blocks: [], revision: 5 });
    const saver = createPageSaver({ pageId: PAGE_ID, revision: 5, content: { title: "", blocks: [] }, request: server.request });
    await saver.save({ title: "一" }, NO_KEEPALIVE);
    await saver.save({ blocks: paragraph("本文") }, { keepalive: true });
    expect(server.calls.map((call) => call.options)).toEqual([
      { baseRevision: 5, overwrite: false, keepalive: false },
      { baseRevision: 6, overwrite: false, keepalive: true },
    ]);
    expect(saver.revision).toBe(7);
  });

  it("takes a 409 whose page equals what it is sending as its own save (the response was lost), and adopts that revision", async () => {
    const server = fakeServer({ title: "", blocks: [], revision: 1 });
    const saver = createPageSaver({ pageId: PAGE_ID, revision: 1, content: { title: "", blocks: [] }, request: server.request });
    server.dropNextResponse();
    await expect(saver.save({ title: "題", blocks: paragraph("本文") }, NO_KEEPALIVE)).rejects.toBeInstanceOf(TypeError);
    expect(server.page.revision).toBe(2);
    // 送り直すと 409 だが、中身は自分が送ったもの
    await saver.save({ title: "題", blocks: paragraph("本文") }, NO_KEEPALIVE);
    expect(saver.revision).toBe(2);
    await saver.save({ title: "題2" }, NO_KEEPALIVE);
    expect(server.calls.at(-1)?.options.baseRevision).toBe(2);
    expect(server.page.title).toBe("題2");
  });

  it("takes a 409 that matches an earlier save whose response was lost, and sends the newer change on top of it once", async () => {
    const server = fakeServer({ title: "", blocks: [], revision: 1 });
    const saver = createPageSaver({ pageId: PAGE_ID, revision: 1, content: { title: "", blocks: [] }, request: server.request });
    server.dropNextResponse();
    await expect(saver.save({ blocks: paragraph("一") }, NO_KEEPALIVE)).rejects.toBeInstanceOf(TypeError);
    server.setDown(true);
    await expect(saver.save({ blocks: paragraph("一二") }, NO_KEEPALIVE)).rejects.toBeInstanceOf(TypeError);
    server.setDown(false);
    // 書いている間に続きを打った（送る内容は 409 の中身と違う）
    await saver.save({ blocks: paragraph("一二三") }, NO_KEEPALIVE);
    expect(server.page.blocks).toEqual(paragraph("一二三"));
    expect(server.page.revision).toBe(3);
    expect(saver.revision).toBe(3);
    expect(server.calls.slice(-2).map((call) => call.options.baseRevision)).toEqual([1, 2]);
  });

  it("raises a real conflict when another screen saved something else", async () => {
    const server = fakeServer({ title: "", blocks: [], revision: 1 });
    const saver = createPageSaver({ pageId: PAGE_ID, revision: 1, content: { title: "", blocks: [] }, request: server.request });
    server.elsewhere("別の画面", paragraph("別の本文"));
    const failure = await saver.save({ title: "この画面" }, NO_KEEPALIVE).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PageConflictError);
    expect((failure as PageConflictError).page).toMatchObject({ title: "別の画面", revision: 2 });
    expect(saver.revision).toBe(1);
  });

  it("does not take another screen's save of a different body as its own, even after a lost response", async () => {
    const server = fakeServer({ title: "", blocks: [], revision: 1 });
    const saver = createPageSaver({ pageId: PAGE_ID, revision: 1, content: { title: "", blocks: [] }, request: server.request });
    server.setDown(true);
    await expect(saver.save({ blocks: paragraph("自分") }, NO_KEEPALIVE)).rejects.toBeInstanceOf(TypeError);
    server.setDown(false);
    server.elsewhere("", paragraph("別の画面"));
    await expect(saver.save({ blocks: paragraph("自分の続き") }, NO_KEEPALIVE)).rejects.toBeInstanceOf(PageConflictError);
    expect(server.page.blocks).toEqual(paragraph("別の画面"));
  });

  it("overwrites onto the conflicting page's revision on request, then saves normally", async () => {
    const server = fakeServer({ title: "", blocks: [], revision: 1 });
    const saver = createPageSaver({ pageId: PAGE_ID, revision: 1, content: { title: "", blocks: [] }, request: server.request });
    server.elsewhere("別の画面", paragraph("別の本文"));
    const failure = (await saver.save({ title: "この画面" }, NO_KEEPALIVE).catch((error: unknown) => error)) as PageConflictError;
    saver.overwriteOnto(failure.page);
    await saver.save({ title: "この画面", blocks: paragraph("この本文") }, NO_KEEPALIVE);
    expect(server.calls.at(-1)?.options).toEqual({ baseRevision: 2, overwrite: true, keepalive: false });
    expect(server.page).toMatchObject({ title: "この画面", blocks: paragraph("この本文"), revision: 3 });
    await saver.save({ title: "続き" }, NO_KEEPALIVE);
    expect(server.calls.at(-1)?.options).toEqual({ baseRevision: 3, overwrite: false, keepalive: false });
  });

  it("rebases onto a page the server now holds (an AI adoption): the next save goes on that revision, and a lost response there is still its own save", async () => {
    const server = fakeServer({ title: "題", blocks: paragraph("前"), revision: 1 });
    const saver = createPageSaver({ pageId: PAGE_ID, revision: 1, content: { title: "題", blocks: paragraph("前") }, request: server.request });
    // 採用でサーバーが revision 2 の本文を持った（この画面の保存ではない）
    server.elsewhere("題", paragraph("採用した本文"));
    saver.rebase(2, { title: "題", blocks: paragraph("採用した本文") });
    expect(saver.revision).toBe(2);
    // 題名だけの保存の応答を落とし、送り直すと 409。中身は「採用した本文＋新しい題名」で、自分の保存として受け取る
    server.dropNextResponse();
    await expect(saver.save({ title: "新しい題" }, NO_KEEPALIVE)).rejects.toBeInstanceOf(TypeError);
    await saver.save({ title: "新しい題" }, NO_KEEPALIVE);
    expect(server.calls.map((call) => call.options.baseRevision)).toEqual([2, 2]);
    expect(saver.revision).toBe(3);
    expect(server.page).toMatchObject({ title: "新しい題", blocks: paragraph("採用した本文"), revision: 3 });
  });

  describe("the language (info panel) on the same save", () => {
    const UPDATED = "2026-10-31T03:40:00.000Z";
    const conflict = (page: Omit<ConflictPage, "updatedAt">) => new PageConflictError({ ...page, updatedAt: UPDATED });

    it("sends the language with the page's revision and knows the language the server now has", async () => {
      const request = vi.fn(async (_id: string, _body: PageBody, options: SaveRequestOptions) => options.baseRevision + 1);
      const saver = createPageSaver({ pageId: PAGE_ID, revision: 4, content: { title: "t", blocks: [], lang: "ja" }, request });
      expect(saver.content.lang).toBe("ja");
      await saver.save({ lang: "en" }, NO_KEEPALIVE);
      expect(request).toHaveBeenCalledWith(PAGE_ID, { lang: "en" }, { baseRevision: 4, overwrite: false, keepalive: false });
      expect(saver.revision).toBe(5);
      expect(saver.content).toEqual({ title: "t", blocks: [], lang: "en" });
      // 題名だけの保存のあとも、言語はそのまま
      await saver.save({ title: "u" }, NO_KEEPALIVE);
      expect(saver.content).toEqual({ title: "u", blocks: [], lang: "en" });
    });

    it("does not take a 409 as its own save when only the language differs (another screen saved; the change did not land)", async () => {
      const request = vi.fn(async (): Promise<number> => {
        throw conflict({ title: "t", blocks: [], lang: "ja", revision: 5 });
      });
      const saver = createPageSaver({ pageId: PAGE_ID, revision: 4, content: { title: "t", blocks: [], lang: "ja" }, request });
      await expect(saver.save({ lang: "en" }, NO_KEEPALIVE)).rejects.toBeInstanceOf(PageConflictError);
      expect(saver.revision).toBe(4);
      expect(saver.content.lang).toBe("ja");
    });

    it("takes a 409 whose title, body and language equal what it is sending as its own (the response was lost)", async () => {
      const request = vi.fn(async (): Promise<number> => {
        throw conflict({ title: "t", blocks: [], lang: "en", revision: 5 });
      });
      const saver = createPageSaver({ pageId: PAGE_ID, revision: 4, content: { title: "t", blocks: [], lang: "ja" }, request });
      await saver.save({ lang: "en" }, NO_KEEPALIVE);
      expect(saver.revision).toBe(5);
      expect(saver.content.lang).toBe("en");
    });

    it("overwrites onto the conflicting page with its language as what the server has", () => {
      const saver = createPageSaver({ pageId: PAGE_ID, revision: 4, content: { title: "t", blocks: [], lang: "ja" } });
      saver.overwriteOnto({ title: "別", blocks: paragraph("別"), revision: 9, updatedAt: UPDATED, lang: "en" });
      expect(saver.revision).toBe(9);
      expect(saver.content).toEqual({ title: "別", blocks: paragraph("別"), lang: "en" });
    });
  });

  it("creates a new page with the first save (POST), then PATCHes that page on the revision it was created with", async () => {
    const server = fakeServer({ title: "", blocks: [], revision: 1 });
    const create = vi.fn(async (body: PageBody = {}, options: { keepalive?: boolean } = {}) => {
      expect(typeof options.keepalive).toBe("boolean");
      if (body.title !== undefined) server.page.title = body.title;
      if (body.blocks !== undefined) server.page.blocks = body.blocks;
      return { id: PAGE_ID, revision: server.page.revision };
    });
    const onCreated = vi.fn();
    const saver = createPageSaver({ pageId: null, revision: UNCREATED_REVISION, content: { title: "", blocks: [] }, request: server.request, create, onCreated });
    expect(saver.pageId).toBeNull();
    expect(saver.revision).toBe(UNCREATED_REVISION);

    await saver.save({ title: "作る" }, { keepalive: true });
    expect(create).toHaveBeenCalledWith({ title: "作る" }, { keepalive: true });
    expect(onCreated).toHaveBeenCalledWith({ id: PAGE_ID, revision: 1 });
    expect(saver.pageId).toBe(PAGE_ID);
    expect(saver.revision).toBe(1);
    expect(server.calls).toEqual([]);

    await saver.save({ blocks: paragraph("本文") }, NO_KEEPALIVE);
    expect(create).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(server.calls.map((call) => call.options)).toEqual([{ baseRevision: 1, overwrite: false, keepalive: false }]);
    expect(server.page).toMatchObject({ title: "作る", blocks: paragraph("本文"), revision: 2 });
  });

  it("keeps a new page uncreated when the POST fails, and creates it with the next save", async () => {
    const create = vi.fn(async (): Promise<{ id: string; revision: number }> => {
      throw new TypeError("Failed to fetch");
    });
    const saver = createPageSaver({ pageId: null, revision: UNCREATED_REVISION, content: { title: "", blocks: [] }, create });
    await expect(saver.save({ title: "圏外" }, NO_KEEPALIVE)).rejects.toBeInstanceOf(TypeError);
    expect(saver.pageId).toBeNull();
    create.mockImplementationOnce(async () => ({ id: PAGE_ID, revision: 1 }));
    await saver.save({ title: "圏外" }, NO_KEEPALIVE);
    expect(create).toHaveBeenCalledTimes(2);
    expect(saver.pageId).toBe(PAGE_ID);
  });
});
