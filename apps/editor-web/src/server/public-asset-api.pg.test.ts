// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyMigrations } from "@niho/editor-store/migrate";
import { Pool } from "pg";
import { snapshot } from "../public-api/testing/synthetic";
import type { ObjectStorage } from "../storage/types";
import { pgPublicAssetStore, readPublicAssetRoute } from "./public-asset-api";

vi.mock("server-only", () => ({}));

const databaseUrl = process.env.TEST_DATABASE_URL;
const NOW = "2026-11-03T00:00:00.000Z";

describe.skipIf(databaseUrl === undefined)("public asset PostgreSQL authority", () => {
  const schema = `editor_public_asset_pg_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  async function seed(label: string, options: {
    published?: boolean;
    stopped?: boolean;
    consent?: boolean;
    deleted?: boolean;
    kind?: "image" | "audio";
    currentOmitsAsset?: boolean;
    bytes?: Uint8Array;
    owner?: string;
    dest?: "site" | "exp";
  } = {}) {
    const dest = options.dest ?? "site";
    const handle = dest === "site" ? "asset-notes" : "exp";
    const pageId = randomUUID();
    const assetId = randomUUID();
    const owner = options.owner ?? `synthetic-owner-${label}`;
    const bytes = options.bytes ?? new TextEncoder().encode(`synthetic public asset ${label}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const kind = options.kind ?? "image";
    const contentType = kind === "image" ? "image/jpeg" : "audio/mpeg";
    const objectPath = `${kind}/${assetId}`;
    await pool.query("INSERT INTO pages (id, owner, kind, title, lang) VALUES ($1, $2, 'article', $3, 'en')", [pageId, owner, `Synthetic ${label}`]);
    await pool.query(
      `INSERT INTO assets (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type, alt, consent, upload_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Database alt differs', $9, 'ready')`,
      [assetId, owner, pageId, kind, objectPath, bytes.byteLength, sha256, contentType, options.consent ?? true],
    );
    if (options.published) {
      const publishedAsset = { id: assetId, url: `https://editor.example/assets/${sha256}.jpg`, contentType: "image/jpeg" as const, bytes: bytes.byteLength, sha256, alt: "Figure context alt", credit: null };
      const doc = (version: number, includeAsset: boolean) => ({
        ...snapshot({ id: pageId, dest, slug: `asset-${label}`, title: `Synthetic ${label}`, updatedAt: NOW, version }),
        range: "live" as const,
        ...(includeAsset ? { cover: publishedAsset } : {}),
        fingerprint: "f".repeat(64),
      });
      await pool.query("INSERT INTO publication_versions (page_id, version, handle, snapshot) VALUES ($1, 1, $3, $2::jsonb)", [pageId, JSON.stringify(doc(1, kind === "image")), handle]);
      const version = options.currentOmitsAsset ? 2 : 1;
      if (version === 2) {
        await pool.query("INSERT INTO publication_versions (page_id, version, handle, snapshot) VALUES ($1, 2, $3, $2::jsonb)", [pageId, JSON.stringify(doc(2, false)), handle]);
      }
      await pool.query(
        `INSERT INTO publications
           (page_id, dest, handle, slug, range, extras_app, extras_news, extras_xp, category, related, version, published_at, updated_at, stopped_at)
         VALUES ($1, $6, $7, $2, 'live', false, false, false, NULL, '{}', $3, $4, $4, $5)`,
        [pageId, `asset-${label}`, version, NOW, options.stopped ? NOW : null, dest, handle],
      );
    }
    if (options.deleted) await pool.query("UPDATE pages SET deleted_at=clock_timestamp() WHERE id=$1", [pageId]);
    return { pageId, assetId, bytes, sha256, objectPath };
  }

  it("selects only current public image candidates and keeps denied rows away from object storage", async () => {
    const current = await seed("current", { published: true });
    await seed("private-same-owner-boundary", { bytes: current.bytes, owner: "another-owner" });
    const privateAsset = await seed("private");
    const retired = await seed("retired-exp", { published: true, dest: "exp" });
    const stopped = await seed("stopped", { published: true, stopped: true });
    const revoked = await seed("revoked", { published: true, consent: false });
    const deleted = await seed("deleted", { published: true, deleted: true });
    const audio = await seed("audio", { published: true, kind: "audio" });
    const oldVersion = await seed("old-version", { published: true, currentOmitsAsset: true });
    const store = pgPublicAssetStore(pool);

    expect(await store.candidates(current.sha256)).toHaveLength(1);
    for (const denied of [privateAsset, retired, stopped, revoked, deleted, audio]) {
      expect(await store.candidates(denied.sha256), denied.sha256).toEqual([]);
    }
    expect(await store.candidates(oldVersion.sha256)).toHaveLength(1);

    const readObject = vi.fn(async (objectPath: string) => objectPath === current.objectPath ? {
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(current.bytes); controller.close(); } }),
      contentType: "image/jpeg",
      sizeBytes: current.bytes.byteLength,
    } : null);
    const storage = { kind: "fake", readObject } as unknown as ObjectStorage;
    const deps = { store: () => store, storage: () => storage };
    const allowed = await readPublicAssetRoute(`${current.sha256}.jpg`, deps);
    expect(allowed.status).toBe(200);
    expect(new Uint8Array(await allowed.arrayBuffer())).toEqual(current.bytes);
    expect(readObject).toHaveBeenCalledTimes(1);

    readObject.mockClear();
    expect((await readPublicAssetRoute(`${oldVersion.sha256}.jpg`, deps)).status).toBe(404);
    expect(readObject).not.toHaveBeenCalled();
  }, 30_000);
});
