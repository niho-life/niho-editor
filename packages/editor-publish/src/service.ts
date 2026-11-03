/**
 * PublishService (#39): publish, update (including "保存" of settings only), stop and change destination.
 *
 * - Every operation runs in ONE store transaction. Any failure inside rolls everything back, so the
 *   previous published version, the draft and the redirects are left exactly as they were; the result
 *   is `failed` (retryable).
 * - Roles are read from NIHO (`RoleReader`) on every operation that publishes to a face, never stored.
 * - Readiness is evaluated here again; the sheet's disabled button is not trusted.
 * - Published versions are append-only and immutable.
 * - Nothing about pages, assets or authors is logged or put into errors; failures carry codes only.
 */

import {
  RANGES,
  UUID_PATTERN,
  isFaceDest,
  type Author,
  type Dest,
  type Extras,
  type PublicationRange,
} from "@niho/editor-publish-contract";
import { destinationUrl, parseDestinationDeclaration, type DestinationDeclaration } from "./declaration.js";
import { collectFacts, evaluateReadiness, type ServerFacts } from "./readiness.js";
import { planRedirect, type Place, type Redirect } from "./redirects.js";
import { buildSnapshot, type AssetUrls, type Snapshot } from "./snapshot.js";
import { slugFromTitle, slugStem, suggestSlug, validateSlug, type SlugError } from "./slug.js";
import { deriveStatus, type StatusState } from "./status.js";
import {
  EXTRA_KEYS,
  destOf,
  handleOfTarget,
  roleAllows,
  storageBlockOf,
  type AssetRecord,
  type DraftPage,
  type Notice,
  type Problem,
  type PublishSettings,
  type StorageBlock,
  type StorageMode,
  type Target,
} from "./types.js";

// --- records --------------------------------------------------------------------------

/** One per page. A stopped publication keeps its slug reserved on its handle. */
export interface PublicationRecord {
  readonly pageId: string;
  readonly dest: Dest;
  /** `exp` / `niho` for faces, the connection handle for an owner's site. */
  readonly handle: string;
  readonly slug: string;
  readonly range: PublicationRange;
  readonly extras: Extras;
  readonly category: string | null;
  readonly related: readonly string[];
  /** The version currently published. */
  readonly version: number;
  /** First publication; kept across updates, stops, re-publication and moves. */
  readonly publishedAt: string;
  /** When the current version was published. */
  readonly updatedAt: string;
  readonly stoppedAt: string | null;
}

/** An immutable published version. Never rewritten; a new one is added for every publish / update / save. */
export interface VersionRecord {
  readonly pageId: string;
  readonly version: number;
  readonly handle: string;
  readonly snapshot: Snapshot;
}

/** A redirect of an old face URL. `pageId` is the page that left `from`; it keeps `from` reserved. */
export interface RedirectRecord extends Redirect {
  readonly pageId: string;
  readonly createdAt: string;
}

// --- ports ------------------------------------------------------------------------------

/** One transaction. Every method may throw; the store then rolls the whole transaction back. */
export interface PublishTx {
  getPage(pageId: string): Promise<DraftPage | null>;
  /**
   * Whether `actorId` still has a live connection to the site with this handle, read inside the
   * transaction. A store that keeps connections must implement it (and lock the row on a database):
   * the check before the transaction (`ConnectionSource`) cannot see a `disconnect` that lands in
   * between. Stores without connections may leave it out.
   */
  connectionLive?(actorId: string, handle: string): Promise<boolean>;
  listAssets(pageId: string): Promise<readonly AssetRecord[]>;
  getPublication(pageId: string): Promise<PublicationRecord | null>;
  /**
   * Slugs on `handle` equal to `base` or `base-N` that another page holds: its publication (live or
   * stopped) or a redirect it left behind.
   */
  takenSlugs(handle: string, base: string, exceptPageId: string): Promise<readonly string[]>;
  /** 0 when the page has never been published. */
  latestVersion(pageId: string): Promise<number>;
  /** Must fail when the version already exists (versions are immutable). */
  addVersion(record: VersionRecord): Promise<void>;
  /** Must fail when another page's publication holds the same handle and slug. */
  putPublication(record: PublicationRecord): Promise<void>;
  listRedirectsTo(to: Place): Promise<readonly RedirectRecord[]>;
  /** Replaces the redirect with the same `from`. */
  putRedirect(record: RedirectRecord): Promise<void>;
  /** No-op when there is none. */
  deleteRedirect(from: Place): Promise<void>;
}

export interface PublishStore {
  /** Commits when `work` resolves, rolls back everything when it (or the commit) throws. */
  transaction<T>(work: (tx: PublishTx) => Promise<T>): Promise<T>;
}

/** Roles from NIHO, read on every operation (design §10). */
export interface RoleReader {
  read(actorId: string): Promise<readonly string[]>;
}

/** The account's storage mode from NIHO, read on every operation that publishes, never stored (design §2.1). */
export interface StorageModeReader {
  read(actorId: string): Promise<StorageMode>;
}

/** Whether the actor has a live connection to the site with this handle (#41). */
export interface ConnectionSource {
  has(actorId: string, handle: string): Promise<boolean>;
}

/** The declaration JSON for a handle (faces: fetched from the destination; sites: built from the connection). */
export interface DeclarationSource {
  get(handle: string): Promise<unknown>;
}

/** The author's profile at publish time. */
export interface AuthorSource {
  read(actorId: string): Promise<Author>;
}

export interface FactsQuery {
  readonly actorId: string;
  readonly pageId: string;
  readonly dest: Dest;
  readonly handle: string;
  readonly related: readonly string[];
  readonly category: string | null;
}

/** Facts only the server knows (whether the related experiences are live, …). */
export interface FactsSource {
  read(query: FactsQuery): Promise<ServerFacts>;
}

export interface Clock {
  /** ISO 8601 UTC, e.g. `2026-10-01T09:00:00.000Z`. */
  now(): string;
}

export interface PublishPorts {
  readonly store: PublishStore;
  readonly roles: RoleReader;
  readonly storage: StorageModeReader;
  readonly connections: ConnectionSource;
  readonly declarations: DeclarationSource;
  readonly authors: AuthorSource;
  readonly facts: FactsSource;
  readonly assetUrls: AssetUrls;
  readonly clock: Clock;
}

// --- inputs and results -------------------------------------------------------------------

export interface PlaceInput {
  readonly actorId: string;
  readonly pageId: string;
  readonly target: Target;
  readonly settings: PublishSettings;
  /**
   * Only before the first publication on this destination (and when moving). Omitted: the current slug
   * when moving, otherwise one made from the title; `-2`, `-3` … are added while taken.
   */
  readonly slug?: string;
}

export interface StopInput {
  readonly actorId: string;
  readonly pageId: string;
}

/** role: no role for the face; connection: no such site connection; target / range / extras: not offered. */
export type ForbiddenDetail = "role" | "connection" | "target" | "range" | "extras";

export type NotFound = { readonly ok: false; readonly reason: "not_found" };
export type Failed = { readonly ok: false; readonly reason: "failed"; readonly retryable: boolean };

export type PublishFailure =
  | NotFound
  | { readonly ok: false; readonly reason: "forbidden_destination"; readonly detail: ForbiddenDetail }
  /** The account keeps its pages only on the Mac (or is moving them there): nothing is published from the server. */
  | { readonly ok: false; readonly reason: "storage_not_cloud"; readonly detail: StorageBlock }
  | { readonly ok: false; readonly reason: "not_ready"; readonly problems: readonly Problem[]; readonly notices: readonly Notice[] }
  | { readonly ok: false; readonly reason: "slug_locked"; readonly slug: string }
  | { readonly ok: false; readonly reason: "slug_taken"; readonly suggestion: string | null }
  | { readonly ok: false; readonly reason: "invalid_slug"; readonly detail: SlugError }
  | { readonly ok: false; readonly reason: "destination_unavailable" }
  | Failed;

export interface PublishSuccess {
  readonly ok: true;
  readonly status: StatusState;
  readonly publication: PublicationRecord;
  readonly version: number;
  readonly url: string;
  readonly notices: readonly Notice[];
}

export type PublishResult = PublishSuccess | PublishFailure;

export type StopResult =
  | { readonly ok: true; readonly status: "stopped"; readonly publication: PublicationRecord }
  | NotFound
  | Failed;

export type PublishReason = PublishFailure["reason"];

const NOT_FOUND: NotFound = Object.freeze({ ok: false, reason: "not_found" });
/** Something failed on the way (store, port, commit). Nothing was written; trying again may work. */
const FAILED: Failed = Object.freeze({ ok: false, reason: "failed", retryable: true });
/** The published version could not be built or did not pass the contract. Trying again will not help. */
const SNAPSHOT_FAILED: Failed = Object.freeze({ ok: false, reason: "failed", retryable: false });
const UNAVAILABLE = Object.freeze({ ok: false, reason: "destination_unavailable" } as const);

function forbidden(detail: ForbiddenDetail): PublishFailure {
  return { ok: false, reason: "forbidden_destination", detail };
}

type Mode = "publish" | "update" | "move";

interface Context {
  readonly mode: Mode;
  readonly actorId: string;
  readonly pageId: string;
  readonly handle: string;
  readonly dest: Dest;
  readonly declaration: DestinationDeclaration;
  readonly range: PublicationRange;
  readonly extras: Extras;
  readonly category: unknown;
  readonly related: unknown;
  readonly slug: unknown;
  readonly serverFacts: ServerFacts;
  readonly author: Author;
}

function validIds(actorId: unknown, pageId: unknown): boolean {
  return typeof actorId === "string" && actorId !== "" && typeof pageId === "string" && UUID_PATTERN.test(pageId);
}

function extrasOf(value: unknown): Extras | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !(EXTRA_KEYS as readonly string[]).includes(key))) return null;
  const { app, news, xp } = record;
  return typeof app === "boolean" && typeof news === "boolean" && typeof xp === "boolean" ? { app, news, xp } : null;
}

function stringsOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? (value as readonly unknown[]).filter((entry): entry is string => typeof entry === "string") : [];
}

/** Slugs another page holds that `suggestSlug(base, …)` has to avoid: under `base` and under its stem. */
async function takenUnder(tx: PublishTx, handle: string, base: string, pageId: string): Promise<readonly string[]> {
  const taken = await tx.takenSlugs(handle, base, pageId);
  const stem = slugStem(base);
  return stem === base ? taken : [...taken, ...(await tx.takenSlugs(handle, stem, pageId))];
}

export class PublishService {
  constructor(private readonly ports: PublishPorts) {}

  /**
   * Publishes the page on `target`. First publication, re-publication after a stop (same slug, same URL,
   * same id) or a fresh placement on another destination. On a page that is live already, it behaves as
   * `update` (same destination) or `changeDestination` (another one), so a stale sheet never errors out.
   */
  publish(input: PlaceInput): Promise<PublishResult> {
    return this.place("publish", input);
  }

  /**
   * Replaces the live publication on the same destination and slug with a new version built from the
   * current draft and `settings`. Also "保存" when only settings changed. `not_found` unless live there.
   */
  update(input: PlaceInput): Promise<PublishResult> {
    return this.place("update", input);
  }

  /**
   * Moves a live publication to another destination. Face → face redirects the old URL to the new one
   * (one step), face → site redirects the old URL to the list, site → face leaves the old URL alone.
   * Conditions are evaluated again for the new destination; the slug may be chosen again.
   */
  changeDestination(input: PlaceInput): Promise<PublishResult> {
    return this.place("move", input);
  }

  /**
   * Stops publishing, keeping every version. A face redirects the URL to its list. Calling it again
   * returns the same result. Needs no role: the owner can always withdraw a page.
   */
  async stop(input: StopInput): Promise<StopResult> {
    try {
      if (!validIds(input.actorId, input.pageId)) return NOT_FOUND;
      return await this.ports.store.transaction(async (tx): Promise<StopResult> => {
        const page = await tx.getPage(input.pageId);
        if (!page || page.ownerId !== input.actorId) return NOT_FOUND;
        const current = await tx.getPublication(input.pageId);
        if (!current) return NOT_FOUND;
        if (current.stoppedAt !== null) return { ok: true, status: "stopped", publication: current };
        const now = this.ports.clock.now();
        const stopped: PublicationRecord = { ...current, stoppedAt: now };
        await tx.putPublication(stopped);
        if (isFaceDest(current.dest)) {
          await this.link(tx, { from: { handle: current.handle, slug: current.slug }, to: "list", pageId: current.pageId, createdAt: now });
        }
        return { ok: true, status: "stopped", publication: stopped };
      });
    } catch {
      return FAILED;
    }
  }

  private async place(mode: Mode, input: PlaceInput): Promise<PublishResult> {
    try {
      return await this.prepare(mode, input);
    } catch {
      return FAILED;
    }
  }

  /** Reads everything outside the store first (roles, declaration, facts, author), then runs the transaction. */
  private async prepare(mode: Mode, input: PlaceInput): Promise<PublishResult> {
    const { actorId, pageId } = input;
    if (!validIds(actorId, pageId)) return NOT_FOUND;
    const storageBlock = storageBlockOf(await this.ports.storage.read(actorId));
    if (storageBlock !== null) return { ok: false, reason: "storage_not_cloud", detail: storageBlock };
    const handle = handleOfTarget(input.target);
    const dest = handle === null ? null : destOf(handle);
    if (handle === null || dest === null) return forbidden("target");
    const settings = (typeof input.settings === "object" && input.settings !== null ? input.settings : {}) as Partial<Record<keyof PublishSettings, unknown>>;
    const range = settings.range;
    if (typeof range !== "string" || !(RANGES as readonly string[]).includes(range)) return forbidden("range");
    const extras = extrasOf(settings.extras);
    if (extras === null) return forbidden("extras");

    if (isFaceDest(dest)) {
      const roles = await this.ports.roles.read(actorId);
      if (!roleAllows(roles, dest)) return forbidden("role");
    } else if (!(await this.ports.connections.has(actorId, handle))) {
      return forbidden("connection");
    }

    const raw = await this.ports.declarations.get(handle);
    const parsed = raw === null || raw === undefined ? null : parseDestinationDeclaration(raw);
    if (!parsed?.ok || parsed.value.id !== dest) return UNAVAILABLE;
    const declaration = parsed.value;
    if (!declaration.ranges.includes(range as PublicationRange)) return forbidden("range");
    if (EXTRA_KEYS.some((key) => extras[key] && !declaration.extras.includes(key))) return forbidden("extras");

    const serverFacts = await this.ports.facts.read({ actorId, pageId, dest, handle, related: stringsOf(settings.related), category: typeof settings.category === "string" ? settings.category : null });
    const author = await this.ports.authors.read(actorId);
    const context: Context = {
      mode,
      actorId,
      pageId,
      handle,
      dest,
      declaration,
      range: range as PublicationRange,
      extras,
      category: settings.category ?? null,
      related: settings.related ?? [],
      slug: input.slug,
      serverFacts,
      author,
    };
    return this.ports.store.transaction((tx) => this.placeInTransaction(tx, context));
  }

  private async placeInTransaction(tx: PublishTx, context: Context): Promise<PublishResult> {
    const { mode, actorId, pageId, handle, dest, declaration } = context;
    const page = await tx.getPage(pageId);
    if (!page || page.ownerId !== actorId) return NOT_FOUND;
    if (!isFaceDest(dest) && tx.connectionLive !== undefined && !(await tx.connectionLive(actorId, handle))) {
      return forbidden("connection");
    }
    const current = await tx.getPublication(pageId);
    const live = current !== null && current.stoppedAt === null;
    const sameHandle = current !== null && current.handle === handle;
    if (mode === "update" && !(live && sameHandle)) return NOT_FOUND;
    if (mode === "move" && !(live && !sameHandle)) return NOT_FOUND;

    const assets = await tx.listAssets(pageId);
    const facts = collectFacts(page, assets, context.serverFacts, {
      category: context.category as string | null,
      related: context.related as readonly string[],
    });
    const readiness = evaluateReadiness(declaration, facts);
    if (!readiness.ready) return { ok: false, reason: "not_ready", problems: readiness.problems, notices: readiness.notices };

    let slug: string;
    if (current !== null && sameHandle) {
      // Fixed after the first publication; re-publication uses the same slug and URL.
      if (context.slug !== undefined && context.slug !== current.slug) return { ok: false, reason: "slug_locked", slug: current.slug };
      slug = current.slug;
    } else if (context.slug !== undefined) {
      const check = validateSlug(context.slug);
      if (!check.ok) return { ok: false, reason: "invalid_slug", detail: check.reason };
      const requested = context.slug as string;
      const taken = await takenUnder(tx, handle, requested, pageId);
      if (taken.includes(requested)) return { ok: false, reason: "slug_taken", suggestion: suggestSlug(requested, taken) };
      slug = requested;
    } else {
      const base = current?.slug ?? slugFromTitle(page.title, page.id);
      const suggestion = suggestSlug(base, await takenUnder(tx, handle, base, pageId));
      if (suggestion === null) return { ok: false, reason: "slug_taken", suggestion: null };
      slug = suggestion;
    }

    const now = this.ports.clock.now();
    const version = (await tx.latestVersion(pageId)) + 1;
    const publishedAt = current?.publishedAt ?? now;
    const url = destinationUrl(declaration, slug);
    const built = await buildSnapshot({
      page,
      assets,
      dest,
      slug,
      canonicalUrl: url,
      range: context.range,
      extras: context.extras,
      category: facts.category,
      ...(context.serverFacts.categoryDisplay === undefined ? {} : { categoryDisplay: context.serverFacts.categoryDisplay }),
      related: facts.related,
      author: context.author,
      version,
      publishedAt,
      updatedAt: now,
      assetUrls: this.ports.assetUrls,
    });
    if (!built.ok) return SNAPSHOT_FAILED;

    const publication: PublicationRecord = {
      pageId,
      dest,
      handle,
      slug,
      range: context.range,
      extras: { app: context.extras.app, news: context.extras.news, xp: context.extras.xp },
      category: facts.category,
      related: [...facts.related],
      version,
      publishedAt,
      updatedAt: now,
      stoppedAt: null,
    };
    await tx.addVersion({ pageId, version, handle, snapshot: built.snapshot });
    await tx.putPublication(publication);
    const place: Place = { handle, slug };
    // The new URL is live: a redirect this page left there earlier ("一覧へ" after a stop, or a move back) goes.
    await tx.deleteRedirect(place);
    if (current !== null && live && !sameHandle && isFaceDest(current.dest)) {
      await this.link(tx, {
        from: { handle: current.handle, slug: current.slug },
        to: isFaceDest(dest) ? place : "list",
        pageId,
        createdAt: now,
      });
    }
    return {
      ok: true,
      status: deriveStatus({ range: publication.range, stoppedAt: null, fingerprint: built.snapshot.fingerprint }, built.snapshot.fingerprint),
      publication,
      version,
      url,
      notices: readiness.notices,
    };
  }

  /** Adds a redirect and re-points the ones that led to its `from`, keeping chains one step long. */
  private async link(tx: PublishTx, next: RedirectRecord): Promise<void> {
    const plan = planRedirect(await tx.listRedirectsTo(next.from), next);
    for (const from of plan.remove) await tx.deleteRedirect(from);
    for (const redirect of plan.put) await tx.putRedirect(redirect);
  }
}
