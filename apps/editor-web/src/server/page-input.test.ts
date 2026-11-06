import { describe, expect, it } from "vitest";
import {
  MAX_BLOCK_DEPTH,
  MAX_BLOCKS_BYTES,
  MAX_TITLE_CHARS,
  parseBlocks,
  parseCreatePage,
  parsePagePatch,
  parsePageSave,
  parseRestoreBody,
  parseVersionNumber,
} from "./page-input";

const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

describe("parseCreatePage", () => {
  it("accepts an empty page and the documented fields", () => {
    expect(parseCreatePage({})).toEqual({ ok: true, value: {} });
    expect(parseCreatePage({ kind: "article", title: "題名", lang: "en", blocks: [paragraph("本文")] })).toEqual({
      ok: true,
      value: { kind: "article", title: "題名", lang: "en", blocks: [paragraph("本文")] },
    });
    expect(parseCreatePage({ lead: "公開用の要約" })).toEqual({ ok: true, value: { lead: "公開用の要約" } });
    expect(parseCreatePage({ lead: null })).toEqual({ ok: true, value: { lead: null } });
  });

  it("rejects bodies that are not objects, unknown keys, and out-of-range values", () => {
    for (const body of [null, [], "x", 1, { owner: "someone-else" }, { id: "x" }, { kind: "html" }, { lang: "fr" }, { title: 1 }, { title: "a\u0000b" }]) {
      expect(parseCreatePage(body)).toEqual({ ok: false });
    }
    expect(parseCreatePage({ title: "あ".repeat(MAX_TITLE_CHARS) }).ok).toBe(true);
    expect(parseCreatePage({ title: "あ".repeat(MAX_TITLE_CHARS + 1) }).ok).toBe(false);
    expect(parseCreatePage({ lead: "あ".repeat(161) }).ok).toBe(false);
    expect(parseCreatePage({ cover: "00000000-0000-4000-8000-000000000001" }).ok).toBe(false);
  });

  it("takes a folder and a parent folder id; a folder has no body and no parent", () => {
    const parent = "00000000-0000-4000-8000-000000000001";
    expect(parseCreatePage({ kind: "folder", title: "フォルダ" })).toEqual({ ok: true, value: { kind: "folder", title: "フォルダ" } });
    expect(parseCreatePage({ kind: "rec", parent })).toEqual({ ok: true, value: { kind: "rec", parent } });
    expect(parseCreatePage({ parent: parent.toUpperCase() })).toEqual({ ok: true, value: { parent } });
    expect(parseCreatePage({ parent: null })).toEqual({ ok: true, value: {} });
    for (const body of [{ parent: "x" }, { parent: 1 }, { kind: "folder", parent }, { kind: "folder", blocks: [paragraph("本文")] }]) {
      expect(parseCreatePage(body), JSON.stringify(body)).toEqual({ ok: false });
    }
    expect(parseCreatePage({ kind: "folder", blocks: [] }).ok).toBe(true);
  });
});

describe("parsePagePatch", () => {
  it("needs at least one field", () => {
    expect(parsePagePatch({})).toEqual({ ok: false });
    expect(parsePagePatch({ title: "" })).toEqual({ ok: true, value: { title: "" } });
    expect(parsePagePatch({ cover: null })).toEqual({ ok: true, value: { cover: null } });
    expect(parsePagePatch({ cover: "00000000-0000-4000-8000-000000000001", lead: "要約" })).toEqual({
      ok: true,
      value: { cover: "00000000-0000-4000-8000-000000000001", lead: "要約" },
    });
    expect(parsePagePatch({ lead: null })).toEqual({ ok: true, value: { lead: null } });
    expect(parsePagePatch({ cover: "bad" }).ok).toBe(false);
    expect(parsePagePatch({ lead: "あ".repeat(161) }).ok).toBe(false);
    expect(parsePagePatch({ lead: "a\u0000b" }).ok).toBe(false);
  });
});

describe("parsePageSave", () => {
  it("needs a positive integer baseRevision and at least one field, and takes an optional boolean overwrite", () => {
    expect(parsePageSave({ title: "題名", baseRevision: 3 })).toEqual({ ok: true, value: { patch: { title: "題名" }, baseRevision: 3, overwrite: false } });
    expect(parsePageSave({ blocks: [], baseRevision: 1, overwrite: true })).toEqual({ ok: true, value: { patch: { blocks: [] }, baseRevision: 1, overwrite: true } });
    expect(parsePageSave({ title: "", baseRevision: 1, overwrite: false })).toEqual({ ok: true, value: { patch: { title: "" }, baseRevision: 1, overwrite: false } });
    for (const body of [
      null,
      [],
      { title: "x" },
      { baseRevision: 1 },
      { baseRevision: 1, overwrite: true },
      { title: "x", baseRevision: 0 },
      { title: "x", baseRevision: -2 },
      { title: "x", baseRevision: 1.5 },
      { title: "x", baseRevision: "1" },
      { title: "x", baseRevision: null },
      { title: "x", baseRevision: 2 ** 31 },
      { title: "x", baseRevision: Number.MAX_SAFE_INTEGER + 1 },
      { title: "x", baseRevision: 1, overwrite: "true" },
      { title: "x", baseRevision: 1, overwrite: null },
      { title: "x", baseRevision: 1, revision: 2 },
      { title: "x", baseRevision: 1, owner: "someone-else" },
    ]) {
      expect(parsePageSave(body), JSON.stringify(body)).toEqual({ ok: false });
    }
  });
});

describe("parseRestoreBody", () => {
  it("takes only a positive integer baseRevision", () => {
    expect(parseRestoreBody({ baseRevision: 4 })).toEqual({ ok: true, value: { baseRevision: 4 } });
    for (const body of [null, [], {}, { baseRevision: 0 }, { baseRevision: "4" }, { baseRevision: 4, overwrite: true }, { baseRevision: 4, blocks: [] }]) {
      expect(parseRestoreBody(body), JSON.stringify(body)).toEqual({ ok: false });
    }
  });
});

describe("parseVersionNumber", () => {
  it("accepts plain positive decimal integers that fit the database integer", () => {
    expect(parseVersionNumber("1")).toBe(1);
    expect(parseVersionNumber("2147483647")).toBe(2147483647);
    for (const value of ["", "0", "-1", "01", "+1", "1.0", "1e3", " 1", "1 ", "0x10", "abc", "2147483648", "99999999999"]) {
      expect(parseVersionNumber(value), value).toBeNull();
    }
  });
});

describe("parseBlocks", () => {
  it("accepts an array of typed objects", () => {
    expect(parseBlocks([]).ok).toBe(true);
    expect(parseBlocks([paragraph("a"), { type: "horizontalRule" }]).ok).toBe(true);
  });

  it("rejects non-arrays, untyped items, NUL, too deep or too large bodies", () => {
    expect(parseBlocks({ type: "doc" }).ok).toBe(false);
    expect(parseBlocks(["<p>html</p>"]).ok).toBe(false);
    expect(parseBlocks([{ text: "no type" }]).ok).toBe(false);
    expect(parseBlocks([null]).ok).toBe(false);
    expect(parseBlocks([paragraph("a\u0000b")]).ok).toBe(false);
    let deep: Record<string, unknown> = { type: "paragraph" };
    for (let index = 0; index < MAX_BLOCK_DEPTH + 2; index++) deep = { type: "blockquote", content: [deep] };
    expect(parseBlocks([deep]).ok).toBe(false);
    expect(parseBlocks([paragraph("x".repeat(MAX_BLOCKS_BYTES))]).ok).toBe(false);
  });
});
