import "server-only";
import { createHash } from "node:crypto";
import { parsePublishedDoc, type PublishedAsset } from "@niho/editor-publish-contract";
import { IMAGE_MAX_BYTES, imageObjectPath, type Queryable } from "@niho/editor-store";
import type { ObjectStorage } from "../storage/types";

const FILE = /^([0-9a-f]{64})\.(avif|gif|jpg|png|webp)$/;
const TYPES: Readonly<Record<string, string>> = {
  avif: "image/avif", gif: "image/gif", jpg: "image/jpeg", png: "image/png", webp: "image/webp",
};
const DEFAULT_READ_TIMEOUT_MS = 5_000;

export type PublicAssetRow = Readonly<{
  snapshot: unknown;
  assetId: string;
  objectPath: string;
  bytes: number;
  sha256: string;
  contentType: string;
}>;

export interface PublicAssetStore {
  candidates(sha256: string): Promise<readonly PublicAssetRow[]>;
}

type DbRow = {
  snapshot: unknown; asset_id: string; bucket_path: string; bytes: string; sha256: string; content_type: string;
};

/** Current, non-stopped publication rows only; old versions and private drafts never enter the candidate set. */
export function pgPublicAssetStore(db: Queryable): PublicAssetStore {
  return {
    async candidates(sha256) {
      const result = await db.query<DbRow>(
        `SELECT pv.snapshot, a.id AS asset_id, a.bucket_path, a.bytes::text AS bytes, a.sha256, a.content_type
           FROM publications p
           JOIN publication_versions pv ON pv.page_id = p.page_id AND pv.version = p.version AND pv.handle = p.handle
           JOIN pages page ON page.id = p.page_id AND page.deleted_at IS NULL
           JOIN assets a ON a.page_id = page.id AND a.owner = page.owner
          WHERE p.stopped_at IS NULL AND p.dest = 'site'
            AND a.kind = 'image' AND a.upload_status = 'ready' AND a.consent = true
            AND a.sha256 = $1
          LIMIT 64`,
        [sha256],
      );
      return result.rows.map((row) => ({
        snapshot: row.snapshot, assetId: row.asset_id, objectPath: row.bucket_path, bytes: Number(row.bytes), sha256: row.sha256, contentType: row.content_type,
      }));
    },
  };
}

export type PublicAssetDeps = { store: () => PublicAssetStore | null; storage: () => ObjectStorage | null; readTimeoutMs?: number };

const noStore = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex" };
const notFound = () => Response.json({ error: "not_found" }, { status: 404, headers: noStore });
const unavailable = () => Response.json({ error: "unavailable" }, { status: 503, headers: noStore });

function publishedAsset(snapshot: unknown, file: string, id: string): PublishedAsset | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const document = { ...snapshot as Record<string, unknown> };
  delete document.fingerprint;
  const parsed = parsePublishedDoc(document, { requireProjection: true });
  // Assets are public only when a current personal-site publication authorizes them.
  if (!parsed.ok || parsed.value.dest !== "site") return null;
  const assets = [...parsed.value.assets, ...(parsed.value.cover ? [parsed.value.cover] : [])];
  return assets.find((asset) => {
    if (asset.id !== id || asset.sha256 !== file.slice(0, 64)) return false;
    try { return new URL(asset.url).pathname === `/assets/${file}`; } catch { return false; }
  }) ?? null;
}

async function readVerifiedBytes(source: ReadableStream<Uint8Array>, expectedBytes: number, expectedSha256: string, timeoutMs: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("asset read timed out");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const part = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("asset read timed out")), remaining); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (part.done) break;
      total += part.value.byteLength;
      if (total > expectedBytes || total > IMAGE_MAX_BYTES) throw new Error("stored object exceeds verified length");
      chunks.push(part.value);
    }
    if (total !== expectedBytes) throw new Error("stored object length changed");
    const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(total));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new Error("stored object digest changed");
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Anonymous public image read, authorized from current publication state on every request. */
export async function readPublicAssetRoute(file: string, deps: PublicAssetDeps): Promise<Response> {
  const match = FILE.exec(file);
  if (!match) return notFound();
  const expectedType = TYPES[match[2]!];
  const timeoutMs = deps.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const store = deps.store();
  const storage = deps.storage();
  if (!store || !storage) return unavailable();
  try {
    const rows = await store.candidates(match[1]!);
    for (const row of rows) {
      if (!Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > IMAGE_MAX_BYTES) return unavailable();
      const asset = publishedAsset(row.snapshot, file, row.assetId);
      if (!asset || row.sha256 !== asset.sha256 || row.contentType !== expectedType || asset.contentType !== expectedType || row.bytes !== asset.bytes
        || row.objectPath !== imageObjectPath(row.assetId)) continue;
      const object = await storage.readObject(row.objectPath);
      if (!object) return notFound();
      if (object.sizeBytes !== row.bytes || object.contentType !== expectedType) {
        await object.body.cancel().catch(() => undefined);
        return unavailable();
      }
      const bytes = await readVerifiedBytes(object.body, row.bytes, row.sha256, timeoutMs);
      return new Response(bytes, {
        status: 200,
        headers: { ...noStore, "content-type": expectedType, "content-length": String(row.bytes), "content-disposition": "inline" },
      });
    }
    return notFound();
  } catch {
    return unavailable();
  }
}
