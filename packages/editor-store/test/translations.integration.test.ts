import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations } from "../src/migrate.ts";
import { EditorStore } from "../src/store.ts";
import {
  adoptTranslationProposal,
  detachManagedTranslation,
  finishTranslationProposal,
  getTranslationRelation,
  managedTranslationReviewProblem,
  markTranslationCopy,
  purgeExpiredTranslationProposals,
  reviewManagedTranslation,
  startTranslationProposal,
  type StartTranslationProposalInput,
  type TranslationEnvelope,
} from "../src/translations.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const OWNER = "synthetic-translation-owner-a";
const OTHER = "synthetic-translation-owner-b";
const SHA = "a".repeat(64);

const envelope = (): TranslationEnvelope => ({ keyId: "synthetic-v1", nonce: new Uint8Array(12).fill(1), ciphertext: new Uint8Array([2, 3, 4]), tag: new Uint8Array(16).fill(5) });

describe("managed translation store", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_translation_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try { await applyMigrations(client); } finally { client.release(); }
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("converges retries, CAS-adopts an independent EN page, gates review, and never returns the target object from source GC", async () => {
    const pages = new EditorStore(pool);
    const sourceAssetId = randomUUID();
    const targetAssetId = randomUUID();
    const source = await pages.createPage(OWNER, {
      kind: "article",
      title: "合成の日本語記事",
      lang: "ja",
      lead: "合成のリード",
      blocks: [{ type: "image", attrs: { assetId: sourceAssetId, alt: "合成の海", caption: "合成の朝", credit: "Synthetic Studio", consent: true } }],
    });
    await pool.query(
      `INSERT INTO assets (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type, alt, credit, consent, upload_status)
       VALUES ($1, $2, $3, 'image', $4, 3, $5, 'image/png', '合成の海', 'Synthetic Studio', true, 'ready')`,
      [sourceAssetId, OWNER, source.id, `image/${sourceAssetId}`, SHA],
    );
    const proposalId = randomUUID();
    const operationId = randomUUID();
    const targetPageId = randomUUID();
    const start: StartTranslationProposalInput = {
      proposalId,
      operationId,
      targetPageId,
      relationId: null,
      relationVersion: null,
      inputHash: "b".repeat(64),
      sourceRevision: source.revision,
      targetRevision: null,
      fieldCount: 4,
      codepointCount: 24,
      omissions: ["写真クレジット（原文を維持）"],
      expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString(),
      envelope: envelope(),
      copies: [{
        sourceAssetId,
        targetAssetId,
        sourceObjectPath: `image/${sourceAssetId}`,
        sourceGeneration: "11",
        sourceBytes: 3,
        sourceSha256: SHA,
        sourceContentType: "image/png",
        sourceAlt: "合成の海",
        sourceCredit: "Synthetic Studio",
        sourceConsent: true,
        reused: false,
      }],
    };
    await pool.query("UPDATE assets SET alt = '並行して変わったalt' WHERE owner = $1 AND id = $2", [OWNER, sourceAssetId]);
    assert.equal(await startTranslationProposal(pool, OWNER, source.id, start), "conflict");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM page_translation_proposals WHERE id = $1", [proposalId])).rows[0].n, 0, "asset CAS rolls back the proposal");
    await pool.query("UPDATE assets SET alt = '合成の海' WHERE owner = $1 AND id = $2", [OWNER, sourceAssetId]);
    const first = await startTranslationProposal(pool, OWNER, source.id, start);
    assert.ok(first && first !== "conflict" && first.created);
    const replay = await startTranslationProposal(pool, OWNER, source.id, start);
    assert.ok(replay && replay !== "conflict" && !replay.created);
    assert.equal(replay.proposal.id, proposalId);

    assert.equal(await finishTranslationProposal(pool, OWNER, proposalId, first.proposal.generation, operationId, envelope()), true);
    assert.equal(await finishTranslationProposal(pool, OWNER, proposalId, first.proposal.generation, operationId, envelope()), false, "late duplicate completion loses the CAS");
    assert.equal(await markTranslationCopy(pool, OWNER, proposalId, sourceAssetId, { state: "copied", sourceGeneration: "11" }), true);
    const adoption = {
      sourceRevision: source.revision,
      targetRevision: null,
      kind: "article" as const,
      title: "Synthetic English guide",
      lead: "A synthetic lead",
      blocks: [{ type: "image", attrs: { assetId: targetAssetId, alt: "Synthetic sea", caption: "Synthetic morning", credit: "Synthetic Studio", consent: true } }],
      cover: targetAssetId,
      assets: [{
        sourceAssetId,
        sourceObjectPath: `image/${sourceAssetId}`,
        sourceGeneration: "11",
        sourceBytes: 3,
        sourceSha256: SHA,
        sourceContentType: "image/png",
        sourceAlt: "合成の海",
        sourceCredit: "Synthetic Studio",
        sourceConsent: true,
        targetAssetId,
        targetObjectPath: `image/${targetAssetId}`,
        bytes: 3,
        sha256: SHA,
        contentType: "image/png",
        alt: "Synthetic sea",
        credit: "Synthetic Studio",
        consent: true,
        reused: false,
      }],
    };
    await pool.query("UPDATE assets SET credit = 'Concurrent credit edit' WHERE owner = $1 AND id = $2", [OWNER, sourceAssetId]);
    assert.deepEqual(await adoptTranslationProposal(pool, OWNER, proposalId, adoption), { status: "conflict" }, "adoption rechecks the fixed source asset metadata");
    await pool.query("UPDATE assets SET credit = 'Synthetic Studio' WHERE owner = $1 AND id = $2", [OWNER, sourceAssetId]);
    const adopted = await adoptTranslationProposal(pool, OWNER, proposalId, adoption);
    assert.deepEqual(adopted, { status: "adopted", targetPageId, targetRevision: 1, created: true });
    const target = await pages.getPage(OWNER, targetPageId);
    assert.equal(target?.lang, "en");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM publications WHERE page_id = $1", [targetPageId])).rows[0].n, 0, "initial adoption is private");
    assert.equal(await managedTranslationReviewProblem(pool, OWNER, targetPageId), "source_updated");
    assert.equal(await reviewManagedTranslation(pool, OWNER, targetPageId, source.revision, 1), "reviewed");
    assert.equal(await managedTranslationReviewProblem(pool, OWNER, targetPageId), null);

    await pool.query("UPDATE assets SET alt = '原文画像の更新' WHERE owner = $1 AND id = $2", [OWNER, sourceAssetId]);
    assert.equal(await managedTranslationReviewProblem(pool, OWNER, targetPageId), "source_updated", "source image metadata invalidates only source review");
    await pool.query("UPDATE assets SET alt = '合成の海' WHERE owner = $1 AND id = $2", [OWNER, sourceAssetId]);
    assert.equal(await reviewManagedTranslation(pool, OWNER, targetPageId, source.revision, 1), "reviewed");
    await pool.query("UPDATE assets SET alt = 'Target metadata edit' WHERE owner = $1 AND id = $2", [OWNER, targetAssetId]);
    assert.equal(await managedTranslationReviewProblem(pool, OWNER, targetPageId), "target_updated", "target image metadata invalidates only target review");
    await pool.query("UPDATE assets SET alt = 'Synthetic sea' WHERE owner = $1 AND id = $2", [OWNER, targetAssetId]);
    assert.equal(await reviewManagedTranslation(pool, OWNER, targetPageId, source.revision, 1), "reviewed");

    const edited = await pages.savePage(OWNER, targetPageId, { title: "Manually reviewed English" }, { baseRevision: 1 });
    assert.ok(edited && edited.status === "saved");
    assert.equal(await managedTranslationReviewProblem(pool, OWNER, targetPageId), "target_updated");
    assert.equal(await reviewManagedTranslation(pool, OWNER, targetPageId, source.revision, 2), "reviewed");

    const relationBeforeRetranslation = await getTranslationRelation(pool, OWNER, targetPageId);
    assert.ok(relationBeforeRetranslation && !relationBeforeRetranslation.detached);
    const retranslationProposalId = randomUUID();
    const retranslationOperationId = randomUUID();
    const retranslation = await startTranslationProposal(pool, OWNER, source.id, {
      ...start,
      proposalId: retranslationProposalId,
      operationId: retranslationOperationId,
      targetPageId,
      relationId: relationBeforeRetranslation.relationId,
      relationVersion: relationBeforeRetranslation.version,
      inputHash: "d".repeat(64),
      targetRevision: 2,
      copies: [{
        ...start.copies[0]!,
        targetAssetId,
        reused: true,
      }],
    });
    assert.ok(retranslation && retranslation !== "conflict" && retranslation.created);
    assert.equal(await finishTranslationProposal(pool, OWNER, retranslationProposalId, retranslation.proposal.generation, retranslationOperationId, envelope()), true);
    await pool.query("UPDATE assets SET alt = 'Concurrent target edit' WHERE owner = $1 AND id = $2", [OWNER, targetAssetId]);
    assert.deepEqual(await adoptTranslationProposal(pool, OWNER, retranslationProposalId, {
      ...adoption,
      targetRevision: 2,
      title: "Retranslated synthetic English guide",
      assets: adoption.assets.map((asset) => ({ ...asset, reused: true })),
    }), { status: "conflict" }, "target asset edits after generation cannot be overwritten by retranslation adoption");
    await pool.query("UPDATE assets SET alt = 'Synthetic sea' WHERE owner = $1 AND id = $2", [OWNER, targetAssetId]);

    assert.equal(await pages.deletePage(OWNER, source.id), "deleted");
    assert.equal(await managedTranslationReviewProblem(pool, OWNER, targetPageId), "source_missing");
    await pool.query("UPDATE pages SET created_at = created_at - interval '2 days', updated_at = updated_at - interval '2 days', deleted_at = deleted_at - interval '2 days' WHERE owner = $1 AND id = $2", [OWNER, source.id]);
    const purged = await pages.purgeTrash({ olderThanDays: 1 });
    assert.deepEqual(purged.assetPaths, [`image/${sourceAssetId}`]);
    assert.ok(!purged.assetPaths.includes(`image/${targetAssetId}`), "source GC cannot reach the independent target object");
    assert.equal((await pages.getPage(OWNER, targetPageId))?.title, "Manually reviewed English");
    const relation = await getTranslationRelation(pool, OWNER, targetPageId);
    assert.equal(relation?.sourcePageId, null);
    assert.equal(await detachManagedTranslation(pool, OWNER, targetPageId, 2), "detached");
    assert.equal(await managedTranslationReviewProblem(pool, OWNER, targetPageId), null);

    const interruptedAssetId = randomUUID();
    const interruptedTargetAssetId = randomUUID();
    const interruptedSource = await pages.createPage(OWNER, {
      title: "Interrupted synthetic source",
      lang: "ja",
      blocks: [{ type: "image", attrs: { assetId: interruptedAssetId } }],
    });
    await pool.query(
      `INSERT INTO assets (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type, alt, credit, consent, upload_status)
       VALUES ($1, $2, $3, 'image', $4, 3, $5, 'image/png', NULL, NULL, true, 'ready')`,
      [interruptedAssetId, OWNER, interruptedSource.id, `image/${interruptedAssetId}`, SHA],
    );
    const interrupted = await startTranslationProposal(pool, OWNER, interruptedSource.id, {
      ...start,
      proposalId: randomUUID(),
      operationId: randomUUID(),
      targetPageId: randomUUID(),
      sourceRevision: interruptedSource.revision,
      inputHash: "c".repeat(64),
      copies: [{
        sourceAssetId: interruptedAssetId,
        targetAssetId: interruptedTargetAssetId,
        sourceObjectPath: `image/${interruptedAssetId}`,
        sourceGeneration: "12",
        sourceBytes: 3,
        sourceSha256: SHA,
        sourceContentType: "image/png",
        sourceAlt: null,
        sourceCredit: null,
        sourceConsent: true,
        reused: false,
      }],
    });
    assert.ok(interrupted && interrupted !== "conflict" && interrupted.created);
    await pages.deletePage(OWNER, interruptedSource.id);
    await pool.query("UPDATE pages SET created_at = created_at - interval '2 days', updated_at = updated_at - interval '2 days', deleted_at = deleted_at - interval '2 days' WHERE owner = $1 AND id = $2", [OWNER, interruptedSource.id]);
    await pages.purgeTrash({ olderThanDays: 1 });
    assert.deepEqual(await purgeExpiredTranslationProposals(pool, OWNER), [`image/${interruptedTargetAssetId}`], "a copy whose object/DB acknowledgement was interrupted remains recoverable");

    const foreignSource = await pages.createPage(OTHER, { title: "Foreign synthetic source", lang: "ja" });
    // Use an unlinked target so uniqueness cannot mask the owner-boundary check.
    const unlinkedTarget = await pages.createPage(OWNER, { title: "Unlinked synthetic target", lang: "en" });
    await assert.rejects(
      pool.query("INSERT INTO page_translation_relations (owner, source_page_id, target_page_id) VALUES ($1, $2, $3)", [OTHER, foreignSource.id, unlinkedTarget.id]),
      /invalid managed translation target|page_translation_relations_owner_target_page_id_fkey/,
    );
  });
});
