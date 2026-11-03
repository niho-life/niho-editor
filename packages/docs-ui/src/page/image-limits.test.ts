import { describe, expect, it } from "vitest";
import {
  IMAGE_ACCEPT,
  IMAGE_ALT_MAX_CHARS,
  IMAGE_CONTENT_TYPES,
  IMAGE_CREDIT_MAX_CHARS,
  IMAGE_MAX_BYTES,
  IMAGE_PAGE_MAX_COUNT,
  PAGE_MAX_BYTES,
  imageRequestCanonical,
  isAllowedImageSize,
  isAllowedImageType,
  validateImageStart,
} from "./image-limits";

const SHA = "a".repeat(64);
const PAGE = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

describe("the image limits", () => {
  it("are the documented values and types", () => {
    expect(IMAGE_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(PAGE_MAX_BYTES).toBe(30 * 1024 * 1024);
    expect(IMAGE_PAGE_MAX_COUNT).toBe(100);
    expect(IMAGE_ALT_MAX_CHARS).toBe(1000);
    expect(IMAGE_CREDIT_MAX_CHARS).toBe(500);
    expect([...IMAGE_CONTENT_TYPES]).toEqual(["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]);
    expect(IMAGE_ACCEPT).toBe("image/jpeg,image/png,image/webp,image/avif,image/gif");
  });

  it("accepts only the five types, in any letter case, and nothing script-bearing", () => {
    for (const type of ["image/jpeg", "image/png", "IMAGE/WEBP", " image/avif ", "image/gif"]) expect(isAllowedImageType(type), type).toBe(true);
    for (const type of ["image/svg+xml", "image/bmp", "image/heic", "text/html", "application/pdf", "image", "", null, undefined, 1]) {
      expect(isAllowedImageType(type), String(type)).toBe(false);
    }
  });

  it("accepts a size from one byte up to the limit", () => {
    for (const size of [1, 1024, IMAGE_MAX_BYTES]) expect(isAllowedImageSize(size), String(size)).toBe(true);
    for (const size of [0, -1, 1.5, IMAGE_MAX_BYTES + 1, Number.NaN, "1", null]) expect(isAllowedImageSize(size), String(size)).toBe(false);
  });

  it("refuses a start request with the reason, in the order type → size → hash", () => {
    expect(validateImageStart({ contentType: "image/png", sizeBytes: 10, sha256: SHA })).toEqual({
      ok: true,
      value: { contentType: "image/png", sizeBytes: 10, sha256: SHA },
    });
    // 大文字・前後の空白は正規化する
    expect(validateImageStart({ contentType: " IMAGE/PNG ", sizeBytes: 10, sha256: SHA })).toMatchObject({ ok: true, value: { contentType: "image/png" } });
    const cases: Array<[unknown, unknown, unknown, string]> = [
      ["image/svg+xml", 10, SHA, "content_type"],
      [undefined, 10, SHA, "content_type"],
      ["image/png", 0, SHA, "size"],
      ["image/png", 1.5, SHA, "size"],
      ["image/png", "10", SHA, "size"],
      ["image/png", IMAGE_MAX_BYTES + 1, SHA, "too_large"],
      ["image/png", 10, "x", "sha256"],
      ["image/png", 10, SHA.toUpperCase(), "sha256"],
    ];
    for (const [contentType, sizeBytes, sha256, reason] of cases) {
      expect(validateImageStart({ contentType, sizeBytes, sha256 }), reason).toEqual({ ok: false, reason });
    }
  });

  it("makes the idempotency comparison depend on the page and on every declared value", () => {
    const start = { contentType: "image/png", sizeBytes: 10, sha256: SHA };
    const base = imageRequestCanonical(PAGE, start);
    expect(imageRequestCanonical(PAGE.toUpperCase(), start)).toBe(base);
    for (const other of [
      imageRequestCanonical("7f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11", start),
      imageRequestCanonical(PAGE, { ...start, contentType: "image/jpeg" }),
      imageRequestCanonical(PAGE, { ...start, sizeBytes: 11 }),
      imageRequestCanonical(PAGE, { ...start, sha256: "b".repeat(64) }),
    ]) {
      expect(other).not.toBe(base);
    }
  });
});
