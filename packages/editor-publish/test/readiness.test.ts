import { describe, expect, it } from "vitest";
import {
  collectFacts,
  evaluateReadiness,
  parseDestinationDeclaration,
  type AssetRecord,
  type DestinationDeclaration,
  type DraftPage,
  type FactChoices,
  type ServerFacts,
} from "../src/index.js";
import { AUDIO, COVER, DECLARATIONS, FIGURE, readyContent, readyPage } from "./support/world.js";

function declaration(name: keyof typeof DECLARATIONS): DestinationDeclaration {
  const result = parseDestinationDeclaration(DECLARATIONS[name]);
  if (!result.ok) throw new Error("fixture rejected");
  return result.value;
}

const EXP = declaration("exp");
const NIHO = declaration("niho");
const SITE = declaration("site");
const ASSETS: readonly AssetRecord[] = [COVER, FIGURE, AUDIO];
const EXP_CHOICES: FactChoices = { category: "walks", related: ["coastal-tea-ceremony"] };
const NIHO_CHOICES: FactChoices = { category: "essay", related: [] };

function evaluate(
  target: DestinationDeclaration,
  page: Partial<DraftPage> = {},
  options: { assets?: readonly AssetRecord[]; facts?: ServerFacts; choices?: FactChoices } = {},
) {
  const facts = collectFacts(readyPage(page), options.assets ?? ASSETS, options.facts ?? { relatedLive: true }, options.choices ?? (target === EXP ? EXP_CHOICES : NIHO_CHOICES));
  return evaluateReadiness(target, facts);
}

const ids = (result: { problems: readonly { id: string }[] }) => result.problems.map((problem) => problem.id);

const bodyWith = (...extra: unknown[]): unknown => {
  const content = readyContent() as { type: string; content: unknown[] };
  return { ...content, content: [...content.content, ...extra] };
};

describe("evaluateReadiness: NIHO Experience", () => {
  it("is ready when every condition holds", () => {
    const result = evaluate(EXP);
    expect(result).toEqual({ ready: true, problems: [], notices: [{ id: "recording-dropped", message: "録音は公開版に含まれません" }] });
  });

  it.each([
    ["Japanese page", { lang: "ja" as const }, {}, ["lang-en"]],
    ["no cover", { coverAssetId: null }, {}, ["cover"]],
    ["no lead", { lead: null }, {}, ["lead"]],
    ["blank lead", { lead: "   " }, {}, ["lead"]],
    ["lead over 200 characters", { lead: "あ".repeat(201) }, {}, ["lead"]],
    ["no heading", { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Only text." }] }] } }, {}, ["headings"]],
    ["CONFIRM in the body", { content: bodyWith({ type: "paragraph", content: [{ type: "text", text: "Hours [CONFIRM: winter]" }] }) }, {}, ["no-confirm"]],
    ["CONFIRM split across formatted text nodes", { content: bodyWith({ type: "paragraph", content: [{ type: "text", text: "Hours [CONFIRM: " }, { type: "text", text: "winter", marks: [{ type: "bold" }] }, { type: "text", text: "]" }] }) }, {}, ["no-confirm"]],
    ["confirm node in the body", { content: bodyWith({ type: "paragraph", content: [{ type: "confirm", attrs: { text: "price" } }] }) }, {}, ["no-confirm"]],
    ["CONFIRM in the title", { title: "Walk [CONFIRM: name]" }, {}, ["no-confirm"]],
    ["CONFIRM in the lead", { lead: "Start [CONFIRM: time]" }, {}, ["no-confirm"]],
  ] as const)("reports %s", (_name, page, options, expected) => {
    expect(ids(evaluate(EXP, page as Partial<DraftPage>, options))).toEqual(expected);
  });

  it("accepts a lead of exactly 200 characters", () => {
    expect(evaluate(EXP, { lead: "あ".repeat(200) }).ready).toBe(true);
  });

  it("requires consent on the cover", () => {
    const result = evaluate(EXP, {}, { assets: [{ ...COVER, consent: false }, FIGURE, AUDIO] });
    expect(ids(result)).toEqual(["cover"]);
    expect(result.problems[0]).toEqual({ id: "cover", message: "掲載許諾のあるカバー写真を選んでください", fix: "cover" });
  });

  it.each([
    ["no category", { category: null, related: ["x"] }, ["category"]],
    ["a category outside oneOf", { category: "nightlife", related: ["x"] }, ["category"]],
    ["no related experience", { category: "walks", related: [] }, ["related-live"]],
  ] as const)("reports %s", (_name, choices, expected) => {
    expect(ids(evaluate(EXP, {}, { choices }))).toEqual(expected);
  });

  it.each([
    ["false", false],
    ["null (unknown)", null],
  ] as const)("does not count related experiences as live when the server says %s", (_name, relatedLive) => {
    expect(ids(evaluate(EXP, {}, { facts: { relatedLive } }))).toEqual(["related-live"]);
  });

  it("refuses blocks and marks outside accepts (quote, divider, strike, code)", () => {
    const result = evaluate(EXP, {
      content: bodyWith(
        { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Quoted" }] }] },
        { type: "horizontalRule" },
        { type: "paragraph", content: [{ type: "text", text: "old", marks: [{ type: "strike" }] }, { type: "text", text: "x", marks: [{ type: "code" }] }] },
      ),
    });
    expect(ids(result)).toEqual(["accepts-block-quote", "accepts-block-divider", "accepts-mark-strike", "accepts-mark-code"]);
    expect(result.problems[0]).toEqual({ id: "accepts-block-quote", message: "この発信先は引用を受けません", fix: "body" });
  });

  it("puts problems in a stable order: built-in first, then requires in declaration order", () => {
    const result = evaluate(EXP, { title: "", lang: "ja", lead: null, coverAssetId: null }, { choices: { category: null, related: [] } });
    expect(ids(result)).toEqual(["title", "lang-en", "cover", "lead", "category", "related-live"]);
  });
});

describe("evaluateReadiness: NIHO", () => {
  it("is ready with cover, lead and category", () => {
    expect(evaluate(NIHO).ready).toBe(true);
  });

  it("accepts quote and divider", () => {
    const result = evaluate(NIHO, { content: bodyWith({ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Quoted" }] }] }, { type: "horizontalRule" }) });
    expect(result.ready).toBe(true);
  });

  it.each([
    ["no cover", { coverAssetId: null }, {}, ["cover"]],
    ["no lead", { lead: null }, {}, ["lead"]],
    ["no category", {}, { choices: { category: null, related: [] } }, ["category"]],
    ["a blank category", {}, { choices: { category: "  ", related: [] } }, ["category"]],
  ] as const)("reports %s", (_name, page, options, expected) => {
    expect(ids(evaluate(NIHO, page, options))).toEqual(expected);
  });

  it("does not need consent in the declaration but never publishes a cover without consent", () => {
    const result = evaluate(NIHO, {}, { assets: [{ ...COVER, consent: false }, FIGURE, AUDIO] });
    expect(result.problems).toEqual([{ id: "cover-consent", message: "カバー写真に掲載許諾がありません", fix: "cover" }]);
  });

  it("does not care about CONFIRM, language or headings", () => {
    const result = evaluate(NIHO, { lang: "ja", title: "鎌倉の朝 [CONFIRM: 店名]", content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "本文 [CONFIRM: 時間]" }] }] } });
    expect(result.ready).toBe(true);
  });
});

describe("evaluateReadiness: an owner's site (no requires)", () => {
  it("only needs a title and a body", () => {
    expect(evaluate(SITE, { coverAssetId: null, lead: null, lang: "ja" }, { choices: { category: null, related: [] } }).ready).toBe(true);
  });

  it.each([
    ["an empty title", { title: "  " }, ["title"]],
    ["an empty body", { content: { type: "doc", content: [{ type: "paragraph" }] } }, ["body"]],
    ["a body that is only a recording", { content: [{ type: "recording" }] }, ["body"]],
  ] as const)("reports %s", (_name, page, expected) => {
    expect(ids(evaluate(SITE, page as Partial<DraftPage>, { choices: { category: null, related: [] } }))).toEqual(expected);
  });
});

describe("工程の最終段階名を題名にしたページ", () => {
  const facts = { relatedLive: true, finalStepNames: ["旧・記事本文", "記事本文"] };

  it("通常の題名は通し、空欄は空欄の問題だけを返す", () => {
    expect(ids(evaluate(SITE, { title: "海辺の朝" }, { facts }))).toEqual([]);
    expect(ids(evaluate(SITE, { title: "   " }, { facts }))).toEqual(["title"]);
  });

  it.each([["exp", EXP], ["niho", NIHO], ["site", SITE]] as const)("%s: 完了時の段階名と同じ題名は止める", (_name, target) => {
    expect(ids(evaluate(target, { title: "記事本文" }, { facts }))).toContain("step-title");
  });

  it("段階名を後から変更しても過去の最終段階名は通さず、独自の題名なら通す", () => {
    expect(ids(evaluate(SITE, { title: "旧・記事本文" }, { facts }))).toEqual(["step-title"]);
    expect(ids(evaluate(SITE, { title: "自分で付けた題名" }, { facts }))).toEqual([]);
  });
});

describe("evaluateReadiness: conditions every destination needs", () => {
  it.each([["exp", EXP], ["niho", NIHO], ["site", SITE]] as const)("%s: an unknown node is a problem, never dropped", (_name, target) => {
    const result = evaluate(target, { content: bodyWith({ type: "codeBlock", content: [{ type: "text", text: "x" }] }) });
    expect(result.ready).toBe(false);
    expect(result.problems).toContainEqual({ id: "unknown-node", message: "公開版にできない要素があります", fix: "body", node: "codeBlock" });
  });

  it.each([
    ["missing", [COVER, AUDIO], "figure-missing"],
    ["a recording used as a photo", [COVER, { ...FIGURE, kind: "audio", contentType: "audio/mp4" }, AUDIO], "figure-unusable"],
    ["without consent", [COVER, { ...FIGURE, consent: false }, AUDIO], "figure-consent"],
  ] as const)("a figure whose photo is %s is a problem", (_name, assets, id) => {
    expect(ids(evaluate(SITE, {}, { assets }))).toEqual([id]);
  });

  it.each([
    ["missing", [FIGURE, AUDIO], "cover-missing"],
    ["an SVG", [{ ...COVER, contentType: "image/svg+xml" }, FIGURE, AUDIO], "cover-unusable"],
  ] as const)("a cover that is %s is a problem even without a cover condition", (_name, assets, id) => {
    expect(ids(evaluate(SITE, {}, { assets }))).toEqual([id]);
  });

  it("refuses a body over the contract's limits", () => {
    const long = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(20_001) }] }] };
    expect(ids(evaluate(SITE, { content: long }))).toEqual(["body-too-long"]);
    const many = { type: "doc", content: Array.from({ length: 2001 }, () => ({ type: "paragraph", content: [{ type: "text", text: "x" }] })) };
    expect(ids(evaluate(SITE, { content: many }))).toEqual(["body-too-long"]);
  });

  it("refuses malformed sheet choices", () => {
    expect(ids(evaluate(SITE, {}, { choices: { category: "a\u0007b", related: [] } }))).toEqual(["category-format"]);
    expect(ids(evaluate(SITE, {}, { choices: { category: null, related: ["Not A Slug"] } }))).toEqual(["related-format"]);
    expect(ids(evaluate(SITE, {}, { choices: { category: null, related: ["a", "a"] } }))).toEqual(["related-format"]);
  });

  it("reports recordings and dropped links as notices that do not stop publishing", () => {
    const result = evaluate(SITE, {
      content: bodyWith({ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:void(0)" } }] }] }),
    });
    expect(result.ready).toBe(true);
    expect(result.notices.map((notice) => notice.id)).toEqual(["recording-dropped", "link-dropped"]);
  });

  it("is pure: the same input gives the same output", () => {
    const facts = collectFacts(readyPage(), ASSETS, { relatedLive: true }, EXP_CHOICES);
    expect(evaluateReadiness(EXP, facts)).toEqual(evaluateReadiness(EXP, facts));
    expect(collectFacts(readyPage(), ASSETS, { relatedLive: true }, EXP_CHOICES)).toEqual(facts);
  });

  it("ready is true exactly when there are no problems", () => {
    for (const target of [EXP, NIHO, SITE]) {
      for (const page of [{}, { title: "" }, { lang: "ja" as const }, { coverAssetId: null }]) {
        const result = evaluate(target, page);
        expect(result.ready).toBe(result.problems.length === 0);
      }
    }
  });
});
