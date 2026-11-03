/**
 * TEST-ONLY in-memory implementations of the ports of @niho/editor-publish.
 *
 * This is NOT a production store and must never hold real data. It exists so that the acceptance
 * behavior (atomic publish / update / stop / move, redirects, reserved slugs) can be checked without a
 * database. Transactions really roll back: the state at the start is kept and restored when the work or
 * the commit throws. Tests can make the k-th store call (every transaction method and the commit)
 * throw, to prove that a failure anywhere leaves the store exactly as it was.
 *
 * The same store also holds the connections and keys of #41 (`ConnectionStore`), in the same
 * transactions as publications. Keys are kept as the service hands them over: hash and last 4 only.
 */

import { canonicalJson, type Author } from "@niho/editor-publish-contract";
import {
  draftFingerprint,
  placeKey,
  samePlace,
  type AssetBytes,
  type AssetRecord,
  type AssetUrls,
  type AuthorSource,
  type Clock,
  type ConnectionRecord,
  type ConnectionSource,
  type ConnectionStore,
  type ConnectionTx,
  type DeclarationSource,
  type DraftFingerprints,
  type DraftPage,
  type FactsQuery,
  type FactsSource,
  type KeyRecord,
  type Place,
  type Problem,
  type PublicationRecord,
  type PublishStore,
  type RedirectRecord,
  type RoleReader,
  type ServerFacts,
  type StorageMode,
  type StorageModeReader,
  type VersionRecord,
} from "../src/index.js";

export interface MemoryState {
  pages: Record<string, DraftPage>;
  assets: Record<string, { pageId: string; asset: AssetRecord }>;
  /** By page id. */
  publications: Record<string, PublicationRecord>;
  /** By `${pageId}#${version}`. */
  versions: Record<string, VersionRecord>;
  /** By `${handle}/${slug}` of `from`. */
  redirects: Record<string, RedirectRecord>;
  /** By connection id (#41). */
  connections: Record<string, ConnectionRecord>;
  /** By key id (#41). */
  keys: Record<string, KeyRecord>;
}

/** Thrown by an injected fault. Carries no data. */
export class InjectedStoreFault extends Error {
  constructor() {
    super("injected store fault");
    this.name = "InjectedStoreFault";
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function frozenClone<T>(value: T): T {
  const copy = clone(value);
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null) return;
    for (const key of Object.keys(item)) freeze((item as Record<string, unknown>)[key]);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}

function emptyState(): MemoryState {
  return { pages: {}, assets: {}, publications: {}, versions: {}, redirects: {}, connections: {}, keys: {} };
}

const versionKey = (pageId: string, version: number): string => `${pageId}#${version}`;

export class MemoryPublishStore implements PublishStore, ConnectionStore {
  private state: MemoryState;
  private calls = 0;
  private failAt: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private reviewProblem: Problem | null | undefined;

  constructor(initial?: Partial<MemoryState>) {
    this.state = { ...emptyState(), ...clone(initial ?? {}) };
  }

  // --- test controls (not part of the port) ---

  /** Makes the k-th store call from now on throw (1-based). `null` turns injection off. Resets the count. */
  failOnCall(k: number | null): void {
    this.failAt = k;
    this.calls = 0;
  }

  /** Store calls (transaction methods and commits) since the last reset. */
  get callCount(): number {
    return this.calls;
  }

  resetCallCount(): void {
    this.calls = 0;
  }

  /** Enables the optional managed-translation gate for a focused service test. Undefined keeps old call counts unchanged. */
  setReviewProblem(problem: Problem | null | undefined): void {
    this.reviewProblem = problem ? clone(problem) : problem;
  }

  /** Canonical JSON of everything held: compare two dumps to prove nothing changed. */
  dump(): string {
    return canonicalJson(this.state);
  }

  snapshotState(): MemoryState {
    return clone(this.state);
  }

  putPage(page: DraftPage): void {
    this.state.pages[page.id] = clone(page);
  }

  putAsset(pageId: string, asset: AssetRecord): void {
    this.state.assets[asset.id] = { pageId, asset: clone(asset) };
  }

  page(pageId: string): DraftPage | null {
    const page = this.state.pages[pageId];
    return page ? frozenClone(page) : null;
  }

  publication(pageId: string): PublicationRecord | null {
    const publication = this.state.publications[pageId];
    return publication ? frozenClone(publication) : null;
  }

  versions(pageId: string): VersionRecord[] {
    return Object.values(this.state.versions)
      .filter((record) => record.pageId === pageId)
      .sort((a, b) => a.version - b.version)
      .map((record) => frozenClone(record));
  }

  redirects(): RedirectRecord[] {
    return Object.values(this.state.redirects).map((record) => frozenClone(record));
  }

  assetsOf(pageId: string): AssetRecord[] {
    return Object.values(this.state.assets)
      .filter((entry) => entry.pageId === pageId)
      .map((entry) => frozenClone(entry.asset));
  }

  connection(connectionId: string): ConnectionRecord | null {
    const connection = this.state.connections[connectionId];
    return connection ? frozenClone(connection) : null;
  }

  keysOf(connectionId: string): KeyRecord[] {
    return Object.values(this.state.keys)
      .filter((key) => key.connectionId === connectionId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .map((key) => frozenClone(key));
  }

  // --- port ---

  transaction<T>(work: (tx: ConnectionTx) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const before = clone(this.state);
      let active = true;
      const tx = this.createTx(() => active);
      try {
        const result = await work(tx);
        this.tick();
        return result;
      } catch (error) {
        this.state = before;
        throw error;
      } finally {
        active = false;
      }
    };
    // One transaction at a time (serializable by construction).
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private tick(): void {
    this.calls += 1;
    if (this.failAt !== null && this.calls === this.failAt) throw new InjectedStoreFault();
  }

  private createTx(isActive: () => boolean): ConnectionTx {
    const enter = (): MemoryState => {
      if (!isActive()) throw new Error("transaction is closed");
      this.tick();
      return this.state;
    };
    return {
      ...(this.reviewProblem === undefined ? {} : {
        reviewGate: async () => {
          enter();
          return this.reviewProblem ? frozenClone(this.reviewProblem) : null;
        },
      }),
      getPage: async (pageId) => {
        const page = enter().pages[pageId];
        return page ? frozenClone(page) : null;
      },
      listAssets: async (pageId) =>
        Object.values(enter().assets)
          .filter((entry) => entry.pageId === pageId)
          .map((entry) => frozenClone(entry.asset)),
      getPublication: async (pageId) => {
        const publication = enter().publications[pageId];
        return publication ? frozenClone(publication) : null;
      },
      takenSlugs: async (handle, base, exceptPageId) => {
        const state = enter();
        const pattern = new RegExp(`^${base.replace(/[^a-z0-9-]/g, "")}(?:-[0-9]+)?$`);
        const taken = new Set<string>();
        for (const publication of Object.values(state.publications)) {
          if (publication.handle === handle && publication.pageId !== exceptPageId && pattern.test(publication.slug)) {
            taken.add(publication.slug);
          }
        }
        for (const redirect of Object.values(state.redirects)) {
          if (redirect.from.handle === handle && redirect.pageId !== exceptPageId && pattern.test(redirect.from.slug)) {
            taken.add(redirect.from.slug);
          }
        }
        return [...taken].sort();
      },
      latestVersion: async (pageId) => {
        let latest = 0;
        for (const record of Object.values(enter().versions)) {
          if (record.pageId === pageId && record.version > latest) latest = record.version;
        }
        return latest;
      },
      addVersion: async (record) => {
        const state = enter();
        const key = versionKey(record.pageId, record.version);
        if (state.versions[key]) throw new Error("version exists");
        state.versions[key] = clone(record);
      },
      putPublication: async (record) => {
        const state = enter();
        for (const other of Object.values(state.publications)) {
          if (other.pageId !== record.pageId && other.handle === record.handle && other.slug === record.slug) {
            throw new Error("unique (handle, slug)");
          }
        }
        state.publications[record.pageId] = clone(record);
      },
      listRedirectsTo: async (to: Place) =>
        Object.values(enter().redirects)
          .filter((redirect) => redirect.to !== "list" && samePlace(redirect.to, to))
          .map((redirect) => frozenClone(redirect)),
      putRedirect: async (record) => {
        enter().redirects[placeKey(record.from)] = clone(record);
      },
      deleteRedirect: async (from) => {
        delete enter().redirects[placeKey(from)];
      },

      // --- connections and keys (#41) ---
      getConnection: async (connectionId) => {
        const connection = enter().connections[connectionId];
        return connection ? frozenClone(connection) : null;
      },
      connectionLive: async (actorId, handle) => {
        const known = Object.values(enter().connections).filter((connection) => connection.handle === handle);
        // A handle this store has no record of is left to the pre-check: the #39 tests keep their
        // connections outside the store (`MemoryConnections`). A real adapter must not do this; a
        // connection is never deleted, so a handle that passed the pre-check always has its row.
        if (known.length === 0) return true;
        return known.some((connection) => connection.ownerId === actorId && connection.removedAt === null);
      },
      getConnectionByHandle: async (handle) => {
        const connection = Object.values(enter().connections).find((candidate) => candidate.handle === handle);
        return connection ? frozenClone(connection) : null;
      },
      listConnections: async (ownerId) =>
        Object.values(enter().connections)
          .filter((connection) => connection.ownerId === ownerId)
          .map((connection) => frozenClone(connection)),
      putConnection: async (record) => {
        const state = enter();
        for (const other of Object.values(state.connections)) {
          if (other.id !== record.id && other.handle === record.handle) throw new Error("unique (handle)");
        }
        state.connections[record.id] = clone(record);
      },
      listKeys: async (connectionId) =>
        Object.values(enter().keys)
          .filter((key) => key.connectionId === connectionId)
          .map((key) => frozenClone(key)),
      findKeyBySha256: async (sha256) => {
        const key = Object.values(enter().keys).find((candidate) => candidate.sha256 === sha256);
        return key ? frozenClone(key) : null;
      },
      putKey: async (record) => {
        const state = enter();
        for (const other of Object.values(state.keys)) {
          if (other.id !== record.id && other.sha256 === record.sha256) throw new Error("unique (sha256)");
        }
        state.keys[record.id] = clone(record);
      },
      listPublicationsByHandle: async (handle) =>
        Object.values(enter().publications)
          .filter((publication) => publication.handle === handle)
          .map((publication) => frozenClone(publication)),
      getVersion: async (pageId, version) => {
        const record = enter().versions[versionKey(pageId, version)];
        return record ? frozenClone(record) : null;
      },
    };
  }
}

/** Photo bytes by sha256, as a content-addressed asset store would serve them. Tests can corrupt them. */
export class MemoryAssetBytes implements AssetBytes {
  private readonly files = new Map<string, Uint8Array>();
  reads = 0;

  set(sha256: string, data: Uint8Array): void {
    this.files.set(sha256, Uint8Array.from(data));
  }

  remove(sha256: string): void {
    this.files.delete(sha256);
  }

  async read(asset: { readonly sha256: string }): Promise<Uint8Array | null> {
    this.reads += 1;
    const data = this.files.get(asset.sha256);
    return data ? Uint8Array.from(data) : null;
  }
}

/** The current draft's fingerprint, computed from the store's page and assets (outside any transaction). */
export function memoryDraftFingerprints(store: MemoryPublishStore): DraftFingerprints {
  return {
    async read(pageId) {
      const page = store.page(pageId);
      return page ? draftFingerprint(page, store.assetsOf(pageId)) : null;
    },
  };
}

// --- the other ports --------------------------------------------------------------------

/** Roles by actor. Counts reads so tests can prove roles are read on every operation. */
export class MemoryRoles implements RoleReader {
  private readonly roles = new Map<string, readonly string[]>();
  reads = 0;

  set(actorId: string, roles: readonly string[]): void {
    this.roles.set(actorId, [...roles]);
  }

  async read(actorId: string): Promise<readonly string[]> {
    this.reads += 1;
    return [...(this.roles.get(actorId) ?? [])];
  }
}

/** Storage mode by actor; `CLOUD` unless set. Counts reads so tests can prove it is read on every operation. */
export class MemoryStorageMode implements StorageModeReader {
  private readonly modes = new Map<string, StorageMode>();
  reads = 0;

  set(actorId: string, mode: StorageMode): void {
    this.modes.set(actorId, mode);
  }

  async read(actorId: string): Promise<StorageMode> {
    this.reads += 1;
    return this.modes.get(actorId) ?? "CLOUD";
  }
}

export class MemoryConnections implements ConnectionSource {
  private readonly connections = new Set<string>();

  connect(actorId: string, handle: string): void {
    this.connections.add(`${actorId}\n${handle}`);
  }

  disconnect(actorId: string, handle: string): void {
    this.connections.delete(`${actorId}\n${handle}`);
  }

  async has(actorId: string, handle: string): Promise<boolean> {
    return this.connections.has(`${actorId}\n${handle}`);
  }
}

/** Declaration JSON by handle, as a destination would serve it (unvalidated). */
export class MemoryDeclarations implements DeclarationSource {
  private readonly declarations = new Map<string, unknown>();

  set(handle: string, json: unknown): void {
    this.declarations.set(handle, clone(json));
  }

  remove(handle: string): void {
    this.declarations.delete(handle);
  }

  async get(handle: string): Promise<unknown> {
    return this.declarations.has(handle) ? clone(this.declarations.get(handle)) : null;
  }
}

export class MemoryAuthors implements AuthorSource {
  private readonly authors = new Map<string, Author>();

  set(actorId: string, author: Author): void {
    this.authors.set(actorId, { ...author });
  }

  async read(actorId: string): Promise<Author> {
    const author = this.authors.get(actorId);
    if (!author) throw new Error("unknown author");
    return { ...author };
  }
}

/** `relatedLive` per actor (default unknown). Records the queries it saw. */
export class MemoryFacts implements FactsSource {
  private readonly facts = new Map<string, ServerFacts>();
  readonly queries: FactsQuery[] = [];

  set(actorId: string, facts: ServerFacts): void {
    this.facts.set(actorId, { ...facts });
  }

  async read(query: FactsQuery): Promise<ServerFacts> {
    this.queries.push(query);
    return { ...(this.facts.get(query.actorId) ?? { relatedLive: null }) };
  }
}

/** `https://{host}/a/{sha256}` — what an asset store serving content-addressed files would return. */
export function memoryAssetUrls(host = "assets.example.com"): AssetUrls {
  return { urlFor: (asset) => `https://${host}/a/${asset.sha256}` };
}

/** A deterministic clock: `now()` returns the current time, then moves it forward by `stepSeconds`. */
export class ManualClock implements Clock {
  private time: number;

  constructor(start = "2026-10-01T09:00:00.000Z", private readonly stepSeconds = 0) {
    this.time = Date.parse(start);
  }

  advance(seconds: number): void {
    this.time += seconds * 1000;
  }

  now(): string {
    const value = new Date(this.time).toISOString();
    this.time += this.stepSeconds * 1000;
    return value;
  }
}
