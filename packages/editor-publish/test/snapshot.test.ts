import { parsePublishedDoc, type Block } from "@niho/editor-publish-contract";
import { describe, expect, it } from "vitest";
import {
  buildSnapshot,
  contentFingerprint,
  draftFingerprint,
  toPublishedBlocks,
  type AssetRecord,
  type DraftPage,
  type SnapshotInput,
} from "../src/index.js";
import { memoryAssetUrls } from "../test-support/memory-store.js";
import { AUDIO, COVER, FIGURE, PAGE_ID, asset, readFixture, readyPage } from "./support/world.js";

interface Expected {
  blocks: Block[];
  figures: { assetId: string; alt: string | null }[];
  problems: unknown[];
  notices: string[];
  markdown: string;
}

const article = readFixture<unknown>("fixtures/tiptap/article.json");
const rich = readFixture<unknown>("fixtures/tiptap/rich.json");
const unknownNodes = readFixture<unknown>("fixtures/tiptap/unknown.json");
const expected = readFixture<Expected>("fixtures/tiptap/article.expected.json");

const doc = (...content: unknown[]): unknown => ({ type: "doc", content });
const p = (...content: unknown[]): unknown => ({ type: "paragraph", content });
const t = (text: string, marks?: unknown[]): unknown => (marks ? { type: "text", text, marks } : { type: "text", text });
const link = (href: string): unknown => ({ type: "link", attrs: { href } });

function input(page: DraftPage, patch: Partial<SnapshotInput> = {}, assets: readonly AssetRecord[] = [COVER, FIGURE, AUDIO]): SnapshotInput {
  return {
    page,
    assets,
    dest: "niho",
    slug: "a-morning-walk",
    canonicalUrl: "https://niho.example.com/article/a-morning-walk",
    range: "live",
    extras: { app: true, news: false, xp: false },
    category: "walks",
    related: [],
    author: { name: "Example Writer", handle: "example-writer", url: "https://writer.example.com/" },
    version: 1,
    publishedAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    assetUrls: memoryAssetUrls(),
    ...patch,
  };
}

async function build(page: DraftPage, patch: Partial<SnapshotInput> = {}, assets?: readonly AssetRecord[]) {
  return buildSnapshot(input(page, patch, assets));
}

describe("toPublishedBlocks: conversion table (golden)", () => {
  it("converts the article sample exactly", () => {
    const conversion = toPublishedBlocks(article);
    expect(conversion.blocks).toEqual(expected.blocks);
    expect(conversion.figures).toEqual(expected.figures);
    expect(conversion.problems).toEqual(expected.problems);
    expect(conversion.notices.map((notice) => notice.id)).toEqual(expected.notices);
  });

  it("projects the golden blocks to the expected Markdown", async () => {
    const figure = asset("asset-figure-01", { sha256: "1".repeat(64), alt: "unused", credit: null });
    const result = await build(readyPage({ content: article, coverAssetId: null }), {}, [figure]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.markdown).toBe(expected.markdown);
    expect(result.snapshot.assets).toEqual([
      { id: "asset-figure-01", url: `https://assets.example.com/a/${"1".repeat(64)}`, contentType: "image/jpeg", bytes: 120_000, sha256: "1".repeat(64), alt: "Fishing boats in the harbor", credit: null },
    ]);
  });

  it("keeps quote, divider, strike, code and site-path links", () => {
    expect(toPublishedBlocks(rich).blocks).toEqual([
      { type: "heading", level: 2, content: [{ type: "text", text: "Notes" }] },
      { type: "quote", content: [{ type: "text", text: "The sea is calm before nine." }] },
      { type: "quote", content: [{ type: "text", text: "Locals swim early." }] },
      { type: "divider" },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Old menu", marks: [{ type: "strike" }] },
          { type: "text", text: " uses " },
          { type: "text", text: "code_name", marks: [{ type: "code" }] },
          { type: "text", text: " and " },
          { type: "text", text: "a site path", marks: [{ type: "link", href: "/maps/harbor" }] },
        ],
      },
    ]);
  });

  it("rounds heading levels: 1→2, 2→2, 3→3, 4+→3, missing→2", () => {
    const heading = (level: unknown) => ({ type: "heading", attrs: { level }, content: [t("H")] });
    const levels = toPublishedBlocks(doc(heading(1), heading(2), heading(3), heading(4), heading(6), heading(undefined), heading("3"))).blocks
      .map((block) => (block.type === "heading" ? block.level : null));
    expect(levels).toEqual([2, 2, 3, 3, 3, 2, 2]);
  });

  it("flattens nested lists into one level, keeping the outer list's kind", () => {
    const item = (...content: unknown[]) => ({ type: "listItem", content });
    const conversion = toPublishedBlocks(doc({
      type: "orderedList",
      content: [
        item(p(t("one")), { type: "bulletList", content: [item(p(t("one-a")), { type: "orderedList", content: [item(p(t("one-a-i")))] })] }),
        item(p(t("two")), p(t("continued"))),
        item(p()),
      ],
    }));
    expect(conversion.blocks).toEqual([{
      type: "list",
      ordered: true,
      items: [[t("one")], [t("one-a")], [t("one-a-i")], [t("two continued")]],
    }]);
    expect(conversion.notices.map((notice) => notice.id)).toEqual(["list-flattened"]);
  });

  it("turns a hardBreak into a space and merges equal runs", () => {
    expect(toPublishedBlocks(doc(p(t("a"), { type: "hardBreak" }, t("b"), { type: "hardBreak" }, t("c", [{ type: "bold" }])))).blocks).toEqual([
      { type: "paragraph", content: [t("a b "), t("c", [{ type: "bold" }])] },
    ]);
  });

  it("drops empty paragraphs, whitespace-only paragraphs and empty notes / lists", () => {
    const conversion = toPublishedBlocks(doc(p(), p(t("  ")), { type: "paragraph" }, { type: "note", content: [p()] }, { type: "bulletList", content: [] }, p(t("kept"))));
    expect(conversion.blocks).toEqual([{ type: "paragraph", content: [t("kept")] }]);
    expect(conversion.problems).toEqual([]);
  });

  it("normalizes line breaks and control characters inside text", () => {
    expect(toPublishedBlocks(doc(p(t("a\nb\tc\u0000d e")))).blocks).toEqual([{ type: "paragraph", content: [t("a b cd e")] }]);
  });

  it("accepts the top-level node list as well as the doc node; null is an empty body", () => {
    expect(toPublishedBlocks([p(t("x"))]).blocks).toEqual([{ type: "paragraph", content: [t("x")] }]);
    expect(toPublishedBlocks(null)).toEqual({ blocks: [], figures: [], problems: [], notices: [] });
  });
});

describe("toPublishedBlocks: CONFIRM", () => {
  it("detects [CONFIRM: …] in text and confirm nodes (inline and block)", () => {
    const conversion = toPublishedBlocks(doc(
      p(t("Hours [CONFIRM: winter] and [CONFIRM:] and [CONFIRM:  spaced  ]", [{ type: "bold" }])),
      { type: "confirm", attrs: { text: "block-level" } },
      p({ type: "confirm", content: [t("from content")] }),
    ));
    expect(conversion.blocks).toEqual([
      {
        type: "paragraph",
        content: [
          t("Hours ", [{ type: "bold" }]),
          { type: "confirm", text: "winter" },
          t(" and ", [{ type: "bold" }]),
          { type: "confirm", text: "…" },
          t(" and ", [{ type: "bold" }]),
          { type: "confirm", text: "spaced" },
        ],
      },
      { type: "paragraph", content: [{ type: "confirm", text: "block-level" }] },
      { type: "paragraph", content: [{ type: "confirm", text: "from content" }] },
    ]);
  });
});

describe("toPublishedBlocks: CONFIRM split across text nodes", () => {
  it("finds a marker that formatting split into several nodes and keeps the marks of the text around it", () => {
    const conversion = toPublishedBlocks(doc(
      p(t("Open ", [{ type: "italic" }]), t("[CONFIRM: ", [{ type: "bold" }]), t("hours", [{ type: "code" }]), t("] daily"), t(" and [CONFIRM:", [{ type: "bold" }]), t(" b]")),
    ));
    expect(conversion.problems).toEqual([]);
    expect(conversion.blocks).toEqual([
      {
        type: "paragraph",
        content: [
          t("Open ", [{ type: "italic" }]),
          { type: "confirm", text: "hours" },
          t(" daily"),
          t(" and ", [{ type: "bold" }]),
          { type: "confirm", text: "b" },
        ],
      },
    ]);
  });

  it("leaves an unclosed marker as plain text", () => {
    const conversion = toPublishedBlocks(doc(p(t("Price [CONFIRM: "), t("later", [{ type: "bold" }]))));
    expect(conversion.blocks).toEqual([
      { type: "paragraph", content: [t("Price [CONFIRM: "), t("later", [{ type: "bold" }])] },
    ]);
  });
});

describe("toPublishedBlocks: never drops unknown nodes silently", () => {
  it("reports every unknown node as a problem (fix: body) and an image inside a list as misplaced", () => {
    const conversion = toPublishedBlocks(unknownNodes);
    expect(conversion.problems).toEqual([
      { id: "unknown-node", message: "公開版にできない要素があります", fix: "body", node: "codeBlock" },
      { id: "unknown-node", message: "公開版にできない要素があります", fix: "body", node: "table" },
      { id: "unknown-node", message: "公開版にできない要素があります", fix: "body", node: "mention" },
      { id: "misplaced-image", message: "箇条書きや囲みの中の写真は公開版に入れられません", fix: "body", node: "image" },
      { id: "unknown-node", message: "公開版にできない要素があります", fix: "body", node: "taskItem" },
    ]);
  });

  it("reports a node with an unsafe type name without echoing it", () => {
    const conversion = toPublishedBlocks(doc({ type: "<script>" }, { content: [] }, "text", 42));
    expect(conversion.problems.map((problem) => problem.node)).toEqual(["?"]);
    expect(JSON.stringify(conversion)).not.toContain("<script>");
  });

  it("drops recordings on purpose with a notice", () => {
    const conversion = toPublishedBlocks(doc(p(t("x")), { type: "recording", attrs: { assetId: "asset-audio-01" } }, { type: "audio" }));
    expect(conversion.blocks).toEqual([{ type: "paragraph", content: [t("x")] }]);
    expect(conversion.problems).toEqual([]);
    expect(conversion.notices).toEqual([{ id: "recording-dropped", message: "録音は公開版に含まれません" }]);
  });

  it("refuses to build a snapshot from a body with problems", async () => {
    const result = await build(readyPage({ content: unknownNodes }));
    expect(result).toMatchObject({ ok: false, reason: "snapshot_invalid" });
  });

  it("drops other formatting with a notice", () => {
    const conversion = toPublishedBlocks(doc(p(t("x", [{ type: "underline" }, { type: "highlight" }, { type: "bold" }, { type: "bold" }]))));
    expect(conversion.blocks).toEqual([{ type: "paragraph", content: [t("x", [{ type: "bold" }])] }]);
    expect(conversion.notices.map((notice) => notice.id)).toEqual(["format-dropped"]);
  });

  it("drops the editor's ai mark without a notice and joins the text it split", () => {
    const conversion = toPublishedBlocks(doc(p(t("前の"), t("AI の語", [{ type: "ai" }]), t("太字", [{ type: "bold" }, { type: "ai" }]), t("後"))));
    expect(conversion.blocks).toEqual([{ type: "paragraph", content: [t("前のAI の語"), t("太字", [{ type: "bold" }]), t("後")] }]);
    expect(conversion.notices).toEqual([]);
  });
});

describe("toPublishedBlocks: links", () => {
  const credentialUrl = ["https://", "user:pw", "@", "maps.example.com/"].join("");
  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["http:", "http://maps.example.com/"],
    ["mailto:", "mailto:someone@example.com"],
    ["data:", "data:text/html,x"],
    ["protocol-relative", "//maps.example.com/"],
    ["credentials", credentialUrl],
    ["not a string", 42],
  ])("drops a %s link mark but keeps the text", (_name, href) => {
    const conversion = toPublishedBlocks(doc(p(t("map", [link(href as string), { type: "italic" }]))));
    expect(conversion.blocks).toEqual([{ type: "paragraph", content: [t("map", [{ type: "italic" }])] }]);
    expect(conversion.notices.map((notice) => notice.id)).toEqual(["link-dropped"]);
  });

  it("keeps https and site-path links", () => {
    const conversion = toPublishedBlocks(doc(p(t("a", [link("https://maps.example.com/x?y=1#z")]), t(" "), t("b", [link("/guides/x")]))));
    expect(conversion.notices).toEqual([]);
    expect(conversion.blocks).toHaveLength(1);
  });
});

describe("buildSnapshot", () => {
  it("builds a PublishedDoc that passes the contract with requireProjection", async () => {
    const result = await build(readyPage());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { fingerprint, ...published } = result.snapshot;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(parsePublishedDoc(published, { requireProjection: true }).ok).toBe(true);
    expect(published.id).toBe(PAGE_ID);
    expect(published.cover?.id).toBe(COVER.id);
    expect(published.assets.map((entry) => entry.id)).toEqual([FIGURE.id]);
    expect(published.assets[0]?.alt).toBe("Fishing boats in the harbor");
  });

  it("is deeply frozen and does not freeze its inputs", async () => {
    const author = { name: "Example Writer", handle: null, url: null };
    const result = await build(readyPage(), { author });
    if (!result.ok) throw new Error("expected ok");
    const snapshot = result.snapshot;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.blocks)).toBe(true);
    expect(Object.isFrozen(snapshot.blocks[0])).toBe(true);
    expect(Object.isFrozen(snapshot.assets[0])).toBe(true);
    expect(Object.isFrozen(snapshot.author)).toBe(true);
    expect(() => {
      (snapshot as { title: string }).title = "changed";
    }).toThrow(TypeError);
    expect(Object.isFrozen(author)).toBe(false);
  });

  it.each([
    ["the figure's asset is missing", [COVER, AUDIO], "$.assets[0]", "missing"],
    ["the figure is a recording", [COVER, { ...FIGURE, kind: "audio", contentType: "audio/mp4" }], "$.assets[0]", "unusable"],
    ["the figure is an SVG", [COVER, { ...FIGURE, contentType: "image/svg+xml" }], "$.assets[0]", "unusable"],
    ["the figure has no consent", [COVER, { ...FIGURE, consent: false }], "$.assets[0]", "no-consent"],
    ["the cover is missing", [FIGURE], "$.cover", "missing"],
    ["the cover has no consent", [{ ...COVER, consent: false }, FIGURE], "$.cover", "no-consent"],
    ["the cover has a broken hash", [{ ...COVER, sha256: "xyz" }, FIGURE], "$.cover", "unusable"],
  ] as const)("fails when %s", async (_name, assets, path, reason) => {
    const result = await build(readyPage(), {}, assets as readonly AssetRecord[]);
    expect(result).toEqual({ ok: false, reason: "snapshot_invalid", issues: [{ path, reason }] });
  });

  it("fails when the asset store returns a non-https URL", async () => {
    const result = await build(readyPage(), { assetUrls: { urlFor: () => "http://assets.example.com/a/x.jpg" } });
    expect(result).toEqual({
      ok: false,
      reason: "snapshot_invalid",
      issues: [{ path: "$.assets[0].url", reason: "unsafe-url" }, { path: "$.cover.url", reason: "unsafe-url" }],
    });
  });

  it.each([
    ["a blank author name", { author: { name: " ", handle: null, url: null } }, "$.author.name"],
    ["an http canonical URL", { canonicalUrl: "http://niho.example.com/article/x" }, "$.canonicalUrl"],
    ["updatedAt before publishedAt", { updatedAt: "2026-09-01T00:00:00.000Z" }, "$.updatedAt"],
    ["a malformed timestamp", { publishedAt: "2026-10-01 09:00" }, "$.publishedAt"],
    ["an invalid slug", { slug: "Not A Slug" }, "$.slug"],
    ["limited release on a site", { dest: "site", range: "unlisted" }, "$.range"],
    ["a duplicate related slug", { related: ["a", "a"] }, "$.related[1]"],
  ] as const)("fails the contract's self-check on %s", async (_name, patch, path) => {
    const result = await build(readyPage(), patch as Partial<SnapshotInput>);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("snapshot_invalid");
    expect(result.issues.map((issue) => issue.path)).toContain(path);
  });

  it("fails on an empty title (the contract needs a non-blank title)", async () => {
    const result = await build(readyPage({ title: "  " }));
    expect(result).toMatchObject({ ok: false, reason: "snapshot_invalid" });
  });

  it("trims title and lead and turns a blank lead into null", async () => {
    const result = await build(readyPage({ title: "  Walk\n", lead: "   " }));
    if (!result.ok) throw new Error("expected ok");
    expect(result.snapshot.title).toBe("Walk");
    expect(result.snapshot.lead).toBeNull();
  });
});

describe("fingerprint: 「更新あり」 is a content difference, not a save time", () => {
  const assets = [COVER, FIGURE, AUDIO];

  it("equals the published version's fingerprint for an unchanged draft", async () => {
    const page = readyPage();
    const result = await build(page);
    if (!result.ok) throw new Error("expected ok");
    expect(await draftFingerprint(page, assets)).toBe(result.snapshot.fingerprint);
  });

  it("changes with the content and comes back when the edit is undone", async () => {
    const page = readyPage();
    const original = await draftFingerprint(page, assets);
    const edited = await draftFingerprint({ ...page, title: "A different walk" }, assets);
    expect(edited).not.toBe(original);
    expect(await draftFingerprint({ ...page, title: "A morning walk along the coast" }, assets)).toBe(original);
  });

  it("ignores what does not reach the published content", async () => {
    const page = readyPage();
    const original = await draftFingerprint(page, assets);
    const content = readyPage().content as { content: unknown[] };
    const padded = { ...content, content: [...content.content, p(), p(t("   ")), { type: "recording" }] };
    expect(await draftFingerprint({ ...page, content: padded }, assets)).toBe(original);
    expect(await draftFingerprint({ ...page, title: `  ${page.title}  ` }, assets)).toBe(original);
    expect(await draftFingerprint(page, [...assets, asset("asset-unused", { sha256: "d".repeat(64) })])).toBe(original);
  });

  it("does not depend on settings, destination, time or asset URLs", async () => {
    const page = readyPage();
    const one = await build(page);
    const two = await build(page, { dest: "exp", category: "food", related: ["x"], version: 7, updatedAt: "2026-10-02T00:00:00.000Z", assetUrls: memoryAssetUrls("cdn.example.net") });
    if (!one.ok || !two.ok) throw new Error("expected ok");
    expect(one.snapshot.fingerprint).toBe(two.snapshot.fingerprint);
  });

  it("changes with photo metadata that is published (credit, alt, file)", async () => {
    const page = readyPage();
    const original = await draftFingerprint(page, assets);
    expect(await draftFingerprint(page, [COVER, { ...FIGURE, credit: "Studio" }, AUDIO])).not.toBe(original);
    expect(await draftFingerprint(page, [{ ...COVER, alt: "Another alt" }, FIGURE, AUDIO])).not.toBe(original);
    expect(await draftFingerprint(page, [COVER, { ...FIGURE, sha256: "e".repeat(64) }, AUDIO])).not.toBe(original);
  });

  it("differs while a draft has an unresolved node", async () => {
    const page = readyPage();
    const content = page.content as { content: unknown[] };
    const withCode = { ...content, content: [...content.content, { type: "codeBlock" }] };
    expect(await draftFingerprint({ ...page, content: withCode }, assets)).not.toBe(await draftFingerprint(page, assets));
  });

  it("is the SHA-256 of the canonical normalized content", async () => {
    const value = await contentFingerprint({ title: "x", lang: "en", lead: null, cover: null, blocks: [], figures: [], unresolved: [] });
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(await contentFingerprint({ unresolved: [], figures: [], blocks: [], cover: null, lead: null, lang: "en", title: "x" })).toBe(value);
  });
});

describe("category display snapshot", () => {
  it("freezes server-provided category labels and revision without changing the category slug", async () => {
    const categoryDisplay = { labelEn: "Walks", labelJa: "散策", displayOrder: 4, revision: 7 };
    const result = await build(readyPage(), { dest: "exp", category: "walks", categoryDisplay });
    if (!result.ok) throw new Error("expected ok");
    expect(result.snapshot.category).toBe("walks");
    expect(result.snapshot.categoryDisplay).toEqual(categoryDisplay);
    expect(parsePublishedDoc(result.snapshot).ok).toBe(true);
  });
});

describe("cover share permission (coverShareable)", () => {
  it("is true only when the cover has both 掲載許諾 and the share permission", async () => {
    const shared = await build(readyPage(), {}, [{ ...COVER, share: true }, FIGURE, AUDIO]);
    if (!shared.ok) throw new Error("expected ok");
    expect(shared.snapshot.coverShareable).toBe(true);
    expect(parsePublishedDoc(shared.snapshot, { requireProjection: true }).ok).toBe(true);
  });

  it.each([
    ["share is false", [{ ...COVER, share: false }, FIGURE, AUDIO]],
    ["share was never set (an asset from before the field)", [COVER, FIGURE, AUDIO]],
    ["only a body figure has share", [COVER, { ...FIGURE, share: true }, AUDIO]],
  ] as const)("leaves the field out (never false) when %s", async (_name, assets) => {
    const result = await build(readyPage(), {}, assets);
    if (!result.ok) throw new Error("expected ok");
    expect("coverShareable" in result.snapshot).toBe(false);
  });

  it("leaves the field out without a cover", async () => {
    const result = await build(readyPage({ coverAssetId: null }), {}, [{ ...COVER, share: true }, FIGURE, AUDIO]);
    if (!result.ok) throw new Error("expected ok");
    expect("coverShareable" in result.snapshot).toBe(false);
  });

  it("keeps the fingerprint of pages without the permission exactly as before, and marks a change when it is given", async () => {
    const page = readyPage();
    const assets = [COVER, FIGURE, AUDIO];
    const before = await draftFingerprint(page, assets);
    // The fingerprint input without the field is the one used before `share` existed.
    const conversion = toPublishedBlocks(page.content);
    const legacy = await contentFingerprint({
      title: "A morning walk along the coast",
      lang: "en",
      lead: "Start early, follow the shoreline, and stop for tea.",
      cover: { id: COVER.id, sha256: COVER.sha256, contentType: COVER.contentType, bytes: COVER.bytes, alt: "Shoreline at sunrise", credit: "Example Photo Studio" },
      blocks: conversion.blocks,
      figures: [{ id: FIGURE.id, sha256: FIGURE.sha256, contentType: FIGURE.contentType, bytes: FIGURE.bytes, alt: "Fishing boats in the harbor", credit: null }],
      unresolved: [],
    });
    expect(before).toBe(legacy);
    expect(await draftFingerprint(page, [{ ...COVER, share: false }, FIGURE, AUDIO])).toBe(before);
    // Share without 掲載許諾 is not a share permission (and not a content change).
    expect(await draftFingerprint(page, [{ ...COVER, consent: false, share: true }, FIGURE, AUDIO])).toBe(before);
    const shared = await draftFingerprint(page, [{ ...COVER, share: true }, FIGURE, AUDIO]);
    expect(shared).not.toBe(before);
    const published = await build(page, {}, [{ ...COVER, share: true }, FIGURE, AUDIO]);
    if (!published.ok) throw new Error("expected ok");
    expect(published.snapshot.fingerprint).toBe(shared);
  });
});

describe("author profile snapshot (authorProfile)", () => {
  it("fixes the role and bio at the top level, cleaned to single lines", async () => {
    const result = await build(readyPage(), { authorProfile: { role: "  Coastal walk guide ", bio: "Writes about\nmornings by the sea." } });
    if (!result.ok) throw new Error("expected ok");
    expect(result.snapshot.authorProfile).toEqual({ role: "Coastal walk guide", bio: "Writes about mornings by the sea." });
    expect(result.snapshot.author).toEqual({ name: "Example Writer", handle: "example-writer", url: "https://writer.example.com/" });
    expect(parsePublishedDoc(result.snapshot, { requireProjection: true }).ok).toBe(true);
  });

  it("keeps a lone role or a lone bio, with the other null", async () => {
    const result = await build(readyPage(), { authorProfile: { role: null, bio: "Writes about the sea." } });
    if (!result.ok) throw new Error("expected ok");
    expect(result.snapshot.authorProfile).toEqual({ role: null, bio: "Writes about the sea." });
  });

  it.each([
    ["no profile", undefined],
    ["a null profile", null],
    ["both null", { role: null, bio: null }],
    ["both blank", { role: "  ", bio: "\n" }],
  ] as const)("leaves the field out for %s", async (_name, authorProfile) => {
    const result = await build(readyPage(), authorProfile === undefined ? {} : { authorProfile });
    if (!result.ok) throw new Error("expected ok");
    expect("authorProfile" in result.snapshot).toBe(false);
  });

  it("is not content: the fingerprint does not change with the profile", async () => {
    const plain = await build(readyPage());
    const profiled = await build(readyPage(), { authorProfile: { role: "Guide", bio: null } });
    if (!plain.ok || !profiled.ok) throw new Error("expected ok");
    expect(profiled.snapshot.fingerprint).toBe(plain.snapshot.fingerprint);
  });

  it("fails rather than truncating a profile over the contract's limits", async () => {
    const result = await build(readyPage(), { authorProfile: { role: "r".repeat(121), bio: null } });
    expect(result.ok).toBe(false);
  });
});
