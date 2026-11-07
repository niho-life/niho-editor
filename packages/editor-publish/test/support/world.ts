/** Synthetic worlds for the tests. Every value here is made up (example.com hosts, fake ids and hashes). */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PublishService,
  type AssetRecord,
  type DraftPage,
  type PlaceInput,
  type PublishSettings,
  type Target,
} from "../../src/index.js";
import {
  ManualClock,
  MemoryAuthors,
  MemoryConnections,
  MemoryDeclarations,
  MemoryFacts,
  MemoryPublishStore,
  MemoryRoles,
  MemoryStorageMode,
  memoryAssetUrls,
} from "../../test-support/memory-store.js";

export function readFixture<T>(relativeToPackage: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../${relativeToPackage}`, import.meta.url)), "utf8")) as T;
}

export const ACTOR = "actor-writer-01";
export const OTHER_ACTOR = "actor-other-02";
export const PAGE_ID = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
export const PAGE_2 = "7a1d3b5f-2c4e-4d6f-9a81-0b2c3d4e5f60";
export const OTHER_PAGE = "8b2e4c6a-3d5f-4e70-8b92-1c3d4e5f6a70";
export const SITE = "example-notes";

export const DECLARATIONS = {
  exp: readFixture<Record<string, unknown>>("fixtures/destinations/exp.json"),
  niho: readFixture<Record<string, unknown>>("fixtures/destinations/niho.json"),
  site: readFixture<Record<string, unknown>>("fixtures/destinations/site.json"),
};

export function asset(id: string, patch: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id,
    kind: "image",
    bytes: 120_000,
    sha256: "1".repeat(64),
    contentType: "image/jpeg",
    alt: "A synthetic photo",
    credit: "Example Photo Studio",
    consent: true,
    ...patch,
  };
}

export const COVER = asset("asset-cover-01", { sha256: "a".repeat(64), alt: "Shoreline at sunrise" });
export const FIGURE = asset("asset-figure-01", { sha256: "b".repeat(64), contentType: "image/webp", alt: "Boats", credit: null });
export const AUDIO = asset("asset-audio-01", { kind: "audio", sha256: "c".repeat(64), contentType: "audio/mp4", alt: null, credit: null });

/** A TipTap body every fixture destination accepts. */
export function readyContent(): unknown {
  return {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Getting there" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Meet at the " },
          { type: "text", text: "station", marks: [{ type: "bold" }] },
          { type: "text", text: " at 7:00." },
        ],
      },
      { type: "image", attrs: { assetId: FIGURE.id, alt: "Fishing boats in the harbor", caption: "The harbor at 7:30" } },
      { type: "recording", attrs: { assetId: AUDIO.id } },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Then follow " },
          { type: "text", text: "the coastal path", marks: [{ type: "link", attrs: { href: "https://maps.example.com/coast" } }] },
          { type: "text", text: "." },
        ],
      },
    ],
  };
}

export function readyPage(patch: Partial<DraftPage> = {}): DraftPage {
  return {
    id: PAGE_ID,
    ownerId: ACTOR,
    title: "A morning walk along the coast",
    lang: "en",
    lead: "Start early, follow the shoreline, and stop for tea.",
    coverAssetId: COVER.id,
    content: readyContent(),
    ...patch,
  };
}

export const SETTINGS: { readonly exp: PublishSettings; readonly niho: PublishSettings; readonly site: PublishSettings } = {
  exp: { range: "live", extras: { app: true, news: false, xp: true }, category: "walks", related: ["coastal-tea-ceremony"] },
  niho: { range: "live", extras: { app: true, news: true, xp: false }, category: "essay", related: [] },
  site: { range: "live", extras: { app: false, news: false, xp: false }, category: null, related: [] },
};

export const TARGETS: { readonly exp: Target; readonly niho: Target; readonly site: Target } = {
  exp: { dest: "exp" },
  niho: { dest: "niho" },
  site: { dest: "site", handle: SITE },
};

export type DestName = keyof typeof TARGETS;

export interface World {
  readonly store: MemoryPublishStore;
  readonly roles: MemoryRoles;
  readonly storage: MemoryStorageMode;
  readonly connections: MemoryConnections;
  readonly declarations: MemoryDeclarations;
  readonly authors: MemoryAuthors;
  readonly facts: MemoryFacts;
  readonly clock: ManualClock;
  readonly service: PublishService;
  input(dest: DestName, patch?: Partial<PlaceInput>): PlaceInput;
  editDraft(patch: Partial<DraftPage>, pageId?: string): void;
}

/** A writer who is also 鎌倉の人, with one connected site, one ready page and its assets. */
export function createWorld(): World {
  const store = new MemoryPublishStore();
  store.putPage(readyPage());
  for (const record of [COVER, FIGURE, AUDIO]) store.putAsset(PAGE_ID, record);
  const roles = new MemoryRoles();
  const storage = new MemoryStorageMode();
  roles.set(ACTOR, ["writer", "kamakura"]);
  roles.set(OTHER_ACTOR, ["writer", "kamakura"]);
  const connections = new MemoryConnections();
  connections.connect(ACTOR, SITE);
  const declarations = new MemoryDeclarations();
  declarations.set("exp", DECLARATIONS.exp);
  declarations.set("niho", DECLARATIONS.niho);
  declarations.set(SITE, DECLARATIONS.site);
  const authors = new MemoryAuthors();
  authors.set(ACTOR, { name: "Example Writer", handle: "example-writer", url: "https://writer.example.com/" });
  authors.set(OTHER_ACTOR, { name: "Another Writer", handle: null, url: null });
  const facts = new MemoryFacts();
  facts.set(ACTOR, { relatedLive: true });
  facts.set(OTHER_ACTOR, { relatedLive: true });
  const clock = new ManualClock("2026-10-01T09:00:00.000Z", 60);
  const service = new PublishService({ store, roles, storage, connections, declarations, authors, facts, assetUrls: memoryAssetUrls(), clock });
  return {
    store,
    roles,
    storage,
    connections,
    declarations,
    authors,
    facts,
    clock,
    service,
    input: (dest, patch = {}) => {
      return { actorId: ACTOR, pageId: PAGE_ID, target: TARGETS[dest], settings: SETTINGS[dest], ...patch };
    },
    editDraft: (patch, pageId = PAGE_ID) => {
      const page = store.page(pageId);
      if (!page) throw new Error("no page");
      store.putPage({ ...page, ...patch });
    },
  };
}

/** Adds a second page (same owner unless given) with the same ready body. */
export function addPage(world: World, id: string, patch: Partial<DraftPage> = {}): void {
  world.store.putPage(readyPage({ id, ...patch }));
  for (const record of [COVER, FIGURE, AUDIO]) world.store.putAsset(id, { ...record, id: `${record.id}-${id.slice(0, 4)}` });
  const page = world.store.page(id);
  if (!page) throw new Error("no page");
  world.store.putPage({
    ...page,
    coverAssetId: `${COVER.id}-${id.slice(0, 4)}`,
    content: JSON.parse(JSON.stringify(readyContent()).replaceAll(FIGURE.id, `${FIGURE.id}-${id.slice(0, 4)}`)) as unknown,
  });
}
