/**
 * Destination declarations (#39): the JSON a destination publishes to say what it accepts and requires.
 * The vocabulary is closed. An unknown `kind`, an unknown field or a wrong type rejects the whole
 * declaration (fail closed): the destination is then "いまは公開できません", never published to with
 * conditions silently ignored. Issues carry a path and a reason, never the offending value.
 */

import {
  BLOCK_TYPES,
  DESTS,
  LANGS,
  MARK_TYPES,
  RANGES,
  isHttpsUrl,
  type Block,
  type Dest,
  type Lang,
  type MarkType,
  type PublicationRange,
} from "@niho/editor-publish-contract";
import { deepFreeze } from "./freeze.js";
import { codePointLength } from "./text.js";
import { EXTRA_KEYS, FIXES, type ExtraKey, type Fix } from "./types.js";

export const DECLARATION_SCHEMA_VERSION = 1 as const;

export const CONDITION_KINDS = ["lang", "cover", "lead", "category", "headings", "noConfirm", "relatedLive", "title", "images"] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

export type BlockType = Block["type"];

interface ConditionBase {
  readonly id: string;
  readonly message: string;
  readonly fix: Fix;
}

export type LangCondition = ConditionBase & { readonly kind: "lang"; readonly equals: Lang };
/** An optional cover, when set, must be usable; with `consent`, it also has 掲載許諾. */
export type CoverCondition = ConditionBase & { readonly kind: "cover"; readonly consent: boolean };
/** An optional lead, at most `max` characters when given. */
export type LeadCondition = ConditionBase & { readonly kind: "lead"; readonly max?: number };
/** A category is chosen, one of `oneOf` when given. */
export type CategoryCondition = ConditionBase & { readonly kind: "category"; readonly oneOf?: readonly string[] };
/** At least `min` headings in the body. */
export type HeadingsCondition = ConditionBase & { readonly kind: "headings"; readonly min: number };
/** No `[CONFIRM: …]` / confirm node anywhere (title, lead, body). */
export type NoConfirmCondition = ConditionBase & { readonly kind: "noConfirm" };
/** At least one related experience, and the server says they are live (`null` = unknown = not met). */
export type RelatedLiveCondition = ConditionBase & { readonly kind: "relatedLive" };
/** The title is at most `max` characters (code points). An empty title is the built-in `title` problem. */
export type TitleCondition = ConditionBase & { readonly kind: "title"; readonly max: number };
/**
 * With `alt`, every image the published version carries (each body figure and the cover) has non-empty alt
 * text, resolved the way the published version resolves it (the node's alt, else the asset's). `alt: false` always holds.
 */
export type ImagesCondition = ConditionBase & { readonly kind: "images"; readonly alt: boolean };

export type Condition =
  | LangCondition
  | CoverCondition
  | LeadCondition
  | CategoryCondition
  | HeadingsCondition
  | NoConfirmCondition
  | RelatedLiveCondition
  | TitleCondition
  | ImagesCondition;

export interface DestinationDeclaration {
  readonly schemaVersion: typeof DECLARATION_SCHEMA_VERSION;
  readonly id: Dest;
  readonly label: string;
  /** URLs are `https://{host}/{path}/{slug}` (`https://{host}/{slug}` when `path` is empty). */
  readonly host: string;
  readonly path: string;
  /** `unlisted` (限定公開) only on NIHO-operated faces. */
  readonly ranges: readonly PublicationRange[];
  readonly extras: readonly ExtraKey[];
  readonly accepts: { readonly blocks: readonly BlockType[]; readonly marks: readonly MarkType[] };
  readonly requires: readonly Condition[];
}

export const DECLARATION_REASONS = [
  "not-json",
  "type",
  "required",
  "unknown-field",
  "unknown-kind",
  "enum",
  "format",
  "range",
  "empty",
  "duplicate",
  "control-character",
  "schema-version",
  "not-allowed",
  "too-many",
] as const;
export type DeclarationReason = (typeof DECLARATION_REASONS)[number];

export interface DeclarationIssue {
  readonly path: string;
  readonly reason: DeclarationReason;
}

export type DeclarationResult =
  | { readonly ok: true; readonly value: DestinationDeclaration }
  | { readonly ok: false; readonly errors: readonly DeclarationIssue[] };

export const DECLARATION_LIMITS = {
  maxLabel: 80,
  maxMessage: 200,
  maxConditions: 32,
  maxCategories: 100,
  maxCategoryLength: 160,
  maxLead: 10_000,
  maxHeadings: 100,
  maxTitle: 500,
  maxHost: 253,
  maxPath: 64,
} as const;

const MAX_ISSUES = 100;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}/u;
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CONDITION_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH = /^[a-z0-9-]*$/;

const TOP_KEYS = ["schemaVersion", "id", "label", "host", "path", "ranges", "extras", "accepts", "requires"] as const;
const BASE_KEYS = ["id", "message", "fix", "kind"] as const;
const KIND_KEYS: { readonly [K in ConditionKind]: { readonly allowed: readonly string[]; readonly required: readonly string[] } } = {
  lang: { allowed: ["equals"], required: ["equals"] },
  cover: { allowed: ["consent"], required: ["consent"] },
  lead: { allowed: ["max"], required: [] },
  category: { allowed: ["oneOf"], required: [] },
  headings: { allowed: ["min"], required: ["min"] },
  noConfirm: { allowed: [], required: [] },
  relatedLive: { allowed: [], required: [] },
  title: { allowed: ["max"], required: ["max"] },
  images: { allowed: ["alt"], required: ["alt"] },
};

type Fields = Readonly<Record<string, unknown>>;

class Issues {
  readonly list: DeclarationIssue[] = [];

  add(path: string, reason: DeclarationReason): undefined {
    if (this.list.length < MAX_ISSUES) this.list.push({ path, reason });
    return undefined;
  }

  get count(): number {
    return this.list.length;
  }
}

function isFields(value: unknown): value is Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function child(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return SAFE_KEY.test(key) ? `${path}.${key}` : `${path}[?]`;
}

/** A closed object: unknown keys and missing required keys are issues. */
function objectAt(value: unknown, path: string, issues: Issues, allowed: readonly string[], required: readonly string[]): Fields | undefined {
  if (value === undefined) return issues.add(path, "required");
  if (!isFields(value)) return issues.add(path, "type");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) issues.add(child(path, key), "unknown-field");
  for (const key of required) if (value[key] === undefined) issues.add(child(path, key), "required");
  return value;
}

function textAt(value: unknown, path: string, issues: Issues, max: number): string | undefined {
  if (value === undefined) return undefined; // reported by objectAt
  if (typeof value !== "string") return issues.add(path, "type");
  if (CONTROL.test(value)) return issues.add(path, "control-character");
  if (value.trim() === "") return issues.add(path, "empty");
  if (codePointLength(value) > max) return issues.add(path, "range");
  return value;
}

function enumAt<T extends string>(value: unknown, allowed: readonly T[], path: string, issues: Issues): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return issues.add(path, "type");
  return (allowed as readonly string[]).includes(value) ? (value as T) : issues.add(path, "enum");
}

function integerAt(value: unknown, path: string, issues: Issues, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") return issues.add(path, "type");
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : issues.add(path, "range");
}

/** A list of distinct values from `allowed`. */
function setAt<T extends string>(value: unknown, allowed: readonly T[], path: string, issues: Issues, nonEmpty: boolean): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return issues.add(path, "type");
  if (nonEmpty && value.length === 0) return issues.add(path, "empty");
  const before = issues.count;
  const seen = new Set<string>();
  const items: T[] = [];
  value.forEach((entry: unknown, index) => {
    const item = enumAt(entry, allowed, child(path, index), issues);
    if (item === undefined) return;
    if (seen.has(item)) {
      issues.add(child(path, index), "duplicate");
      return;
    }
    seen.add(item);
    items.push(item);
  });
  return issues.count === before ? items : undefined;
}

/** An ASCII DNS name usable in an https URL: lowercase labels, at least one dot, no IP literal, no IDN, no port. */
export function isDeclarationHost(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > DECLARATION_LIMITS.maxHost) return false;
  const labels = value.split(".");
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label))) return false;
  if (labels.some((label) => label.startsWith("xn--"))) return false;
  if (/^[0-9]+$/.test(labels[labels.length - 1] ?? "")) return false;
  return isHttpsUrl(`https://${value}/`);
}

function hostAt(value: unknown, path: string, issues: Issues): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return issues.add(path, "type");
  return isDeclarationHost(value) ? value : issues.add(path, "format");
}

function pathAt(value: unknown, path: string, issues: Issues): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return issues.add(path, "type");
  if (value.length > DECLARATION_LIMITS.maxPath) return issues.add(path, "range");
  return PATH.test(value) ? value : issues.add(path, "format");
}

function categoriesAt(value: unknown, path: string, issues: Issues): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return issues.add(path, "type");
  if (value.length === 0) return issues.add(path, "empty");
  if (value.length > DECLARATION_LIMITS.maxCategories) return issues.add(path, "too-many");
  const before = issues.count;
  const seen = new Set<string>();
  const items = value.map((entry: unknown, index) => {
    const text = entry === undefined ? issues.add(child(path, index), "required") : textAt(entry, child(path, index), issues, DECLARATION_LIMITS.maxCategoryLength);
    if (text !== undefined && seen.has(text)) issues.add(child(path, index), "duplicate");
    if (text !== undefined) seen.add(text);
    return text;
  });
  return issues.count === before ? (items as string[]) : undefined;
}

function conditionAt(value: unknown, path: string, issues: Issues, ids: Set<string>): Condition | undefined {
  if (!isFields(value)) return issues.add(path, value === undefined ? "required" : "type");
  const kindValue = value.kind;
  if (kindValue === undefined) return issues.add(child(path, "kind"), "required");
  if (typeof kindValue !== "string") return issues.add(child(path, "kind"), "type");
  if (!(CONDITION_KINDS as readonly string[]).includes(kindValue)) return issues.add(child(path, "kind"), "unknown-kind");
  const kind = kindValue as ConditionKind;
  const shape = KIND_KEYS[kind];
  const fields = objectAt(value, path, issues, [...BASE_KEYS, ...shape.allowed], ["id", "message", "fix", ...shape.required]);
  if (!fields) return undefined;
  const before = issues.count;
  let id: string | undefined;
  if (fields.id !== undefined) {
    if (typeof fields.id !== "string") issues.add(child(path, "id"), "type");
    else if (!CONDITION_ID.test(fields.id)) issues.add(child(path, "id"), "format");
    else if (ids.has(fields.id)) issues.add(child(path, "id"), "duplicate");
    else id = fields.id;
  }
  if (id !== undefined) ids.add(id);
  const message = textAt(fields.message, child(path, "message"), issues, DECLARATION_LIMITS.maxMessage);
  const fix = enumAt(fields.fix, FIXES, child(path, "fix"), issues);
  let condition: Condition | undefined;
  if (id !== undefined && message !== undefined && fix !== undefined) {
    const base = { id, message, fix };
    switch (kind) {
      case "lang": {
        const equals = enumAt(fields.equals, LANGS, child(path, "equals"), issues);
        condition = equals && { ...base, kind, equals };
        break;
      }
      case "cover": {
        const consent = fields.consent === undefined ? undefined : typeof fields.consent === "boolean" ? fields.consent : issues.add(child(path, "consent"), "type");
        condition = consent === undefined ? undefined : { ...base, kind, consent };
        break;
      }
      case "lead": {
        const max = integerAt(fields.max, child(path, "max"), issues, 1, DECLARATION_LIMITS.maxLead);
        condition = max === undefined ? { ...base, kind } : { ...base, kind, max };
        break;
      }
      case "category": {
        const oneOf = categoriesAt(fields.oneOf, child(path, "oneOf"), issues);
        condition = oneOf === undefined ? { ...base, kind } : { ...base, kind, oneOf };
        break;
      }
      case "headings": {
        const min = integerAt(fields.min, child(path, "min"), issues, 1, DECLARATION_LIMITS.maxHeadings);
        condition = min === undefined ? undefined : { ...base, kind, min };
        break;
      }
      case "noConfirm":
      case "relatedLive":
        condition = { ...base, kind };
        break;
      case "title": {
        const max = integerAt(fields.max, child(path, "max"), issues, 1, DECLARATION_LIMITS.maxTitle);
        condition = max === undefined ? undefined : { ...base, kind, max };
        break;
      }
      case "images": {
        const alt = fields.alt === undefined ? undefined : typeof fields.alt === "boolean" ? fields.alt : issues.add(child(path, "alt"), "type");
        condition = alt === undefined ? undefined : { ...base, kind, alt };
        break;
      }
    }
  }
  return issues.count === before ? condition : undefined;
}

function conditionsAt(value: unknown, path: string, issues: Issues): readonly Condition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return issues.add(path, "type");
  if (value.length > DECLARATION_LIMITS.maxConditions) return issues.add(path, "too-many");
  const before = issues.count;
  const ids = new Set<string>();
  const conditions = value.map((entry: unknown, index) => conditionAt(entry, child(path, index), issues, ids));
  return issues.count === before ? (conditions as Condition[]) : undefined;
}

function declarationAt(input: unknown, issues: Issues): DestinationDeclaration | undefined {
  const fields = objectAt(input, "$", issues, TOP_KEYS, TOP_KEYS);
  if (!fields) return undefined;
  if (fields.schemaVersion !== undefined && fields.schemaVersion !== DECLARATION_SCHEMA_VERSION) {
    issues.add("$.schemaVersion", "schema-version");
  }
  const id = enumAt(fields.id, DESTS, "$.id", issues);
  const label = textAt(fields.label, "$.label", issues, DECLARATION_LIMITS.maxLabel);
  const host = hostAt(fields.host, "$.host", issues);
  const path = pathAt(fields.path, "$.path", issues);
  const ranges = setAt(fields.ranges, RANGES, "$.ranges", issues, true);
  // Limited release (限定公開) exists only on NIHO-operated faces.
  if (id === "site" && ranges?.includes("unlisted")) issues.add("$.ranges", "not-allowed");
  const extras = setAt(fields.extras, EXTRA_KEYS, "$.extras", issues, false);
  // "体験ページに載せる" is offered by NIHO Experience only.
  if (id !== undefined && id !== "exp" && extras?.includes("xp")) issues.add("$.extras", "not-allowed");
  const acceptsFields = objectAt(fields.accepts, "$.accepts", issues, ["blocks", "marks"], ["blocks", "marks"]);
  const blocks = acceptsFields && setAt(acceptsFields.blocks, BLOCK_TYPES, "$.accepts.blocks", issues, false);
  const marks = acceptsFields && setAt(acceptsFields.marks, MARK_TYPES, "$.accepts.marks", issues, false);
  const requires = conditionsAt(fields.requires, "$.requires", issues);
  if (
    issues.count > 0 || id === undefined || label === undefined || host === undefined || path === undefined
    || ranges === undefined || extras === undefined || blocks === undefined || marks === undefined || requires === undefined
  ) {
    return undefined;
  }
  return { schemaVersion: DECLARATION_SCHEMA_VERSION, id, label, host, path, ranges, extras, accepts: { blocks, marks }, requires };
}

/**
 * Validates a declaration. Accepts parsed JSON or JSON text. The result is deeply frozen.
 * Anything not understood rejects the whole declaration.
 */
export function parseDestinationDeclaration(json: unknown): DeclarationResult {
  const issues = new Issues();
  let input = json;
  if (typeof json === "string") {
    try {
      input = JSON.parse(json) as unknown;
    } catch {
      return { ok: false, errors: [{ path: "$", reason: "not-json" }] };
    }
  }
  const value = declarationAt(input, issues);
  if (issues.count > 0 || value === undefined) {
    return { ok: false, errors: issues.list.length > 0 ? issues.list : [{ path: "$", reason: "type" }] };
  }
  return deepFreeze({ ok: true, value });
}

/** `https://{host}/{path}/{slug}`, or `https://{host}/{slug}` when the path is empty. */
export function destinationUrl(declaration: Pick<DestinationDeclaration, "host" | "path">, slug: string): string {
  return declaration.path === "" ? `https://${declaration.host}/${slug}` : `https://${declaration.host}/${declaration.path}/${slug}`;
}
