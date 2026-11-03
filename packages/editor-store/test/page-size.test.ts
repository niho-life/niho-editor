import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PAGE_MAX_BYTES, pageImageIds, pageSizeBytes } from "../src/page-size.ts";

const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";

describe("page byte accounting", () => {
  it("counts UTF-8 title and canonical JSON, each referenced ready image once and every uploading reservation", () => {
    const blocks = [
      { type: "image", attrs: { assetId: first } },
      { type: "paragraph", content: [{ type: "image", attrs: { assetId: first } }] },
    ];
    const images = [
      { id: first, bytes: 10, status: "ready" as const },
      { id: second, bytes: 20, status: "ready" as const },
      { id: "00000000-0000-4000-8000-000000000003", bytes: 30, status: "uploading" as const },
    ];
    assert.deepEqual([...pageImageIds(blocks)], [first]);
    assert.equal(pageSizeBytes("あ", blocks, images), 3 + new TextEncoder().encode(JSON.stringify(blocks)).byteLength + 40);
    assert.equal(pageSizeBytes("あ", [], images), 3 + 2 + 30);
  });

  it("counts the cover once when it is also used in the body, and counts UTF-8 lead text", () => {
    const blocks = [{ type: "image", attrs: { assetId: first } }];
    const images = [{ id: first, bytes: 19, status: "ready" as const }];
    const size = pageSizeBytes("題", blocks, images, first, "説明");
    assert.equal(size, new TextEncoder().encode("題説明").byteLength + new TextEncoder().encode(JSON.stringify(blocks)).byteLength + 19);
  });

  it("accepts the exact 30 MiB boundary and rejects the next byte", () => {
    const blocks: { type: string }[] = [];
    const overhead = pageSizeBytes("あ", blocks, []);
    assert.equal(pageSizeBytes("あ", blocks, [{ id: first, bytes: PAGE_MAX_BYTES - overhead, status: "uploading" }]), PAGE_MAX_BYTES);
    assert.ok(pageSizeBytes("あ", blocks, [{ id: first, bytes: PAGE_MAX_BYTES - overhead + 1, status: "uploading" }]) > PAGE_MAX_BYTES);
  });
});
