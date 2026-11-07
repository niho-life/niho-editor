/**
 * Status words and the sheet's plan (#39). The words match docs-ui's `ShellStatusState`.
 * `sheetPlan` is everything the publish sheet needs to render; it never enables the primary button
 * while there is a problem. PublishService re-checks everything on its own and does not rely on it.
 */

import { type Extras, type PublicationRange } from "@niho/editor-publish-contract";
import { destinationUrl, parseDestinationDeclaration, type DestinationDeclaration } from "./declaration.js";
import { evaluateReadiness, type ReadinessFacts } from "./readiness.js";
import { slugFromTitle, suggestSlug, validateSlug, type SlugError } from "./slug.js";
import {
  EXTRA_KEYS,
  PUBLISHABLE_FACE_DESTS,
  destOf,
  roleAllows,
  storageBlockOf,
  type ExtraKey,
  type Notice,
  type Problem,
  type StorageBlock,
  type StorageMode,
} from "./types.js";
import type { Dest } from "@niho/editor-publish-contract";

export const STATUS_STATES = ["private", "published", "updated", "limited", "stopped"] as const;
/** private＝自分だけ、published＝公開中、updated＝更新あり、limited＝限定公開、stopped＝公開をやめた。 */
export type StatusState = (typeof STATUS_STATES)[number];

/** What status needs from a publication: its range, whether it stopped, and its version's fingerprint. */
export interface PublicationView {
  readonly range: PublicationRange;
  readonly stoppedAt: string | null;
  readonly fingerprint: string;
}

/**
 * private when never published; stopped when stopped; updated when the draft's content differs from
 * the published version (also for limited release, since "更新を公開" is what the author needs);
 * otherwise limited or published by range.
 */
export function deriveStatus(publication: PublicationView | null, draftFingerprint: string): StatusState {
  if (publication === null) return "private";
  if (publication.stoppedAt !== null) return "stopped";
  if (publication.fingerprint !== draftFingerprint) return "updated";
  return publication.range === "unlisted" ? "limited" : "published";
}

export const FACE_LABELS = { exp: "NIHO Experience", niho: "NIHO" } as const;

/** The current publication as the sheet sees it. */
export interface SheetPublication extends PublicationView {
  readonly handle: string;
  readonly slug: string;
  readonly extras: Extras;
  readonly category: string | null;
  readonly related: readonly string[];
}

/** What is chosen on the sheet right now. `slug: null` uses the suggestion from the title. */
export interface SheetSelection {
  readonly handle: string;
  readonly range: PublicationRange;
  readonly extras: Extras;
  readonly category: string | null;
  readonly related: readonly string[];
  readonly slug: string | null;
}

export interface SheetPlanInput {
  readonly pageId: string;
  readonly title: string;
  /** Roles read from NIHO for this render. Never stored. */
  readonly roles: readonly string[];
  /** The account's storage mode read from NIHO for this render. Never stored. Publishing needs `CLOUD` (design §2.1). */
  readonly storageMode: StorageMode;
  /** Handles of the owner's connected sites (#41). */
  readonly sites: readonly string[];
  /** Declaration JSON by handle as fetched; missing or null means unavailable. Parsed (fail closed) here. */
  readonly declarations: Readonly<Record<string, unknown>>;
  readonly selection: SheetSelection | null;
  readonly publication: SheetPublication | null;
  readonly draftFingerprint: string;
  /** Facts collected for the selection (`collectFacts`). */
  readonly facts: ReadinessFacts;
  /** Slugs other pages hold on the selected handle (for the suggestion and `slug_taken`). */
  readonly takenSlugs?: readonly string[];
}

/** Why a destination cannot be chosen: no role for the face, or its declaration is missing / broken. */
export type DestinationBlock = "role" | "unavailable";

export interface SheetDestination {
  readonly handle: string;
  readonly dest: Dest;
  readonly label: string;
  readonly available: boolean;
  readonly reason: DestinationBlock | null;
}

export type PrimaryAction = "publish" | "update" | "save";

export interface SheetSlug {
  readonly value: string | null;
  /** Until the first publication on this destination. */
  readonly editable: boolean;
  readonly error: SlugError | "slug_taken" | null;
}

export interface SheetPlan {
  readonly status: StatusState;
  /** Set when the storage mode rules publishing out: the primary button is off and the sheet says why. Stopping stays possible. */
  readonly storageBlock: StorageBlock | null;
  readonly destinations: readonly SheetDestination[];
  readonly selected: SheetDestination | null;
  readonly ranges: readonly PublicationRange[];
  readonly extras: readonly { readonly key: ExtraKey; readonly checked: boolean }[];
  /** The selection asks for a range or an extra the destination does not offer. */
  readonly selectionError: "range" | "extras" | null;
  readonly problems: readonly Problem[];
  readonly notices: readonly Notice[];
  readonly url: string | null;
  readonly slug: SheetSlug;
  /** publish＝公開する、update＝更新を公開、save＝設定だけ変えた、null＝押せない／することがない。 */
  readonly primary: PrimaryAction | null;
  /** The primary action publishes on another destination than the current publication. */
  readonly changesDestination: boolean;
  readonly canStop: boolean;
}

function declarationOf(raw: unknown, dest: Dest): DestinationDeclaration | null {
  if (raw === undefined || raw === null) return null;
  const parsed = parseDestinationDeclaration(raw);
  return parsed.ok && parsed.value.id === dest ? parsed.value : null;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function settingsDiffer(publication: SheetPublication, selection: SheetSelection): boolean {
  return publication.range !== selection.range
    || EXTRA_KEYS.some((key) => publication.extras[key] !== selection.extras[key])
    || publication.category !== selection.category
    || !sameList(publication.related, selection.related);
}

export function sheetPlan(input: SheetPlanInput): SheetPlan {
  const status = deriveStatus(input.publication, input.draftFingerprint);
  const declarations = new Map<string, DestinationDeclaration | null>();
  const destinations: SheetDestination[] = [];
  for (const dest of PUBLISHABLE_FACE_DESTS) {
    const declaration = declarationOf(input.declarations[dest], dest);
    declarations.set(dest, declaration);
    const reason: DestinationBlock | null = !roleAllows(input.roles, dest) ? "role" : declaration === null ? "unavailable" : null;
    destinations.push({ handle: dest, dest, label: declaration?.label ?? FACE_LABELS[dest], available: reason === null, reason });
  }
  for (const handle of new Set(input.sites)) {
    if (destOf(handle) !== "site") continue;
    const declaration = declarationOf(input.declarations[handle], "site");
    declarations.set(handle, declaration);
    destinations.push({
      handle,
      dest: "site",
      label: declaration?.label ?? handle,
      available: declaration !== null,
      reason: declaration === null ? "unavailable" : null,
    });
  }

  const selection = input.selection;
  const selected = selection === null ? null : destinations.find((entry) => entry.handle === selection.handle) ?? null;
  const declaration = selected === null ? null : declarations.get(selected.handle) ?? null;
  const publication = input.publication;
  const canStop = publication !== null && publication.stoppedAt === null;
  const storageBlock = storageBlockOf(input.storageMode);
  const empty: SheetPlan = {
    status,
    storageBlock,
    destinations,
    selected,
    ranges: [],
    extras: [],
    selectionError: null,
    problems: [],
    notices: [],
    url: null,
    slug: { value: null, editable: false, error: null },
    primary: null,
    changesDestination: false,
    canStop,
  };
  if (selection === null || selected === null || !selected.available || declaration === null) return empty;

  const readiness = evaluateReadiness(declaration, input.facts);
  const selectionError = !declaration.ranges.includes(selection.range)
    ? "range"
    : EXTRA_KEYS.some((key) => selection.extras[key] && !declaration.extras.includes(key)) ? "extras" : null;

  const sameHandle = publication !== null && publication.handle === selected.handle;
  let slug: SheetSlug;
  if (sameHandle) {
    slug = { value: publication.slug, editable: false, error: null };
  } else {
    const taken = input.takenSlugs ?? [];
    const value = selection.slug ?? suggestSlug(slugFromTitle(input.title, input.pageId), taken);
    const check = validateSlug(value);
    const error = !check.ok ? check.reason : value !== null && taken.includes(value) ? "slug_taken" : null;
    slug = { value, editable: true, error };
  }

  let primary: PrimaryAction | null = null;
  if (storageBlock === null && readiness.problems.length === 0 && slug.error === null && selectionError === null) {
    if (publication === null || publication.stoppedAt !== null || !sameHandle) primary = "publish";
    else if (publication.fingerprint !== input.draftFingerprint) primary = "update";
    else if (settingsDiffer(publication, selection)) primary = "save";
  }

  return {
    ...empty,
    ranges: declaration.ranges,
    extras: declaration.extras.map((key) => ({ key, checked: selection.extras[key] })),
    selectionError,
    problems: readiness.problems,
    notices: readiness.notices,
    url: slug.value !== null && slug.error !== "format" && slug.error !== "length" ? destinationUrl(declaration, slug.value) : null,
    slug,
    primary,
    changesDestination: publication !== null && !sameHandle,
  };
}
