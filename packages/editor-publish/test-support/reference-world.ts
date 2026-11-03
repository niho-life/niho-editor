/**
 * TEST-ONLY: maps the in-memory store onto the contract's `ReferenceWorld`, so the contract's reference
 * model (`createReferenceServer`) can answer the public API over what the services actually wrote.
 *
 * - connections and keys: as stored (hashes only; the world never sees a plaintext key).
 * - publications: each page's publication with the version it shows. A handle the page left by moving
 *   becomes a stopped publication there (the latest version on that handle), with `movedToHandle` when a
 *   face → face redirect records the move. The memory store keeps no stop time for such a handle, so its
 *   `stoppedAt` is when the next version was published.
 * - pages (drafts): only pages that have a publication, built with that publication's settings. The
 *   memory store keeps no draft revisions, so `revision` is the latest version and `savedAt` is `now`.
 */

import type {
  DraftContent,
  PublishedSnapshot,
  ReferenceWorld,
  WorldConnection,
  WorldFaceCredential,
  WorldPage,
  WorldPreviewToken,
  WorldPublication,
} from "@niho/editor-publish-contract/test-support";
import { buildSnapshot, placeKey, type AssetUrls, type Snapshot, type VersionRecord } from "../src/index.js";
import type { MemoryPublishStore } from "./memory-store.js";

export interface ReferenceWorldOptions {
  /** The world's clock. Use a time at or after the last write, so revocations and stops count. */
  readonly now: string;
  /** To build the drafts' content (as a preview would read it). */
  readonly assetUrls: AssetUrls;
  readonly faceCredentials?: readonly WorldFaceCredential[];
  readonly previewTokens?: readonly WorldPreviewToken[];
}

function published(snapshot: Snapshot): PublishedSnapshot {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  delete copy.range;
  delete copy.fingerprint;
  return copy as unknown as PublishedSnapshot;
}

const byId = <T extends { readonly id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function toReferenceWorld(store: MemoryPublishStore, options: ReferenceWorldOptions): Promise<ReferenceWorld> {
  const state = store.snapshotState();

  const connections: WorldConnection[] = Object.values(state.connections)
    .map((connection) => ({
      id: connection.id,
      handle: connection.handle,
      ownerId: connection.ownerId,
      removedAt: connection.removedAt,
      keys: Object.values(state.keys)
        .filter((key) => key.connectionId === connection.id)
        .sort(byId)
        .map((key) => ({ sha256: key.sha256, revokedAt: key.revokedAt })),
    }))
    .sort(byId);

  const versionsByPage = new Map<string, VersionRecord[]>();
  for (const record of Object.values(state.versions)) {
    versionsByPage.set(record.pageId, [...(versionsByPage.get(record.pageId) ?? []), record]);
  }

  const publications: WorldPublication[] = [];
  const pages: WorldPage[] = [];
  for (const publication of Object.values(state.publications).sort((a, b) => (a.pageId < b.pageId ? -1 : 1))) {
    const versions = (versionsByPage.get(publication.pageId) ?? []).sort((a, b) => a.version - b.version);
    const current = versions.find((record) => record.version === publication.version);
    if (!current) throw new Error("publication without its version");
    publications.push({
      pageId: publication.pageId,
      handle: publication.handle,
      range: publication.range,
      stoppedAt: publication.stoppedAt,
      movedToHandle: null,
      snapshot: published(current.snapshot),
    });

    // Handles the page left by moving.
    for (const handle of new Set(versions.map((record) => record.handle))) {
      if (handle === publication.handle) continue;
      const last = versions.filter((record) => record.handle === handle).at(-1);
      const next = last && versions.find((record) => record.version > last.version);
      if (!last || !next) continue;
      const redirect = state.redirects[placeKey({ handle, slug: last.snapshot.slug })];
      publications.push({
        pageId: publication.pageId,
        handle,
        range: last.snapshot.range,
        stoppedAt: next.snapshot.updatedAt,
        movedToHandle: redirect && redirect.to !== "list" ? redirect.to.handle : null,
        snapshot: published(last.snapshot),
      });
    }

    const page = state.pages[publication.pageId];
    if (!page) continue;
    const assets = Object.values(state.assets).filter((entry) => entry.pageId === page.id).map((entry) => entry.asset);
    const built = await buildSnapshot({
      page,
      assets,
      dest: publication.dest,
      slug: publication.slug,
      canonicalUrl: current.snapshot.canonicalUrl,
      range: publication.range,
      extras: publication.extras,
      category: publication.category,
      ...(current.snapshot.categoryDisplay === undefined ? {} : { categoryDisplay: current.snapshot.categoryDisplay }),
      related: publication.related,
      author: current.snapshot.author,
      version: publication.version,
      publishedAt: publication.publishedAt,
      updatedAt: options.now,
      assetUrls: options.assetUrls,
    });
    if (!built.ok) continue;
    const { snapshot } = built;
    const content: DraftContent = {
      slug: snapshot.slug,
      lang: snapshot.lang,
      title: snapshot.title,
      lead: snapshot.lead,
      cover: snapshot.cover,
      category: snapshot.category,
      ...(snapshot.categoryDisplay === undefined ? {} : { categoryDisplay: snapshot.categoryDisplay }),
      author: snapshot.author,
      range: snapshot.range,
      canonicalUrl: snapshot.canonicalUrl,
      extras: snapshot.extras,
      related: snapshot.related,
      blocks: snapshot.blocks,
      assets: snapshot.assets,
    };
    pages.push({
      id: page.id,
      ownerId: page.ownerId,
      draft: { revision: versions.at(-1)?.version ?? 1, savedAt: options.now, content },
    });
  }

  return {
    now: options.now,
    pages,
    publications,
    connections,
    faceCredentials: [...(options.faceCredentials ?? [])],
    previewTokens: [...(options.previewTokens ?? [])],
  };
}
