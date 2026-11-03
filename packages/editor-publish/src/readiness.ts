/**
 * "公開の前に" (#39). `collectFacts` gathers what the conditions look at; `evaluateReadiness` is a pure
 * function of a declaration and those facts. `ready` is true only when there are no problems, and the
 * publish button stays disabled until then (PublishService checks again and refuses with `not_ready`).
 */

import { SLUG_MAX_LENGTH, SLUG_PATTERN, type Block, type Inline, type Lang } from "@niho/editor-publish-contract";
import type { BlockType, Condition, DestinationDeclaration } from "./declaration.js";
import { assetState, exceedsLimits, toPublishedBlocks } from "./snapshot.js";
import { cleanLine, cleanText, codePointLength, hasConfirmMarker } from "./text.js";
import type { AssetRecord, DraftPage, Notice, Problem } from "./types.js";

/** Facts only the server knows. `null` means unknown, which never satisfies a condition. */
export interface ServerFacts {
  readonly relatedLive: boolean | null;
  /** Names this page was generated with as the final step across its run history. */
  readonly finalStepNames?: readonly string[];
}

/** Sheet choices the conditions look at (stored on the publication, not on the page). */
export interface FactChoices {
  readonly category: string | null;
  readonly related: readonly string[];
}

export type CoverFact = "none" | "missing" | "unusable" | "no-consent" | "ok";

export interface ReadinessFacts {
  readonly title: string;
  readonly lang: Lang;
  readonly lead: string | null;
  readonly cover: CoverFact;
  readonly category: string | null;
  readonly categoryValid: boolean;
  readonly related: readonly string[];
  readonly relatedValid: boolean;
  readonly relatedLive: boolean | null;
  readonly hasBody: boolean;
  /** Block and mark types used by the converted body (note children included). */
  readonly blockTypes: readonly BlockType[];
  readonly markTypes: readonly string[];
  readonly headings: number;
  /** Confirm markers in the body, title and lead. */
  readonly confirms: number;
  /** The page title still equals a generated final-stage name. */
  readonly titleIsFinalStepName: boolean;
  /** Problems found in the body regardless of destination (unknown nodes, images, limits). */
  readonly bodyProblems: readonly Problem[];
  readonly notices: readonly Notice[];
}

export interface Readiness {
  readonly ready: boolean;
  readonly problems: readonly Problem[];
  readonly notices: readonly Notice[];
}

export const BUILTIN_PROBLEMS = {
  title: { id: "title", message: "題名を入れてください", fix: "body" },
  stepTitle: { id: "step-title", message: "工程の段階名が題名のままです。文書の題名に変更してください", fix: "body" },
  body: { id: "body", message: "本文を書いてください", fix: "body" },
  tooLong: { id: "body-too-long", message: "本文が長すぎます", fix: "body" },
  figureMissing: { id: "figure-missing", message: "写真が見つかりません", fix: "body" },
  figureUnusable: { id: "figure-unusable", message: "公開できない形式の写真があります", fix: "body" },
  figureConsent: { id: "figure-consent", message: "掲載許諾のない写真があります", fix: "body" },
  coverMissing: { id: "cover-missing", message: "カバー写真が見つかりません", fix: "cover" },
  coverUnusable: { id: "cover-unusable", message: "公開できない形式のカバー写真です", fix: "cover" },
  coverConsent: { id: "cover-consent", message: "カバー写真に掲載許諾がありません", fix: "cover" },
  category: { id: "category-format", message: "カテゴリの形が正しくありません", fix: "category" },
  related: { id: "related-format", message: "関連する体験の指定が正しくありません", fix: "related" },
} as const satisfies Record<string, Problem>;

const BLOCK_LABELS: { readonly [K in BlockType]: string } = {
  paragraph: "段落",
  heading: "見出し",
  list: "箇条書き",
  quote: "引用",
  figure: "写真",
  divider: "区切り線",
  note: "囲み",
};

const MARK_LABELS: Readonly<Record<string, string>> = {
  bold: "太字",
  italic: "斜体",
  strike: "取り消し線",
  code: "コード",
  link: "リンク",
};

const MAX_CATEGORY_LENGTH = 160;
const MAX_RELATED = 20;

function walkInlines(blocks: readonly Block[], visit: (inline: Inline) => void): void {
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "quote":
      case "heading":
        block.content.forEach(visit);
        break;
      case "list":
        block.items.forEach((item) => item.forEach(visit));
        break;
      case "note":
        walkInlines(block.blocks, visit);
        break;
      case "figure":
      case "divider":
        break;
    }
  }
}

function blockTypesOf(blocks: readonly Block[], into: Set<BlockType>): void {
  for (const block of blocks) {
    into.add(block.type);
    if (block.type === "note") blockTypesOf(block.blocks, into);
  }
}

function categoryOf(value: unknown): { category: string | null; valid: boolean } {
  if (value === null || value === undefined) return { category: null, valid: true };
  if (typeof value !== "string") return { category: null, valid: false };
  const category = cleanLine(value);
  // Control characters are not cleaned away silently here: the author chose this value on the sheet.
  const valid = value === cleanText(value) && (category === null || codePointLength(category) <= MAX_CATEGORY_LENGTH);
  return { category: valid ? category : null, valid };
}

function relatedOf(value: unknown): { related: readonly string[]; valid: boolean } {
  if (!Array.isArray(value)) return { related: [], valid: value === undefined };
  const related = (value as readonly unknown[]).filter((entry): entry is string => typeof entry === "string");
  const valid = related.length === value.length
    && related.length <= MAX_RELATED
    && new Set(related).size === related.length
    && related.every((slug) => SLUG_PATTERN.test(slug) && slug.length <= SLUG_MAX_LENGTH);
  return { related, valid };
}

/**
 * Gathers the facts for one page and one set of sheet choices. Pure: the body is converted with
 * `toPublishedBlocks`, so what is evaluated is exactly what would be published.
 */
export function collectFacts(
  page: DraftPage,
  assets: readonly AssetRecord[],
  serverFacts: ServerFacts,
  choices: FactChoices = { category: null, related: [] },
): ReadinessFacts {
  const conversion = toPublishedBlocks(page.content);
  const index = new Map(assets.map((asset) => [asset.id, asset] as const));
  const bodyProblems: Problem[] = [...conversion.problems];
  const seen = new Set(bodyProblems.map((problem) => problem.id));
  const add = (problem: Problem): void => {
    if (seen.has(problem.id)) return;
    seen.add(problem.id);
    bodyProblems.push(problem);
  };
  for (const figure of conversion.figures) {
    const state = assetState(index.get(figure.assetId));
    if (state === "missing") add(BUILTIN_PROBLEMS.figureMissing);
    else if (state === "unusable") add(BUILTIN_PROBLEMS.figureUnusable);
    else if (state === "no-consent") add(BUILTIN_PROBLEMS.figureConsent);
  }
  if (exceedsLimits(conversion.blocks)) add(BUILTIN_PROBLEMS.tooLong);

  const blockTypes = new Set<BlockType>();
  blockTypesOf(conversion.blocks, blockTypes);
  const markTypes = new Set<string>();
  let headings = 0;
  let confirms = 0;
  for (const block of conversion.blocks) if (block.type === "heading") headings += 1;
  walkInlines(conversion.blocks, (inline) => {
    if (inline.type === "confirm") confirms += 1;
    else for (const mark of inline.marks ?? []) markTypes.add(mark.type);
  });
  const title = cleanLine(page.title) ?? "";
  const lead = cleanLine(page.lead);
  if (hasConfirmMarker(title)) confirms += 1;
  if (hasConfirmMarker(lead)) confirms += 1;

  const cover: CoverFact = page.coverAssetId === null ? "none" : assetState(index.get(page.coverAssetId));
  const { category, valid: categoryValid } = categoryOf(choices.category);
  const { related, valid: relatedValid } = relatedOf(choices.related);
  return {
    title,
    lang: page.lang,
    lead,
    cover,
    category,
    categoryValid,
    related,
    relatedValid,
    relatedLive: serverFacts.relatedLive === true || serverFacts.relatedLive === false ? serverFacts.relatedLive : null,
    hasBody: conversion.blocks.length > 0,
    blockTypes: [...blockTypes],
    markTypes: [...markTypes],
    headings,
    confirms,
    titleIsFinalStepName: (serverFacts.finalStepNames ?? []).some((name) => cleanLine(name) === title),
    bodyProblems,
    notices: conversion.notices,
  };
}

function conditionMet(condition: Condition, facts: ReadinessFacts): boolean {
  switch (condition.kind) {
    case "lang":
      return facts.lang === condition.equals;
    case "cover":
      return facts.cover === "none" || facts.cover === "ok" || (!condition.consent && facts.cover === "no-consent");
    case "lead":
      return facts.lead === null || condition.max === undefined || codePointLength(facts.lead) <= condition.max;
    case "category":
      return facts.categoryValid && facts.category !== null && (condition.oneOf === undefined || condition.oneOf.includes(facts.category));
    case "headings":
      return facts.headings >= condition.min;
    case "noConfirm":
      return facts.confirms === 0;
    case "relatedLive":
      return facts.relatedValid && facts.related.length > 0 && facts.relatedLive === true;
  }
}

/**
 * Problems in a fixed order: the conditions every destination needs (title, body, accepts, images,
 * sheet choices), then the destination's `requires` in declaration order.
 */
export function evaluateReadiness(declaration: DestinationDeclaration, facts: ReadinessFacts): Readiness {
  const problems: Problem[] = [];
  if (facts.title === "") problems.push(BUILTIN_PROBLEMS.title);
  else if (facts.titleIsFinalStepName) problems.push(BUILTIN_PROBLEMS.stepTitle);
  if (!facts.hasBody) problems.push(BUILTIN_PROBLEMS.body);
  problems.push(...facts.bodyProblems);
  for (const type of facts.blockTypes) {
    if (!declaration.accepts.blocks.includes(type)) {
      problems.push({ id: `accepts-block-${type}`, message: `この発信先は${BLOCK_LABELS[type]}を受けません`, fix: "body" });
    }
  }
  for (const type of facts.markTypes) {
    if (!(declaration.accepts.marks as readonly string[]).includes(type)) {
      problems.push({ id: `accepts-mark-${type}`, message: `この発信先は${MARK_LABELS[type] ?? "この書式"}を受けません`, fix: "body" });
    }
  }
  const coverConditionFailed = declaration.requires.some((condition) => condition.kind === "cover" && !conditionMet(condition, facts));
  // Whatever goes into a published version must be usable and have consent, whatever the destination.
  if (!coverConditionFailed) {
    if (facts.cover === "missing") problems.push(BUILTIN_PROBLEMS.coverMissing);
    else if (facts.cover === "unusable") problems.push(BUILTIN_PROBLEMS.coverUnusable);
    else if (facts.cover === "no-consent") problems.push(BUILTIN_PROBLEMS.coverConsent);
  }
  if (!facts.categoryValid) problems.push(BUILTIN_PROBLEMS.category);
  if (!facts.relatedValid) problems.push(BUILTIN_PROBLEMS.related);
  for (const condition of declaration.requires) {
    if (!conditionMet(condition, facts)) problems.push({ id: condition.id, message: condition.message, fix: condition.fix });
  }
  return { ready: problems.length === 0, problems, notices: facts.notices };
}
