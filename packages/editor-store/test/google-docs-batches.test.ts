import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GOOGLE_DOCS_BATCH_MAX_RAW_SOURCE_BYTES,
  markGoogleDocsBatchItemSent,
  readGoogleDocsBatchSource,
  readGoogleDocsBatchTree,
  type GoogleDocsBatchTreePageMetadata,
  type ClaimedGoogleDocsBatchItem,
} from "../src/google-docs-batches.ts";
import type { Queryable } from "../src/types.ts";

const PAGE = "00000000-0000-4000-8000-000000000001";
const metadata: GoogleDocsBatchTreePageMetadata = {
  id: PAGE,
  title: "合成ページ",
  revision: 3,
  parent: null,
  depth: 0,
  hasBackground: true,
  hasTranscript: true,
  hasRecording: true,
};

describe("Google Docs batch bounded source reads", () => {
  it("tree metadata query never returns rich source JSON", async () => {
    let sql = "";
    const db = {
      query: async (statement: string) => {
        sql = statement;
        return { rows: [{
          id: PAGE, title: "合成ページ", revision: 3, parent: null, depth: 0,
          has_background: true, has_transcript: true, has_recording: true,
        }], rowCount: 1 };
      },
    } as unknown as Queryable;
    assert.deepEqual(await readGoogleDocsBatchTree(db, "owner", PAGE), [metadata]);
    assert.doesNotMatch(sql, /p\.blocks|\bentities\s+AS\s+entities|\bsegments\s+AS\s+segments/i);
    assert.match(sql, /has_background/);
  });

  it("rejects an oversized page before JSONB can be returned to Node", async () => {
    let sql = "";
    let values: readonly unknown[] = [];
    const db = {
      query: async (statement: string, input: readonly unknown[]) => {
        sql = statement;
        values = input;
        return { rows: [{ ...metadata, raw_bytes: GOOGLE_DOCS_BATCH_MAX_RAW_SOURCE_BYTES + 1, blocks: null }], rowCount: 1 };
      },
    } as unknown as Queryable;
    assert.deepEqual(
      await readGoogleDocsBatchSource(db, "owner", metadata, { includeBackground: false, includeTranscript: false }),
      { ok: false, reason: "source_too_large" },
    );
    assert.match(sql, /CASE WHEN sized\.raw_bytes <= \$3 THEN p\.blocks ELSE NULL END/);
    assert.doesNotMatch(sql, /octet_length\(COALESCE\(f\.entities/);
    assert.doesNotMatch(sql, /octet_length\(COALESCE\(r\.segments/);
    assert.equal(values[2], GOOGLE_DOCS_BATCH_MAX_RAW_SOURCE_BYTES);
  });

  it("checks both active root and active source in the final pre-send CAS", async () => {
    let sql = "";
    const db = {
      query: async (statement: string) => { sql = statement; return { rows: [], rowCount: 0 }; },
    } as unknown as Queryable;
    const claim: ClaimedGoogleDocsBatchItem = {
      owner: "owner", jobId: PAGE, itemId: PAGE, ordinal: 0, generation: 1,
      grantId: PAGE, exportId: PAGE, payloadSha256: "a".repeat(64), payloadBytes: 1,
      envelope: null, expiresAt: "2030-01-01T00:00:00.000Z", alreadySent: false, receiptOnly: false,
    };
    assert.equal(await markGoogleDocsBatchItemSent(db, claim), false);
    assert.match(sql, /root\.deleted_at IS NULL/);
    assert.match(sql, /source\.deleted_at IS NULL/);
  });
});
