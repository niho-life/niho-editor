import { describe, expect, it } from "vitest";
import {
  MAX_VALIDATION_ISSUES,
  isHttpsUrl,
  isSafeLinkHref,
  isSitePath,
  parseBlocks,
  parseErrorBody,
  parseGoneBody,
  parsePreviewDoc,
  parsePublishedDoc,
  parsePublishedIndex,
} from "../src/validate.js";
import type { Block } from "../src/v1.js";
import { applyPatches, fixtures, validatorScenarios } from "./support/validator-scenarios.js";
import { readJson } from "./support/synthetic.js";

describe("positive fixtures", () => {
  it("accept the PublishedDoc, PublishedIndex, PreviewDoc and gone fixtures", () => {
    const doc = parsePublishedDoc(fixtures.doc);
    expect(doc.ok).toBe(true);
    expect(doc.ok && doc.value).toEqual(fixtures.doc);
    expect(parsePublishedIndex(fixtures.index).ok).toBe(true);
    expect(parsePublishedIndex(fixtures.index, { dest: "site" }).ok).toBe(true);
    expect(parsePreviewDoc(fixtures.preview).ok).toBe(true);
    expect(parseGoneBody(fixtures.gone, { from: "exp" }).ok).toBe(true);
    expect(parseErrorBody({ error: { code: "not_found", requestId: "req_1", retryable: false } }).ok).toBe(true);
  });

  it("drop unknown top-level fields but keep everything known", () => {
    const withExtra = { ...fixtures.doc, futureField: { nested: true }, preview: { expiresAt: "x" } };
    const result = parsePublishedDoc(withExtra);
    expect(result.ok && Object.keys(result.value)).not.toContain("futureField");
    expect(result.ok && Object.keys(result.value)).not.toContain("preview");
    const index = parsePublishedIndex(applyPatches(fixtures.index, [{ op: "set", path: ["items", 0, "futureField"], value: 1 }]));
    expect(index.ok && Object.keys(index.value.items[0] ?? {})).not.toContain("futureField");
  });

  it("keeps optional category display metadata and rejects client-shaped or orphaned values", () => {
    const display = { labelEn: "Walks", labelJa: "散策", displayOrder: 4, revision: 7 };
    const valid = parsePublishedDoc({ ...fixtures.doc, categoryDisplay: display });
    expect(valid.ok && valid.value.categoryDisplay).toEqual(display);
    expect(parsePublishedDoc({ ...fixtures.doc, categoryDisplay: { ...display, providerName: "private" } }).ok).toBe(false);
    expect(parsePublishedDoc({ ...fixtures.doc, category: null, categoryDisplay: display }).ok).toBe(false);
  });

  it("returns a fresh value that shares no prototype tricks", () => {
    const hostile = JSON.parse(JSON.stringify(fixtures.doc).replace('"contractVersion"', '"__proto__":{"polluted":true},"contractVersion"')) as unknown;
    const result = parsePublishedDoc(hostile);
    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("rejection details", () => {
  it("report a path and a reason, never the offending value", () => {
    const secretish = "javascript:alert('ek_" + "A".repeat(43) + "')";
    const result = parsePublishedDoc(applyPatches(fixtures.doc, [
      { op: "set", path: ["blocks", 0, "content", 3, "marks", 0, "href"], value: secretish },
    ]));
    expect(result).toEqual({ ok: false, errors: [{ path: "$.blocks[0].content[3].marks[0].href", reason: "unsafe-link" }] });
    expect(JSON.stringify(result)).not.toContain("ek_");
  });

  it("never echo unknown field names that look like data", () => {
    const result = parsePublishedDoc(applyPatches(fixtures.doc, [{ op: "set", path: ["extras", "ek_secret value"], value: 1 }]));
    expect(result).toEqual({ ok: false, errors: [{ path: "$.extras[?]", reason: "unknown-field" }] });
  });

  it("caps the number of issues", () => {
    const blocks = Array.from({ length: 500 }, () => ({ type: "script" }));
    const result = parseBlocks(blocks);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.length).toBe(MAX_VALIDATION_ISSUES);
  });

  it("keeps judging values after the issue list is full", () => {
    // Once the list holds MAX_VALIDATION_ISSUES, later invalid values must still count as invalid and never throw.
    const invalid = { type: "paragraph", content: [{ type: "text", text: "" }] };
    for (const length of [MAX_VALIDATION_ISSUES - 1, MAX_VALIDATION_ISSUES, MAX_VALIDATION_ISSUES + 1, 500]) {
      const result = parseBlocks(Array.from({ length }, () => invalid));
      expect(result.ok, `length ${length}`).toBe(false);
      expect(!result.ok && result.errors.length).toBeLessThanOrEqual(MAX_VALIDATION_ISSUES);
    }
    const mixed = [...Array.from({ length: 150 }, () => ({ type: "script" })), invalid, { type: "divider" }];
    expect(parseBlocks(mixed).ok).toBe(false);
  });

  it("rejects non-objects at the top level", () => {
    for (const input of [null, [], "doc", 1, undefined]) {
      expect(parsePublishedDoc(input).ok).toBe(false);
      expect(parsePublishedIndex(input).ok).toBe(false);
      expect(parseGoneBody(input).ok).toBe(false);
    }
  });

  it("requires the gone code for parseGoneBody", () => {
    const body = { error: { code: "not_found", requestId: "req_1", retryable: false } };
    expect(parseGoneBody(body)).toEqual({ ok: false, errors: [{ path: "$.error.code", reason: "enum" }] });
  });

  it("runs every validator scenario without throwing", () => {
    for (const run of Object.values(validatorScenarios)) expect(() => run()).not.toThrow();
  });
});

describe("blocks", () => {
  it("accept every block, inline and mark of the AST", () => {
    const result = parseBlocks(fixtures.doc.blocks, fixtures.doc.assets);
    expect(result.ok).toBe(true);
  });

  it("only allow paragraphs and lists in a note, and flat lists", () => {
    const note = (child: unknown): unknown => [{ type: "note", blocks: [child] }];
    expect(parseBlocks(note({ type: "list", ordered: true, items: [[{ type: "text", text: "a" }]] })).ok).toBe(true);
    expect(parseBlocks(note({ type: "quote", content: [{ type: "text", text: "a" }] })).ok).toBe(false);
    expect(parseBlocks(note({ type: "divider" })).ok).toBe(false);
    expect(parseBlocks([{ type: "list", ordered: false, items: [] }]).ok).toBe(false);
    expect(parseBlocks([{ type: "list", ordered: "yes", items: [[{ type: "text", text: "a" }]] }]).ok).toBe(false);
  });

  it("count characters of hrefs and captions toward the block limit", () => {
    const href = `https://example.com/${"a".repeat(19_990)}`;
    const blocks: Block[] = [{ type: "paragraph", content: [{ type: "text", text: "0123456789", marks: [{ type: "link", href }] }] }];
    const result = parseBlocks(blocks);
    expect(!result.ok && result.errors.map((issue) => issue.reason)).toEqual(["block-too-long"]);
  });

  it("counts astral characters once", () => {
    const blocks: Block[] = [{ type: "paragraph", content: [{ type: "text", text: "😀".repeat(20_000) }] }];
    expect(parseBlocks(blocks).ok).toBe(true);
  });

  it("rejects lone surrogates and line separators", () => {
    for (const text of ["\ud800", "a\u2028b", "a\u0000b", "a\u007fb"]) {
      const result = parseBlocks([{ type: "paragraph", content: [{ type: "text", text }] }]);
      expect(!result.ok && result.errors[0]?.reason).toBe("control-character");
    }
  });
});

describe("URL predicates", () => {
  const credentialUrl = ["https://", "name", ":", "secret", "@", "example.com/"].join("");

  it("accept https URLs and site paths for links", () => {
    for (const href of [
      "https://example.com",
      "https://example.com/a_b/(c)?q=1&r=2#frag",
      "https://example.com:8443/x",
      "/",
      "/guides/morning-walk",
      "/a%20b?x=1#y",
    ]) {
      expect(isSafeLinkHref(href)).toBe(true);
    }
  });

  it("reject every scheme and shape the spec forbids", () => {
    for (const href of [
      "http://example.com/",
      "HTTPS://example.com/",
      "mailto:someone@example.com",
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,hi",
      "vbscript:x",
      "file:///etc/hosts",
      "//example.com/",
      "/\\example.com/",
      "\\\\example.com",
      "/\t/example.com",
      "https://user@example.com/",
      "https://@example.com/",
      credentialUrl,
      "https:///path",
      "https://",
      "relative/path",
      "#fragment",
      "?q=1",
      "/a b",
      "/a<b",
      "/a>b",
      "/a\"b",
      "/a'b",
      "/a`b",
      "/a%zz",
      "/&#47;example.com",
      "/&sol;example.com",
      "https://例え.example.com/",
      "/パス",
      "",
    ]) {
      expect(isSafeLinkHref(href)).toBe(false);
    }
  });

  it("allow only https for images, assets and canonical URLs", () => {
    expect(isHttpsUrl("https://assets.example.com/a.jpg")).toBe(true);
    expect(isHttpsUrl("/a.jpg")).toBe(false);
    expect(isHttpsUrl("http://assets.example.com/a.jpg")).toBe(false);
    expect(isSitePath("/a.jpg")).toBe(true);
    expect(isSitePath("https://assets.example.com/a.jpg")).toBe(false);
  });
});

describe("index ordering", () => {
  it("accepts the fixture order and rejects a reversed one", () => {
    const index = readJson<{ items: unknown[] }>("fixtures/published-index.json");
    expect(parsePublishedIndex({ ...index, items: [...index.items].reverse() }).ok).toBe(false);
  });

  it("rejects more than the maximum page size", () => {
    const index = readJson<{ items: unknown[] }>("fixtures/published-index.json");
    const first = index.items[0];
    const result = parsePublishedIndex({ ...index, items: Array.from({ length: 101 }, () => first) });
    expect(result).toEqual({ ok: false, errors: [{ path: "$.items", reason: "too-many-items" }] });
  });
});
