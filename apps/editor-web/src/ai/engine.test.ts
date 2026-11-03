import type { Block } from "@niho/editor-store";
import { describe, expect, it } from "vitest";
import { validateBlocks } from "../ast/blocks";
import { diffAfter, diffBefore } from "./diff";
import {
  MAX_OUTPUT_ITEMS,
  MAX_OUTPUT_TEXT_CHARS,
  MAX_PAGE_CHARS,
  MAX_REQUEST_CHARS,
  applyAdoptions,
  blockText,
  buildProposal,
  buildRequest,
  parseAiOutput,
  type Adoptions,
} from "./engine";
import type { AiRequest } from "./model";
import { PRESETS, PRESET_IDS, parseIntent, presetsFor, type AiIntent } from "./presets";

const ASSET = "0b9f5c4e-6d1a-4c52-9a3e-2f7d8a1c3b40";
const text = (value: string, marks?: unknown[]): Block => (marks ? { type: "text", text: value, marks } : { type: "text", text: value });
const paragraph = (...content: Block[]): Block => (content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" });
const p = (value: string): Block => paragraph(text(value));
const heading = (level: 2 | 3, value: string): Block => ({ type: "heading", attrs: { level }, content: [text(value)] });
const bullet = (...items: string[]): Block => ({ type: "bulletList", content: items.map((item) => ({ type: "listItem", content: [p(item)] })) });

/** 合成のページ（0: 見出し 1: 太字とリンクの段落 2: 箇条書き 3: 段落 4: 区切り線 5: 画像 6: 空の段落 7: 囲み）。 */
function samplePage(): Block[] {
  return [
    heading(2, "合成の見出し"),
    paragraph(text("太字", [{ type: "bold" }]), text("と"), text("リンク", [{ type: "link", attrs: { href: "https://niho.life/" } }]), { type: "hardBreak" }, text("次の行")),
    bullet("項目 a", "項目 b"),
    p("合成の段落です"),
    { type: "horizontalRule" },
    { type: "image", attrs: { assetId: ASSET, alt: "合成の画像" } },
    paragraph(),
    { type: "callout", content: [p("合成の囲み")] },
  ];
}

const tidy: AiIntent = { preset: "tidy" };
const summarize: AiIntent = { preset: "summarize" };

function requestFor(blocks: Block[], intent: AiIntent = tidy): AiRequest {
  const plan = buildRequest({ blocks, lang: "ja" }, intent);
  if (!plan.ok || plan.requests.length !== 1) throw new Error("expected one request");
  return plan.requests[0]!;
}

function applied(blocks: Block[], adoptions: Adoptions): Block[] {
  const result = applyAdoptions(blocks, adoptions);
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.blocks;
}

describe("presets", () => {
  it("offers the candidates of each kind of page", () => {
    const labels = (kind: Parameters<typeof presetsFor>[0], lang: "ja" | "en") => presetsFor(kind, lang).map((preset) => preset.label);
    expect(labels("note", "ja")).toEqual(["整える", "要約", "見出しをつける", "英語にする"]);
    expect(labels("article", "en")).toEqual(["Tighten", "Add headings", "日本語にする", "Check facts to confirm"]);
    expect(labels("rec", "ja")).toEqual(["要約"]);
    expect(labels("step", "ja")).toEqual([]);
  });

  it("marks the presets that only add text as insert", () => {
    const inserts = PRESET_IDS.filter((id) => PRESETS[id].mode === "insert").map((id) => PRESETS[id].label);
    expect(inserts.sort()).toEqual(["Add headings", "Check facts to confirm", "要約", "見出しをつける", "記事にできそうな部分"].sort());
  });

  it("parses an intent as one known preset or a 1–500 character text", () => {
    expect(parseIntent({ preset: "tidy" })).toEqual({ preset: "tidy" });
    expect(parseIntent({ text: "  もっと短く  " })).toEqual({ text: "もっと短く" });
    expect(parseIntent({ text: "あ".repeat(500) })).toEqual({ text: "あ".repeat(500) });
    for (const bad of [null, "tidy", [], {}, { preset: "unknown" }, { preset: "tidy", text: "x" }, { text: "" }, { text: "   " }, { text: "あ".repeat(501) }, { text: "a\u0000" }, { text: 1 }, { prompt: "x" }]) {
      expect(parseIntent(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("buildRequest", () => {
  it("carries the same personal context into every split request", () => {
    const about = { name: "合成の呼び名", text: "短く箇条書きで書いてください。" };
    const result = buildRequest(
      { blocks: [p("あ".repeat(3_000)), p("い".repeat(3_000))], lang: "ja" },
      tidy,
      undefined,
      { about },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requests).toHaveLength(2);
    for (const request of result.requests) expect(request.about).toEqual(about);
  });

  it("sends paragraphs and headings as editable, other blocks with text as context, by top-level index", () => {
    const request = requestFor(samplePage());
    expect(request).toEqual({
      intent: tidy,
      lang: "ja",
      glossary: [],
      paragraphs: [
        { index: 0, kind: "heading", text: "合成の見出し" },
        { index: 1, kind: "paragraph", text: "太字とリンク\n次の行" },
        { index: 2, kind: "context", text: "項目 a\n項目 b" },
        { index: 3, kind: "paragraph", text: "合成の段落です" },
        { index: 5, kind: "context", text: "合成の画像" },
        { index: 6, kind: "paragraph", text: "" },
        { index: 7, kind: "context", text: "合成の囲み" },
      ],
    });
  });

  it("sends only the selected range (inclusive) and refuses a range outside the body", () => {
    const blocks = samplePage();
    const plan = buildRequest({ blocks, lang: "ja" }, tidy, { fromIndex: 1, toIndex: 3 });
    expect(plan.ok && plan.requests.map((request) => request.paragraphs.map((paragraph) => paragraph.index))).toEqual([[1, 2, 3]]);
    for (const scope of [
      { fromIndex: -1, toIndex: 2 },
      { fromIndex: 3, toIndex: 2 },
      { fromIndex: 0, toIndex: 8 },
      { fromIndex: 0.5, toIndex: 2 },
    ]) {
      expect(buildRequest({ blocks, lang: "ja" }, tidy, scope), JSON.stringify(scope)).toEqual({ ok: false, error: "bad_scope" });
    }
    expect(buildRequest({ blocks: [], lang: "ja" }, tidy, { fromIndex: 0, toIndex: 0 })).toEqual({ ok: false, error: "bad_scope" });
    expect(buildRequest({ blocks: [], lang: "en" }, tidy)).toEqual({ ok: true, requests: [] });
  });

  it("splits a long page at paragraph boundaries into requests of at most about 4,000 characters", () => {
    expect(MAX_REQUEST_CHARS).toBe(4_000);
    // 1,500 文字 × 5 → [0, 1]（3,000）・[2, 3]（3,000）・[4]
    const blocks = Array.from({ length: 5 }, (_, i) => p(String(i).repeat(1500)));
    const plan = buildRequest({ blocks, lang: "ja" }, tidy);
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.requests.map((request) => request.paragraphs.map((paragraph) => paragraph.index))).toEqual([[0, 1], [2, 3], [4]]);
    for (const request of plan.requests) {
      expect(request.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0)).toBeLessThanOrEqual(MAX_REQUEST_CHARS);
    }
    // ちょうど 4,000 は 1 回に入る。1 つの段落が上限より長いときは、その段落だけで 1 回
    const exact = buildRequest({ blocks: [p("a".repeat(2000)), p("b".repeat(2000)), p("c")], lang: "ja" }, tidy);
    expect(exact.ok && exact.requests.map((request) => request.paragraphs.length)).toEqual([2, 1]);
    const long = buildRequest({ blocks: [p("a"), p("b".repeat(MAX_REQUEST_CHARS + 1)), p("c")], lang: "ja" }, tidy);
    expect(long.ok && long.requests.map((request) => request.paragraphs.map((paragraph) => paragraph.index))).toEqual([[0], [1], [2]]);
    // 文字は code point で数える（サロゲートペアの絵文字も 1 文字）
    const emoji = buildRequest({ blocks: [p("😀".repeat(2000)), p("😀".repeat(2000))], lang: "ja" }, tidy);
    expect(emoji.ok && emoji.requests.length).toBe(1);
  });

  it("refuses more than 30,000 characters in one proposal as too_large", () => {
    const blocks = Array.from({ length: 3 }, () => p("あ".repeat(10_000)));
    const plan = buildRequest({ blocks, lang: "ja" }, tidy);
    // ちょうど 30,000 は送れる（10,000 の段落 3 つは 1 つずつ 3 回）
    expect(plan.ok && plan.requests.length).toBe(3);
    expect(buildRequest({ blocks: [...blocks, p("あ")], lang: "ja" }, tidy)).toEqual({ ok: false, error: "too_large" });
    // 範囲を絞れば送れる
    expect(buildRequest({ blocks: [...blocks, p("あ")], lang: "ja" }, tidy, { fromIndex: 1, toIndex: 3 }).ok).toBe(true);
    expect(MAX_PAGE_CHARS).toBe(30_000);
  });
});

describe("parseAiOutput", () => {
  const blocks = samplePage();
  const request = requestFor(blocks);
  const parse = (value: unknown) => parseAiOutput(value, request, blocks.length);

  it("accepts edits of the sent paragraphs and inserts anywhere from the top to the last block, rebuilt from known fields", () => {
    const result = parse({
      edits: [{ index: 3, text: "合成の段落です。\r\n二行目", extra: "dropped" }],
      inserts: [
        { afterIndex: -1, kind: "paragraph", text: "先頭" },
        { afterIndex: 7, kind: "callout", text: "最後" },
        { afterIndex: 4, kind: "heading", text: "区切り線の後ろ" },
      ],
      note: "ignored",
    });
    expect(result).toEqual({
      ok: true,
      output: {
        edits: [{ index: 3, text: "合成の段落です。\n二行目" }],
        inserts: [
          { afterIndex: -1, kind: "paragraph", text: "先頭" },
          { afterIndex: 7, kind: "callout", text: "最後" },
          { afterIndex: 4, kind: "heading", text: "区切り線の後ろ" },
        ],
      },
    });
    expect(parse({})).toEqual({ ok: true, output: { edits: [], inserts: [] } });
  });

  it("refuses indexes that are not editable paragraphs of the request, duplicates, and out-of-range positions", () => {
    const bad = [
      { edits: [{ index: 2, text: "箇条書きは変えない" }] },
      { edits: [{ index: 4, text: "区切り線" }] },
      { edits: [{ index: 8, text: "範囲外" }] },
      { edits: [{ index: -1, text: "負" }] },
      { edits: [{ index: 1.5, text: "小数" }] },
      { edits: [{ index: "3", text: "文字列" }] },
      { edits: [{ index: 3, text: "一" }, { index: 3, text: "二" }] },
      { inserts: [{ afterIndex: -2, kind: "paragraph", text: "x" }] },
      { inserts: [{ afterIndex: 8, kind: "paragraph", text: "x" }] },
      { inserts: [{ afterIndex: 0, kind: "image", text: "x" }] },
      { inserts: [{ afterIndex: 0, text: "x" }] },
    ];
    for (const value of bad) expect(parse(value).ok, JSON.stringify(value)).toBe(false);
    // 範囲を絞った要求では、範囲の外の段落は変えられない
    const scoped = buildRequest({ blocks, lang: "ja" }, tidy, { fromIndex: 3, toIndex: 3 });
    if (!scoped.ok) throw new Error("expected a plan");
    expect(parseAiOutput({ edits: [{ index: 0, text: "範囲の外" }] }, scoped.requests[0]!, blocks.length).ok).toBe(false);
  });

  it("refuses empty, too long, NUL-bearing or non-string text, wrong shapes, and too many items", () => {
    const bad: unknown[] = [
      null,
      "text",
      [],
      { edits: {} },
      { inserts: "x" },
      { edits: [null] },
      { edits: [{ index: 3, text: "" }] },
      { edits: [{ index: 3, text: "a".repeat(MAX_OUTPUT_TEXT_CHARS + 1) }] },
      { edits: [{ index: 3, text: "a\u0000b" }] },
      { edits: [{ index: 3, text: 1 }] },
      { edits: [{ index: 3 }] },
      { inserts: [{ afterIndex: 0, kind: "paragraph", text: "" }] },
      { inserts: Array.from({ length: MAX_OUTPUT_ITEMS + 1 }, () => ({ afterIndex: 0, kind: "paragraph", text: "x" })) },
    ];
    for (const value of bad) expect(parse(value).ok, JSON.stringify(value)?.slice(0, 80)).toBe(false);
    expect(parse({ edits: [{ index: 3, text: "a".repeat(MAX_OUTPUT_TEXT_CHARS) }] }).ok).toBe(true);
    expect(parse({ inserts: Array.from({ length: MAX_OUTPUT_ITEMS }, () => ({ afterIndex: 0, kind: "paragraph", text: "x" })) }).ok).toBe(true);
  });
});

describe("buildProposal", () => {
  const blocks = samplePage();

  it("turns edits into changes with word diffs, drops unchanged edits, and counts the untouched paragraphs", () => {
    const request = requestFor(blocks);
    const result = buildProposal(blocks, [{ request, output: { edits: [{ index: 3, text: "合成の段落でした。" }, { index: 0, text: "合成の見出し" }], inserts: [] } }], tidy, 4);
    if (!result.ok) throw new Error(result.reason);
    expect(result.proposal).toMatchObject({ label: "整える", baseRevision: 4, inserts: [], unchanged: 3 });
    expect(result.proposal.changes).toEqual([
      { index: 3, before: "合成の段落です", after: "合成の段落でした。", parts: ["合成の段落", { del: "です" }, { ins: "でした。" }] },
    ]);
    for (const change of result.proposal.changes) {
      expect(diffBefore(change.parts)).toBe(change.before);
      expect(diffAfter(change.parts)).toBe(change.after);
    }
  });

  it("drops edits for a preset that only adds text, keeping its inserts", () => {
    const request = requestFor(blocks, summarize);
    const result = buildProposal(blocks, [{ request, output: { edits: [{ index: 3, text: "勝手な書き換え" }], inserts: [{ afterIndex: -1, kind: "paragraph", text: "要約" }] } }], summarize, 1);
    expect(result.ok && result.proposal).toEqual({
      label: "要約",
      baseRevision: 1,
      changes: [],
      inserts: [{ afterIndex: -1, kind: "paragraph", text: "要約" }],
      unchanged: 4,
    });
  });

  it("merges the outputs of split requests in page order and answers an empty proposal when nothing changes", () => {
    const long = Array.from({ length: 4 }, (_, i) => p(`${i}`.repeat(7000)));
    const plan = buildRequest({ blocks: long, lang: "ja" }, { text: "直して" });
    if (!plan.ok) throw new Error("expected a plan");
    expect(plan.requests).toHaveLength(4);
    const runs = plan.requests.map((request) => ({
      request,
      output: { edits: [{ index: request.paragraphs[0]!.index, text: `直した ${request.paragraphs[0]!.index}` }], inserts: [{ afterIndex: request.paragraphs[0]!.index, kind: "paragraph", text: "足す" }] },
    }));
    const result = buildProposal(long, runs.reverse(), { text: "直して" }, 2);
    if (!result.ok) throw new Error(result.reason);
    expect(result.proposal.label).toBe("直して");
    expect(result.proposal.changes.map((change) => change.index)).toEqual([0, 1, 2, 3]);
    expect(result.proposal.inserts.map((insert) => insert.afterIndex)).toEqual([0, 1, 2, 3]);
    expect(result.proposal.unchanged).toBe(0);

    const empty = buildProposal(blocks, [{ request: requestFor(blocks), output: { edits: [], inserts: [] } }], tidy, 1);
    expect(empty.ok && empty.proposal).toMatchObject({ changes: [], inserts: [], unchanged: 4 });
  });

  it("fails when any request's output is invalid", () => {
    const request = requestFor(blocks);
    expect(buildProposal(blocks, [{ request, output: { edits: [{ index: 2, text: "x" }] } }], tidy, 1).ok).toBe(false);
    expect(buildProposal(blocks, [{ request, output: "not json" }], tidy, 1).ok).toBe(false);
    // 同じ段落を 2 つの要求が変えようとした（分け方の誤り）
    expect(buildProposal(blocks, [{ request, output: { edits: [{ index: 3, text: "一" }] } }, { request, output: { edits: [{ index: 3, text: "二" }] } }], tidy, 1).ok).toBe(false);
  });
});

describe("applyAdoptions", () => {
  const blocks = samplePage();

  it("replaces only the adopted paragraphs with plain text, keeps heading levels and every other block untouched", () => {
    const result = applied(blocks, {
      changes: [
        { index: 0, text: "新しい見出し" },
        { index: 3, text: "新しい段落\n二行目" },
      ],
      inserts: [],
    });
    expect(result).toEqual([
      heading(2, "新しい見出し"),
      blocks[1],
      blocks[2],
      paragraph(text("新しい段落"), { type: "hardBreak" }, text("二行目")),
      ...blocks.slice(4),
    ]);
    // 変更した段落の marks は外れる（v1 の制限）。変更しない段落の marks は残る
    const marked = applied(blocks, { changes: [{ index: 1, text: blockText(blocks[1]!) }], inserts: [] });
    expect(marked[1]).toEqual(paragraph(text("太字とリンク"), { type: "hardBreak" }, text("次の行")));
    expect(applied(blocks, { changes: [{ index: 3, text: "x" }], inserts: [] })[1]).toEqual(blocks[1]);
    expect(applied([heading(3, "小見出し")], { changes: [{ index: 0, text: "変えた" }], inserts: [] })).toEqual([heading(3, "変えた")]);
  });

  it("inserts paragraphs, level-2 headings and callouts after the given block (−1 is the top)", () => {
    const result = applied([p("一"), p("二")], {
      changes: [],
      inserts: [
        { afterIndex: -1, kind: "paragraph", text: "先頭" },
        { afterIndex: 0, kind: "heading", text: "見出し" },
        { afterIndex: 1, kind: "callout", text: "囲み" },
      ],
    });
    expect(result).toEqual([p("先頭"), p("一"), heading(2, "見出し"), p("二"), { type: "callout", content: [p("囲み")] }]);
  });

  it("resolves every index against the original body, whatever order the changes and inserts come in", () => {
    const base = [p("零"), p("一"), p("二"), p("三")];
    const changes = [
      { index: 0, text: "零'" },
      { index: 2, text: "二'" },
      { index: 3, text: "三'" },
    ];
    const inserts: Adoptions["inserts"] = [
      { afterIndex: -1, kind: "paragraph", text: "前" },
      { afterIndex: 1, kind: "heading", text: "一の後ろ" },
      { afterIndex: 3, kind: "callout", text: "最後" },
    ];
    const expected = [p("前"), p("零'"), p("一"), heading(2, "一の後ろ"), p("二'"), p("三'"), { type: "callout", content: [p("最後")] }];
    expect(applied(base, { changes, inserts })).toEqual(expected);
    expect(applied(base, { changes: [...changes].reverse(), inserts: [...inserts].reverse() })).toEqual(expected);
    expect(applied(base, { changes: [changes[1]!, changes[2]!, changes[0]!], inserts: [inserts[2]!, inserts[0]!, inserts[1]!] })).toEqual(expected);
    // 同じ afterIndex の差し込みは渡した順
    expect(
      applied([p("一")], {
        changes: [],
        inserts: [
          { afterIndex: 0, kind: "paragraph", text: "a" },
          { afterIndex: 0, kind: "paragraph", text: "b" },
        ],
      }),
    ).toEqual([p("一"), p("a"), p("b")]);
    expect(base).toEqual([p("零"), p("一"), p("二"), p("三")]);
  });

  it("always returns a body that passes validateBlocks", () => {
    const result = applied(blocks, {
      changes: [{ index: 6, text: "空だった段落" }],
      inserts: [{ afterIndex: 7, kind: "callout", text: "一\n二" }],
    });
    expect(validateBlocks(result)).toEqual({ ok: true, blocks: result });
  });

  it("refuses invalid positions, non-paragraph targets, duplicates and invalid text", () => {
    const bad: Adoptions[] = [
      { changes: [{ index: 2, text: "箇条書き" }], inserts: [] },
      { changes: [{ index: 4, text: "区切り線" }], inserts: [] },
      { changes: [{ index: 8, text: "範囲外" }], inserts: [] },
      { changes: [{ index: -1, text: "負" }], inserts: [] },
      { changes: [{ index: 1.5, text: "小数" }], inserts: [] },
      { changes: [{ index: 3, text: "一" }, { index: 3, text: "二" }], inserts: [] },
      { changes: [{ index: 3, text: "" }], inserts: [] },
      { changes: [{ index: 3, text: "a\u0000" }], inserts: [] },
      { changes: [], inserts: [{ afterIndex: -2, kind: "paragraph", text: "x" }] },
      { changes: [], inserts: [{ afterIndex: 8, kind: "paragraph", text: "x" }] },
      { changes: [], inserts: [{ afterIndex: 0, kind: "image" as "paragraph", text: "x" }] },
      { changes: [], inserts: [{ afterIndex: 0, kind: "paragraph", text: "a".repeat(MAX_OUTPUT_TEXT_CHARS + 1) }] },
    ];
    for (const adoptions of bad) expect(applyAdoptions(blocks, adoptions).ok, JSON.stringify(adoptions).slice(0, 120)).toBe(false);
    // 今の本文に通らない見出し（level 1）は、変えた結果が検査に通らないので ok:false
    expect(applyAdoptions([{ type: "heading", attrs: { level: 1 }, content: [text("x")] }], { changes: [{ index: 0, text: "y" }], inserts: [] }).ok).toBe(false);
  });
});
