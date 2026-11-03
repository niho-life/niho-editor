import type { Block, OwnerId, Queryable } from "./types.ts";

/** Title + canonical blocks JSON + referenced ready images (including cover) + every uploading reservation. */
export const PAGE_MAX_BYTES = 30 * 1024 * 1024;
export const PAGE_IMAGE_MAX_COUNT = 100;
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

const encoder = new TextEncoder();

export function pageImageIds(blocks: Block[]): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === "image" && node.attrs && typeof node.attrs === "object") {
      const id = (node.attrs as Record<string, unknown>).assetId;
      if (typeof id === "string") ids.add(id.toLowerCase());
    }
    if (Array.isArray(node.content)) visit(node.content);
  };
  visit(blocks);
  return ids;
}

export type PageImageCharge = { id: string; bytes: number; status: "uploading" | "ready" };

export function pageSizeBytes(
  title: string,
  blocks: Block[],
  images: readonly PageImageCharge[],
  coverId: string | null = null,
  lead: string | null = null,
): number {
  const referenced = pageImageIds(blocks);
  if (coverId) referenced.add(coverId.toLowerCase());
  let size = encoder.encode(title).byteLength + encoder.encode(lead ?? "").byteLength + encoder.encode(JSON.stringify(blocks)).byteLength;
  for (const image of images) {
    if (image.status === "uploading" || referenced.has(image.id.toLowerCase())) size += image.bytes;
  }
  return size;
}

/** Call only while holding the page row FOR UPDATE, so expiry and accounting are serialized. */
export async function pageImageCharges(client: Queryable, owner: OwnerId, pageId: string): Promise<PageImageCharge[]> {
  // GCS upload sessions expire after seven days. The extra day prevents an active ticket from losing its reservation.
  await client.query(
    `DELETE FROM assets AS a WHERE a.owner = $1 AND a.page_id = $2 AND a.kind = 'image'
       AND a.upload_status = 'uploading' AND a.reservation_expires_at <= clock_timestamp()
       AND NOT EXISTS (SELECT 1 FROM pages AS p WHERE p.owner = a.owner AND p.cover = a.id)`,
    [owner, pageId],
  );
  const result = await client.query<{ id: string; bytes: string; upload_status: "uploading" | "ready" }>(
    "SELECT id, bytes::text AS bytes, upload_status FROM assets WHERE owner = $1 AND page_id = $2 AND kind = 'image'",
    [owner, pageId],
  );
  return result.rows.map((row) => ({ id: row.id, bytes: Number(row.bytes), status: row.upload_status }));
}
