import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IMAGE_OBJECT_PREFIX,
  InvalidImageError,
  completeImageUpload,
  countPageImages,
  imageAsset,
  imageObjectPath,
  sharedImageAsset,
  startImageUpload,
  updateImageMeta,
  type StartImageUploadInput,
} from "../src/images.ts";
import { readMigrations } from "../src/migrate.ts";
import type { Connectable } from "../src/recordings.ts";
import type { Queryable } from "../src/types.ts";

const PAGE = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const ASSET = "9a1f3b1c-0d11-4c39-9a52-6f6c6f1d0d7c";
const SHA = "a".repeat(64);

function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function startInput(extra: Partial<StartImageUploadInput> = {}): StartImageUploadInput {
  return { assetId: ASSET, pageId: PAGE, contentType: "image/png", bytes: 1024, sha256: SHA, uploadKey: null, requestHash: "1".repeat(64), ...extra };
}

describe("0011_image_assets.sql", () => {
  it("only adds the upload columns and constraints to assets, keeping every existing row", async () => {
    const file = (await readMigrations()).find((item) => item.name === "0011_image_assets.sql");
    assert.ok(file, "0011 is in the ordered list");
    const sql = withoutComments(file.sql);
    for (const column of ["ADD COLUMN upload_status text NOT NULL DEFAULT 'ready'", "ADD COLUMN upload_key uuid", "ADD COLUMN request_hash text"]) {
      assert.ok(sql.includes(column), column);
    }
    assert.match(sql, /CHECK \(upload_status IN \('uploading', 'ready'\)\)/);
    assert.match(sql, /CHECK \(request_hash IS NULL OR request_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    // 冪等キーは owner ごとに 1 つ（NULL は重複してよい）
    assert.match(sql, /UNIQUE \(owner, upload_key\)/);
    assert.doesNotMatch(sql, /\bDROP\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b|\bINSERT\s+INTO\b/i, "0011 must keep every existing row");
    // 既存の音声の資産は 'ready' のまま（DEFAULT で入る）
    assert.ok(sql.includes("DEFAULT 'ready'"));
  });

  it("comes after 0008 so the numbers do not collide with the other open branches", async () => {
    const names = (await readMigrations()).map((file) => file.name);
    assert.ok(names.includes("0011_image_assets.sql"));
    assert.deepEqual([...names].sort(), names);
    assert.equal(names.filter((name) => name.startsWith("0011")).length, 1);
  });
});

describe("images without a database", () => {
  const untouchable = {
    query: () => {
      throw new Error("must not reach the database");
    },
    connect: () => {
      throw new Error("must not reach the database");
    },
  };
  const db = untouchable as unknown as Queryable;
  const pool = untouchable as unknown as Connectable;

  it("builds the object path under image/ from a UUID only", () => {
    assert.equal(IMAGE_OBJECT_PREFIX, "image/");
    assert.equal(imageObjectPath("6F1D0D7C-6F6C-4C39-9A52-6A1F3B1C0D11"), "image/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11");
    for (const id of ["", "x", "../etc", `${PAGE}/..`, "gs://bucket/a", "image/x"]) {
      assert.throws(() => imageObjectPath(id), TypeError, id);
    }
  });

  it("treats ids that are not UUIDs as missing without querying", async () => {
    for (const id of ["", "not-a-uuid", `${PAGE}' OR '1'='1`]) {
      assert.equal(await imageAsset(db, "stub-user", id), null);
      assert.equal(await completeImageUpload(pool, "stub-user", id, { sizeBytes: 1 }), null);
      assert.equal(await updateImageMeta(db, "stub-user", id, { consent: true }), null);
      assert.equal(await countPageImages(db, "stub-user", id), null);
      assert.equal(await sharedImageAsset(db, "s".repeat(43), id), null);
    }
    // 形の違う共有の token も DB に問い合わせない
    for (const token of ["", "short", "s".repeat(44), "../../etc"]) assert.equal(await sharedImageAsset(db, token, ASSET), null);
  });

  it("refuses an empty owner instead of reading rows of nobody", async () => {
    for (const owner of ["", "x".repeat(257)]) {
      await assert.rejects(() => startImageUpload(pool, owner, startInput()), TypeError);
      await assert.rejects(() => imageAsset(db, owner, ASSET), TypeError);
      await assert.rejects(() => completeImageUpload(pool, owner, ASSET, { sizeBytes: 1 }), TypeError);
      await assert.rejects(() => updateImageMeta(db, owner, ASSET, { consent: true }), TypeError);
      await assert.rejects(() => countPageImages(db, owner, PAGE), TypeError);
    }
  });

  it("refuses a start request whose shape is wrong, naming the problem, without querying", async () => {
    const cases: Array<[Partial<StartImageUploadInput>, string]> = [
      [{ assetId: "x" }, "asset"],
      [{ pageId: "x" }, "page"],
      [{ contentType: "image" }, "content_type"],
      [{ contentType: "IMAGE/PNG" }, "content_type"],
      [{ contentType: "x".repeat(256) }, "content_type"],
      [{ bytes: 0 }, "bytes"],
      [{ bytes: 1.5 }, "bytes"],
      [{ bytes: 20 * 1024 * 1024 + 1 }, "bytes"],
      [{ sha256: "x" }, "sha256"],
      [{ uploadKey: "x" }, "upload_key"],
      [{ requestHash: "x" }, "request_hash"],
    ];
    for (const [extra, problem] of cases) {
      await assert.rejects(
        () => startImageUpload(pool, "stub-user", startInput(extra)),
        (error: unknown) => error instanceof InvalidImageError && error.problem === problem,
        problem,
      );
    }
  });

  it("refuses a meta patch that the column would reject, naming the problem, without querying", async () => {
    const cases: Array<[Parameters<typeof updateImageMeta>[3], string]> = [
      [{ alt: "a".repeat(1001) }, "alt"],
      [{ alt: "一行目\n二行目" }, "alt"],
      [{ alt: "ぬる\u0000文字" }, "alt"],
      [{ credit: "c".repeat(501) }, "credit"],
      [{ credit: "改行 入り" }, "credit"],
      [{ consent: "true" as unknown as boolean }, "consent"],
      [{ share: 1 as unknown as boolean }, "share"],
    ];
    for (const [patch, problem] of cases) {
      await assert.rejects(
        () => updateImageMeta(db, "stub-user", ASSET, patch),
        (error: unknown) => error instanceof InvalidImageError && error.problem === problem,
        problem,
      );
    }
  });

  it("refuses a stored size that is not a non-negative integer", async () => {
    for (const sizeBytes of [-1, 1.5, Number.NaN, "1" as unknown as number]) {
      await assert.rejects(() => completeImageUpload(pool, "stub-user", ASSET, { sizeBytes }), TypeError, String(sizeBytes));
    }
  });
});
