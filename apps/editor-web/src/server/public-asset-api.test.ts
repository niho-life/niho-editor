import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { IMAGE_MAX_BYTES } from "@niho/editor-store";
import { snapshot } from "../public-api/testing/synthetic";
import type { ObjectStorage } from "../storage/types";
import { readPublicAssetRoute, type PublicAssetDeps, type PublicAssetRow } from "./public-asset-api";

vi.mock("server-only", () => ({}));

const ID = "00000000-0000-4000-8000-000000000042";
const BYTES = Uint8Array.of(1, 2, 3);
const SHA = createHash("sha256").update(BYTES).digest("hex");
const FILE = `${SHA}.jpg`;
const ASSET = { id: ID, url: `https://assets.editor.example/assets/${FILE}`, contentType: "image/jpeg" as const, bytes: 3, sha256: SHA, alt: "Figure-specific alt", credit: null };
const SNAPSHOT = { ...snapshot({ id: "00000000-0000-4000-8000-000000000001", dest: "exp", slug: "sample", title: "Sample", updatedAt: "2026-11-03T00:00:00.000Z" }), range: "live", cover: ASSET, fingerprint: "cd".repeat(32) };
const ROW: PublicAssetRow = { snapshot: SNAPSHOT, assetId: ID, objectPath: `image/${ID}`, bytes: 3, sha256: SHA, contentType: "image/jpeg" };

function deps(rows: readonly PublicAssetRow[] = [ROW], stored: { bytes?: Uint8Array; body?: ReadableStream<Uint8Array>; contentType?: string | null; sizeBytes?: number } | null = {}, readTimeoutMs?: number) {
  const readObject = vi.fn(async () => stored === null ? null : {
    body: stored.body ?? new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(stored.bytes ?? BYTES); controller.close(); } }),
    contentType: stored.contentType === undefined ? "image/jpeg" : stored.contentType,
    sizeBytes: stored.sizeBytes ?? (stored.bytes ?? BYTES).byteLength,
  });
  const storage = { kind: "fake", readObject } as unknown as ObjectStorage;
  const value: PublicAssetDeps = { store: () => ({ candidates: async () => rows }), storage: () => storage, ...(readTimeoutMs === undefined ? {} : { readTimeoutMs }) };
  return { value, readObject };
}

describe("public current-publication assets", () => {
  it("serves an exact current snapshot even when its figure alt differs from current asset metadata", async () => {
    const fixture = deps();
    const response = await readPublicAssetRoute(FILE, fixture.value);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-length")).toBe("3");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(fixture.readObject).toHaveBeenCalledWith(`image/${ID}`);
    expect([...response.headers].join(" ")).not.toContain(ID);
  });

  it("returns the same 404 for malformed names, old/unpublished assets, another asset, audio, or revoked consent candidates", async () => {
    const wrong = { ...ROW, assetId: "00000000-0000-4000-8000-000000000099" };
    for (const [file, rows] of [["bad.jpg", [ROW]], [FILE, []], [FILE, [wrong]]] as const) {
      const fixture = deps(rows);
      const response = await readPublicAssetRoute(file, fixture.value);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
      expect(fixture.readObject).not.toHaveBeenCalled();
    }
  });

  it("fails closed with 503 for missing dependencies and inconsistent private storage", async () => {
    expect((await readPublicAssetRoute(FILE, { store: () => null, storage: () => null })).status).toBe(503);
    expect((await readPublicAssetRoute(FILE, deps([ROW], { sizeBytes: 4 }).value)).status).toBe(503);
    expect((await readPublicAssetRoute(FILE, deps([ROW], { contentType: "image/png" }).value)).status).toBe(503);
    expect((await readPublicAssetRoute(FILE, deps([ROW], { bytes: Uint8Array.of(1, 2, 3, 4), sizeBytes: 3 }).value)).status).toBe(503);
  });

  it("rejects same-size content with a different digest before opening a public response", async () => {
    const response = await readPublicAssetRoute(FILE, deps([ROW], { bytes: Uint8Array.of(3, 2, 1), sizeBytes: 3 }).value);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
  });

  it("rejects oversized metadata without reading the object and times out a stalled body", async () => {
    const oversized = deps([{ ...ROW, bytes: IMAGE_MAX_BYTES + 1 }]);
    expect((await readPublicAssetRoute(FILE, oversized.value)).status).toBe(503);
    expect(oversized.readObject).not.toHaveBeenCalled();

    const stalled = new ReadableStream<Uint8Array>({});
    const timeout = await readPublicAssetRoute(FILE, deps([ROW], { body: stalled, sizeBytes: 3 }, 10).value);
    expect(timeout.status).toBe(503);
    expect(await timeout.json()).toEqual({ error: "unavailable" });
  });
});
