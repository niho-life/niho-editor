import { checkMarkdownSubset, renderMarkdown } from "../../src/markdown.js";
import type { Block, FaceDest, ParagraphBlock, PublishedDoc } from "../../src/v1.js";
import {
  parseBlocks,
  parseErrorBody,
  parseGoneBody,
  parsePreviewDoc,
  parsePublishedDoc,
  parsePublishedIndex,
  type ValidationResult,
} from "../../src/validate.js";
import { readJson } from "./synthetic.js";
import type { Outcome } from "./server-scenarios.js";

type PathSegment = string | number;

interface Patch {
  readonly op: "set" | "remove";
  readonly path: readonly PathSegment[];
  readonly value?: unknown;
}

interface InvalidCase {
  readonly id: string;
  readonly target: "doc" | "index" | "preview" | "gone" | "error";
  readonly options?: { readonly from?: FaceDest };
  readonly patches: readonly Patch[];
}

export const fixtures = {
  doc: readJson<PublishedDoc>("fixtures/published-doc.json"),
  index: readJson<unknown>("fixtures/published-index.json"),
  preview: readJson<unknown>("fixtures/preview-doc.json"),
  gone: readJson<unknown>("fixtures/gone-moved.json"),
};

const invalidCases = readJson<{ cases: readonly InvalidCase[] }>("fixtures/invalid.json").cases;
const markdownCases = readJson<{ cases: readonly { id: string; markdown: string }[] }>("fixtures/markdown-violations.json").cases;

export function applyPatches(base: unknown, patches: readonly Patch[]): unknown {
  const root = structuredClone(base);
  for (const patch of patches) {
    let parent = root as Record<PathSegment, unknown>;
    patch.path.slice(0, -1).forEach((segment) => {
      parent = parent[segment] as Record<PathSegment, unknown>;
    });
    const last = patch.path.at(-1);
    if (last === undefined) throw new Error("empty patch path");
    if (patch.op === "remove") delete parent[last];
    else parent[last] = structuredClone(patch.value);
  }
  return root;
}

/** One reason per negative; several distinct reasons show up joined, so the case fails loudly. */
export function validationOutcome(result: ValidationResult<unknown>): Outcome {
  if (result.ok) return { valid: true };
  return { valid: false, reason: [...new Set(result.errors.map((issue) => issue.reason))].sort().join("+") };
}

function runInvalidCase(testCase: InvalidCase): Outcome {
  const input = applyPatches(fixtures[testCase.target === "error" ? "gone" : testCase.target], testCase.patches);
  const options = testCase.options ?? {};
  switch (testCase.target) {
    case "doc":
      return validationOutcome(parsePublishedDoc(input, { requireProjection: true }));
    case "index":
      return validationOutcome(parsePublishedIndex(input));
    case "preview":
      return validationOutcome(parsePreviewDoc(input, { requireProjection: true }));
    case "gone":
      return validationOutcome(parseGoneBody(input, options));
    case "error":
      return validationOutcome(parseErrorBody(input, options));
  }
}

function docWith(blocks: readonly Block[], extra: Partial<Record<keyof PublishedDoc, unknown>> = {}): Record<string, unknown> {
  return { ...fixtures.doc, blocks, assets: [], markdown: renderMarkdown(blocks, []), ...extra };
}

const paragraph = (text: string): ParagraphBlock => ({ type: "paragraph", content: [{ type: "text", text }] });

/** Negatives too large or too sensitive to keep as static fixtures (built at run time). */
const runtimeScenarios: Readonly<Record<string, () => Outcome>> = {
  "ast-block-too-long": () => validationOutcome(parsePublishedDoc(docWith([paragraph("a".repeat(20_001))]))),
  "ast-block-at-limit-valid": () => validationOutcome(parsePublishedDoc(docWith([paragraph("a".repeat(20_000))]))),
  "ast-too-many-blocks": () => validationOutcome(parsePublishedDoc(docWith(Array.from({ length: 2_001 }, () => ({ type: "divider" }) as const)))),
  "ast-too-many-nested-blocks": () => {
    const note: Block = { type: "note", blocks: [paragraph("x"), paragraph("y")] };
    return validationOutcome(parsePublishedDoc(docWith(Array.from({ length: 667 }, () => note))));
  },
  "doc-too-large": () => validationOutcome(parsePublishedDoc(docWith(Array.from({ length: 60 }, () => paragraph("b".repeat(19_000)))))),
  "link-userinfo-password": () => {
    const href = ["https://", "user", ":", "pass", "@", "example.com/"].join("");
    const blocks: Block[] = [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", href }] }] }];
    return validationOutcome(parsePublishedDoc({ ...docWith([]), blocks, markdown: "x\n" }));
  },
  "doc-markdown-different-but-safe-accepted": () => validationOutcome(
    parsePublishedDoc({ ...fixtures.doc, markdown: `${fixtures.doc.markdown}\nAnother line.\n` }),
  ),
  "doc-slug-too-long": () => validationOutcome(parsePublishedDoc({ ...fixtures.doc, slug: "a".repeat(161) })),
  "doc-not-json": () => validationOutcome(parsePublishedDoc({ ...fixtures.doc, version: Number.NaN })),
  "doc-author-profile-role-too-long": () => validationOutcome(
    parsePublishedDoc({ ...fixtures.doc, authorProfile: { role: "r".repeat(121), bio: null } }, { requireProjection: true }),
  ),
  "doc-author-profile-bio-at-limit-valid": () => validationOutcome(
    parsePublishedDoc({ ...fixtures.doc, authorProfile: { role: null, bio: "海".repeat(600) } }, { requireProjection: true }),
  ),
  "blocks-figure-without-assets": () =>
    validationOutcome(parseBlocks([{ type: "figure", assetId: "asset-figure-01", caption: null }])),
  "index-dest-mismatch": () => validationOutcome(parsePublishedIndex(fixtures.index, { dest: "exp" })),
};

export const validatorScenarios: Readonly<Record<string, () => Outcome>> = {
  ...Object.fromEntries(invalidCases.map((testCase) => [testCase.id, () => runInvalidCase(testCase)])),
  ...runtimeScenarios,
};

export const markdownScenarios: Readonly<Record<string, () => Outcome>> = Object.fromEntries(
  markdownCases.map((testCase) => [testCase.id, (): Outcome => {
    const violations = checkMarkdownSubset(testCase.markdown);
    if (violations.length === 0) return { subset: true };
    return { subset: false, reason: [...new Set(violations.map((violation) => violation.reason))].sort().join("+") };
  }]),
);

export const fixtureCaseIds = {
  invalid: invalidCases.map((testCase) => testCase.id),
  markdown: markdownCases.map((testCase) => testCase.id),
};
