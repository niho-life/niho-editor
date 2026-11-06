import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations } from "../src/migrate.ts";
import { EditorStore } from "../src/store.ts";
import {
  GOOGLE_DOCS_BATCH_MAX_ITEM_BYTES,
  GOOGLE_DOCS_BATCH_MAX_RAW_SOURCE_BYTES,
  GoogleDocsBatchStoreError,
  attachGoogleDocsBatchGrant,
  cancelGoogleDocsBatch,
  claimGoogleDocsBatchItem,
  completeGoogleDocsBatchItem,
  getGoogleDocsBatch,
  getLatestGoogleDocsBatchForRoot,
  listGoogleDocsBatchOutbox,
  markGoogleDocsBatchItemSent,
  markGoogleDocsBatchGrantRevoked,
  prepareGoogleDocsBatch,
  purgeExpiredGoogleDocsBatches,
  purgeOwnerGoogleDocsBatchData,
  readGoogleDocsBatchTree,
  readGoogleDocsBatchSource,
  recoverGoogleDocsBatchDispatches,
  requeueGoogleDocsBatchItem,
  type GoogleDocsBatchTreePage,
  type PrepareGoogleDocsBatchInput,
} from "../src/google-docs-batches.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const OWNER = "synthetic-google-docs-owner";
const OTHER = "synthetic-google-docs-other";
const blocks = [{ type: "paragraph", content: [{ type: "text", text: "合成本文 😀" }] }];
const envelope = { keyId: "v1", nonce: new Uint8Array(12), ciphertext: new Uint8Array([1, 2, 3]), tag: new Uint8Array(16) };

function payload(page: GoogleDocsBatchTreePage, bytes = 32) {
  return {
    title: page.title, markdown: "合成本文 😀", payloadSha256: "a".repeat(64), payloadBytes: bytes,
    omissions: [{ reason: "image_omitted", count: 1 }], envelope,
  };
}
function ids(rootPageId: string, selections: Array<{ pageId: string; expectedRevision: number }>, extra: Partial<PrepareGoogleDocsBatchInput> = {}): PrepareGoogleDocsBatchInput {
  return {
    jobId: randomUUID(), rootPageId, operationId: randomUUID(), requestSha256: "b".repeat(64),
    selections: selections.map((selection) => ({ ...selection, itemId: randomUUID(), exportId: randomUUID() })),
    options: { includeBackground: false, includeTranscript: false },
    expiresAt: new Date(Date.now() + (23 * 60 + 40) * 60_000).toISOString(), prepare: (page) => payload(page),
    ...extra,
  };
}

describe("Google Docs durable batches", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_google_docs_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;
  let store: EditorStore;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try { await applyMigrations(client); } finally { client.release(); }
    store = new EditorStore(pool);
  });

  /** 親子を直に書く（旧データの「本文のある親ページ」と工程のサブページの形。movePage はフォルダにしか入れない）。 */
  const nest = async (child: string, parent: string) => {
    await pool.query("UPDATE pages SET parent = $2 WHERE owner = $1 AND id = $3", [OWNER, parent, child]);
  };

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("ownerのactive treeを木順で固定し、revision/selection/operation idempotencyをtransactionで守る", async () => {
    const root = await store.createPage(OWNER, { title: "親", blocks });
    const child = await store.createPage(OWNER, { title: "子", blocks });
    const grandchild = await store.createPage(OWNER, { title: "孫", blocks });
    const other = await store.createPage(OTHER, { title: "他人", blocks });
    await nest(child.id, root.id);
    await nest(grandchild.id, child.id);
    const tree = await readGoogleDocsBatchTree(pool, OWNER, root.id);
    assert.deepEqual(tree?.map((page) => [page.title, page.depth]), [["親", 0], ["子", 1], ["孫", 2]]);
    assert.equal(await readGoogleDocsBatchTree(pool, OTHER, root.id), null, "other owner is indistinguishable from missing");

    const selected = tree!.slice(0, 2).map((page) => ({ pageId: page.id, expectedRevision: page.revision }));
    const input = ids(root.id, selected);
    const first = await prepareGoogleDocsBatch(pool, OWNER, input);
    assert.equal(first.created, true);
    const replay = await prepareGoogleDocsBatch(pool, OWNER, { ...input, jobId: randomUUID(), selections: input.selections.map((item) => ({ ...item, itemId: randomUUID(), exportId: randomUUID() })) });
    assert.equal(replay.created, false);
    assert.equal(replay.job.id, first.job.id, "same operation/request converges on the original snapshot");
    await assert.rejects(
      () => prepareGoogleDocsBatch(pool, OWNER, { ...input, jobId: randomUUID(), requestSha256: "c".repeat(64) }),
      (error: unknown) => error instanceof GoogleDocsBatchStoreError && error.code === "operation_conflict",
    );
    await assert.rejects(
      () => prepareGoogleDocsBatch(pool, OWNER, ids(root.id, [{ pageId: root.id, expectedRevision: root.revision + 99 }])),
      (error: unknown) => error instanceof GoogleDocsBatchStoreError && error.code === "revision_conflict",
    );
    await assert.rejects(
      () => prepareGoogleDocsBatch(pool, OWNER, ids(root.id, [{ pageId: other.id, expectedRevision: other.revision }])),
      (error: unknown) => error instanceof GoogleDocsBatchStoreError && error.code === "invalid_selection",
    );
    await assert.rejects(
      () => prepareGoogleDocsBatch(pool, OWNER, ids(root.id, [...selected].reverse())),
      (error: unknown) => error instanceof GoogleDocsBatchStoreError && error.code === "invalid_selection",
    );

    const db = await pool.query<{ plaintext_position: number; payload_ciphertext: Buffer }>(
      `SELECT position(convert_to($2,'UTF8') in payload_ciphertext) AS plaintext_position,payload_ciphertext
         FROM google_docs_batch_items WHERE job_id=$1 ORDER BY ordinal LIMIT 1`, [first.job.id, "合成本文 😀"],
    );
    assert.ok(db.rows[0]?.payload_ciphertext);
    assert.equal(db.rows[0]?.plaintext_position, 0, "DB stores only the envelope, never title/body JSON");
    assert.equal((await getLatestGoogleDocsBatchForRoot(pool, OWNER, root.id))?.job.id, first.job.id);

    await assert.rejects(
      () => prepareGoogleDocsBatch(pool, OWNER, ids(root.id, [{ pageId: root.id, expectedRevision: tree![0]!.revision }], { prepare: (page) => payload(page, GOOGLE_DOCS_BATCH_MAX_ITEM_BYTES + 1) })),
      (error: unknown) => error instanceof GoogleDocsBatchStoreError && error.code === "payload_too_large",
    );
  });

  it("lease/generation CASで重複workerを止め、cancel後はpayload無しreceipt-onlyで同じitemを完了回収する", async () => {
    const root = await store.createPage(OWNER, { title: "取消対象", blocks });
    const current = (await readGoogleDocsBatchTree(pool, OWNER, root.id))![0]!;
    const prepared = await prepareGoogleDocsBatch(pool, OWNER, ids(root.id, [{ pageId: root.id, expectedRevision: current.revision }]));
    const grantId = randomUUID();
    assert.equal(await attachGoogleDocsBatchGrant(pool, OWNER, prepared.job.id, grantId, new Date(Date.now() + 24 * 60 * 60_000).toISOString()), true);
    assert.deepEqual(await listGoogleDocsBatchOutbox(pool), [{ jobId: prepared.job.id, generation: 1, dispatchAttempt: 1 }]);
    const claim = await claimGoogleDocsBatchItem(pool, prepared.job.id, 1);
    assert.ok(claim && !claim.receiptOnly && claim.envelope);
    assert.equal(await claimGoogleDocsBatchItem(pool, prepared.job.id, 1), null, "active lease rejects a duplicate worker");
    assert.equal(await markGoogleDocsBatchItemSent(pool, claim), true);
    assert.equal(await requeueGoogleDocsBatchItem(pool, claim, { errorCode: "export_unknown", retryable: false, delaySeconds: 0 }), true);
    assert.deepEqual(await cancelGoogleDocsBatch(pool, OWNER, prepared.job.id), { grantId, inflight: true });
    assert.equal(await markGoogleDocsBatchGrantRevoked(pool, OWNER, prepared.job.id, grantId), true);
    assert.equal((await getGoogleDocsBatch(pool, OWNER, prepared.job.id))?.job.grantRevoked, true);
    assert.deepEqual(await cancelGoogleDocsBatch(pool, OWNER, prepared.job.id), { grantId: null, inflight: true });
    const cleared = await pool.query<{ payload_ciphertext: Buffer | null }>("SELECT payload_ciphertext FROM google_docs_batch_items WHERE job_id=$1", [prepared.job.id]);
    assert.equal(cleared.rows[0]?.payload_ciphertext, null, "cancel immediately purges the snapshot payload");
    const receipt = await claimGoogleDocsBatchItem(pool, prepared.job.id, 2);
    assert.ok(receipt?.receiptOnly);
    assert.equal(receipt.envelope, null);
    assert.equal(receipt.exportId, claim.exportId, "receipt recovery keeps the same export id");
    const documentId = `A${"b".repeat(255)}`;
    assert.equal(await completeGoogleDocsBatchItem(pool, receipt, documentId), true);
    const done = await getGoogleDocsBatch(pool, OWNER, prepared.job.id);
    assert.equal(done?.job.status, "cancelled");
    assert.equal(done?.items[0]?.status, "completed");
    assert.equal(done?.items[0]?.documentId, documentId, "the maximum 256-character document id is stored");
  });

  it("expiryとowner/page消去がsnapshot/outboxをpurgeし、既存Google文書情報だけは削除要求しない", async () => {
    const receiptOwner = "synthetic-google-docs-expiry-receipt";
    const inflightPage = await store.createPage(receiptOwner, { title: "期限直前の送信", blocks });
    const inflightTree = (await readGoogleDocsBatchTree(pool, receiptOwner, inflightPage.id))![0]!;
    const inflight = await prepareGoogleDocsBatch(pool, receiptOwner, ids(inflightPage.id, [{ pageId: inflightPage.id, expectedRevision: inflightTree.revision }]));
    assert.equal(await attachGoogleDocsBatchGrant(pool, receiptOwner, inflight.job.id, randomUUID(), new Date(Date.now() + 5 * 60_000).toISOString()), true);
    const sent = await claimGoogleDocsBatchItem(pool, inflight.job.id, 1);
    assert.ok(sent);
    assert.equal(await markGoogleDocsBatchItemSent(pool, sent), true);
    await pool.query(
      "UPDATE google_docs_batch_jobs SET created_at=statement_timestamp()-interval '23 hours 51 minutes',expires_at=statement_timestamp()-interval '1 minute' WHERE id=$1",
      [inflight.job.id],
    );
    assert.equal(await purgeExpiredGoogleDocsBatches(pool, receiptOwner), 1);
    assert.equal((await getGoogleDocsBatch(pool, receiptOwner, inflight.job.id))?.job.status, "cancelling");
    assert.equal(await requeueGoogleDocsBatchItem(pool, sent, { errorCode: "receipt_pending", retryable: false, delaySeconds: 0 }), true);
    const expiredReceipt = await claimGoogleDocsBatchItem(pool, inflight.job.id, 2);
    assert.ok(expiredReceipt?.receiptOnly && expiredReceipt.envelope === null, "expired inflight becomes receipt-only until grant expiry");
    await pool.query(
      "UPDATE google_docs_batch_jobs SET lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1",
      [inflight.job.id],
    );
    assert.equal(await recoverGoogleDocsBatchDispatches(pool), 1, "sweep recovers a receipt after the local payload expiry");

    const expiring = await store.createPage(OWNER, { title: "期限切れ", blocks });
    const page = (await readGoogleDocsBatchTree(pool, OWNER, expiring.id))![0]!;
    const batch = await prepareGoogleDocsBatch(pool, OWNER, ids(expiring.id, [{ pageId: expiring.id, expectedRevision: page.revision }]));
    await pool.query(
      "UPDATE google_docs_batch_jobs SET created_at=statement_timestamp()-interval '24 hours',expires_at=statement_timestamp()-interval '10 minutes' WHERE id=$1",
      [batch.job.id],
    );
    assert.equal(await purgeExpiredGoogleDocsBatches(pool, OWNER), 1);
    const expired = await pool.query<{ status: string; payload_ciphertext: Buffer | null }>(
      "SELECT i.status,i.payload_ciphertext FROM google_docs_batch_items i WHERE i.job_id=$1", [batch.job.id],
    );
    assert.deepEqual(expired.rows[0], { status: "expired", payload_ciphertext: null });
    assert.equal(await purgeExpiredGoogleDocsBatches(pool, OWNER), 0, "回収済みのterminal jobを繰り返し更新しない");

    const softRoot = await store.createPage(OWNER, { title: "ゴミ箱root", blocks });
    const softChild = await store.createPage(OWNER, { title: "ゴミ箱child", blocks });
    await nest(softChild.id, softRoot.id);
    const softTree = (await readGoogleDocsBatchTree(pool, OWNER, softRoot.id))!;
    const softChildMetadata = softTree.find((source) => source.id === softChild.id)!;
    const softBatch = await prepareGoogleDocsBatch(
      pool,
      OWNER,
      ids(softRoot.id, [{ pageId: softChild.id, expectedRevision: softChildMetadata.revision }]),
    );
    assert.equal(await attachGoogleDocsBatchGrant(pool, OWNER, softBatch.job.id, randomUUID(), softBatch.job.expiresAt), true);
    const claimedBeforeDelete = await claimGoogleDocsBatchItem(pool, softBatch.job.id, 1);
    assert.ok(claimedBeforeDelete, "item is claimed before the page deletion commits");
    assert.equal(await store.deletePage(OWNER, softRoot.id), "deleted");
    assert.equal(await markGoogleDocsBatchItemSent(pool, claimedBeforeDelete), false, "a committed soft delete fences Google create");
    assert.equal(await getGoogleDocsBatch(pool, OWNER, softBatch.job.id), null, "an unselected root soft-delete purges payload/outbox");

    const childRoot = await store.createPage(OWNER, { title: "子だけ削除root", blocks });
    const childSource = await store.createPage(OWNER, { title: "子だけ削除child", blocks });
    await nest(childSource.id, childRoot.id);
    const childMetadata = (await readGoogleDocsBatchTree(pool, OWNER, childRoot.id))!.find((source) => source.id === childSource.id)!;
    const childBatch = await prepareGoogleDocsBatch(
      pool,
      OWNER,
      ids(childRoot.id, [{ pageId: childSource.id, expectedRevision: childMetadata.revision }]),
    );
    assert.equal(await store.deletePage(OWNER, childSource.id), "deleted");
    assert.equal(await getGoogleDocsBatch(pool, OWNER, childBatch.job.id), null, "a selected child soft-delete purges payload/outbox");

    const removing = await store.createPage(OWNER, { title: "消去root", blocks });
    const removingChild = await store.createPage(OWNER, { title: "消去child", blocks });
    await nest(removingChild.id, removing.id);
    const removingTree = (await readGoogleDocsBatchTree(pool, OWNER, removing.id))!;
    const removingBatch = await prepareGoogleDocsBatch(
      pool,
      OWNER,
      ids(removing.id, removingTree.map((source) => ({ pageId: source.id, expectedRevision: source.revision }))),
    );
    await pool.query("DELETE FROM pages WHERE owner=$1 AND id=$2", [OWNER, removingChild.id]);
    assert.equal(await getGoogleDocsBatch(pool, OWNER, removingBatch.job.id), null, "any selected source hard-delete cascades the whole snapshot/outbox");

    await purgeOwnerGoogleDocsBatchData(pool, OWNER);
    const remaining = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM google_docs_batch_jobs WHERE owner=$1", [OWNER]);
    assert.equal(remaining.rows[0]?.n, "0");
  });

  it("32 MiB超のraw sourceはJSONBをNodeへ返さず開始前に拒否する", async () => {
    const page = await store.createPage(OWNER, { title: "巨大raw source", blocks });
    const child = await store.createPage(OWNER, { title: "選択した小さい子", blocks });
    await nest(child.id, page.id);
    await pool.query(
      `UPDATE pages SET blocks=jsonb_build_array(jsonb_build_object(
         'type','paragraph','content',jsonb_build_array(jsonb_build_object('type','text','text',repeat('x',$3)))
       )) WHERE owner=$1 AND id=$2`,
      [OWNER, page.id, GOOGLE_DOCS_BATCH_MAX_RAW_SOURCE_BYTES + 1],
    );
    const tree = (await readGoogleDocsBatchTree(pool, OWNER, page.id))!;
    const metadata = tree[0]!;
    const childMetadata = tree.find((source) => source.id === child.id)!;
    const selectedChild = await prepareGoogleDocsBatch(
      pool,
      OWNER,
      ids(page.id, [{ pageId: child.id, expectedRevision: childMetadata.revision }]),
    );
    assert.equal(selectedChild.created, true, "prepare never reads an unselected rich root source");
    assert.deepEqual(
      await readGoogleDocsBatchSource(pool, OWNER, metadata, { includeBackground: false, includeTranscript: false }),
      { ok: false, reason: "source_too_large" },
    );
    const rejected = ids(page.id, [{ pageId: page.id, expectedRevision: metadata.revision }]);
    await assert.rejects(
      () => prepareGoogleDocsBatch(pool, OWNER, rejected),
      (error: unknown) => error instanceof GoogleDocsBatchStoreError && error.code === "source_too_large",
    );
    assert.equal(await getGoogleDocsBatch(pool, OWNER, rejected.jobId), null, "source limit rolls the job transaction back");
  });
});
