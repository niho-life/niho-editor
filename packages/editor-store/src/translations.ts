import { PAGE_IMAGE_MAX_COUNT, PAGE_MAX_BYTES, pageImageIds, pageSizeBytes } from "./page-size.ts";
import { imageObjectPath } from "./images.ts";
import { isPageId } from "./store.ts";
import type { Block, Database, OwnerId, PageKind, Queryable } from "./types.ts";

export const TRANSLATION_PROPOSAL_TTL_HOURS = 24;
export const TRANSLATION_LEASE_MINUTES = 15;

export type TranslationEnvelope = {
  keyId: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
};

export type TranslationSourceAsset = {
  assetId: string;
  objectPath: string;
  bytes: number;
  sha256: string;
  contentType: string;
  alt: string | null;
  credit: string | null;
  consent: boolean;
  reusedTargetAssetId: string | null;
};

export type TranslationSource = {
  source: { id: string; kind: PageKind; title: string; lead: string | null; blocks: Block[]; cover: string | null; revision: number };
  relation: { id: string; version: number; targetPageId: string; reviewedSourceRevision: number | null; reviewedTargetRevision: number | null } | null;
  target: { id: string; revision: number; title: string; lead: string | null; blocks: Block[]; cover: string | null } | null;
  assets: TranslationSourceAsset[];
};

export type TranslationProposalStatus = "generating" | "ready" | "failed" | "adopted" | "expired";

export type TranslationProposal = {
  id: string;
  sourcePageId: string | null;
  sourceIdentity: string;
  targetPageId: string;
  relationId: string | null;
  relationVersion: number | null;
  generation: number;
  operationId: string;
  inputHash: string;
  sourceRevision: number;
  targetRevision: number | null;
  status: TranslationProposalStatus;
  errorCode: string | null;
  fieldCount: number;
  codepointCount: number;
  omissions: string[];
  expiresAt: string;
  createdAt: string;
};

export type TranslationCopy = {
  proposalId: string;
  sourceAssetId: string;
  targetAssetId: string;
  sourceObjectPath: string;
  targetObjectPath: string;
  sourceGeneration: string | null;
  state: "planned" | "copied" | "reused" | "adopted" | "failed";
};

type ProposalRow = {
  id: string;
  source_page_id: string | null;
  source_identity: string;
  target_page_id: string;
  relation_id: string | null;
  relation_version: number | null;
  generation: number;
  operation_id: string;
  input_hash: string;
  source_revision: number;
  target_revision: number | null;
  status: TranslationProposalStatus;
  error_code: string | null;
  payload_key_id: string | null;
  payload_nonce: Buffer | null;
  payload_ciphertext: Buffer | null;
  payload_tag: Buffer | null;
  field_count: number;
  codepoint_count: number;
  omissions: string[];
  expires_at: Date;
  created_at: Date;
};

type CopyRow = {
  proposal_id: string;
  source_asset_id: string;
  target_asset_id: string;
  source_object_path: string;
  target_object_path: string;
  source_generation: string | null;
  state: TranslationCopy["state"];
};

const PROPOSAL_COLUMNS = `id, source_page_id, source_identity, target_page_id, relation_id, relation_version, generation, operation_id,
       input_hash, source_revision, target_revision, status, error_code, payload_key_id, payload_nonce,
       payload_ciphertext, payload_tag, field_count, codepoint_count, omissions, expires_at, created_at`;
const COPY_COLUMNS = `proposal_id, source_asset_id, target_asset_id, source_object_path, target_object_path, source_generation, state`;
const HASH = /^[0-9a-f]{64}$/;
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;

class TranslationStartConflict extends Error {}

function assertOwner(owner: OwnerId): void {
  if (typeof owner !== "string" || owner.length < 1 || owner.length > 256) throw new TypeError("editor-store: owner must be a non-empty stable user id");
}

function assertEnvelope(value: TranslationEnvelope): void {
  if (!value || !/^[A-Za-z0-9._-]{1,32}$/.test(value.keyId) || value.nonce.byteLength !== 12 || value.tag.byteLength !== 16 || value.ciphertext.byteLength < 1) {
    throw new TypeError("editor-store: invalid private payload envelope");
  }
}

function proposalOf(row: ProposalRow): TranslationProposal {
  return {
    id: row.id,
    sourcePageId: row.source_page_id,
    sourceIdentity: row.source_identity,
    targetPageId: row.target_page_id,
    relationId: row.relation_id,
    relationVersion: row.relation_version,
    generation: row.generation,
    operationId: row.operation_id,
    inputHash: row.input_hash,
    sourceRevision: row.source_revision,
    targetRevision: row.target_revision,
    status: row.status,
    errorCode: row.error_code,
    fieldCount: row.field_count,
    codepointCount: row.codepoint_count,
    omissions: [...row.omissions],
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

function copyOf(row: CopyRow): TranslationCopy {
  return {
    proposalId: row.proposal_id,
    sourceAssetId: row.source_asset_id,
    targetAssetId: row.target_asset_id,
    sourceObjectPath: row.source_object_path,
    targetObjectPath: row.target_object_path,
    sourceGeneration: row.source_generation,
    state: row.state,
  };
}

async function transaction<T>(db: Database, work: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let broken = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

/** 本人の現在の ja source、同 owner の active en target、ready 画像をサーバーで読む。 */
export async function readTranslationSource(db: Queryable, owner: OwnerId, sourcePageId: string): Promise<TranslationSource | null> {
  assertOwner(owner);
  if (!isPageId(sourcePageId)) return null;
  const sourceResult = await db.query<{
    id: string; kind: PageKind; title: string; lead: string | null; blocks: Block[]; cover: string | null; revision: number; lang: string;
  }>("SELECT id, kind, title, lead, blocks, cover, revision, lang FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL", [owner, sourcePageId]);
  const source = sourceResult.rows[0];
  if (!source || source.lang !== "ja") return null;
  const relationResult = await db.query<{
    id: string; version: number; target_page_id: string; reviewed_source_revision: number | null; reviewed_target_revision: number | null;
    target_revision: number | null; target_title: string | null; target_lead: string | null; target_blocks: Block[] | null; target_cover: string | null; target_lang: string | null;
  }>(
    `SELECT r.id, r.version, r.target_page_id, r.reviewed_source_revision, r.reviewed_target_revision,
            t.revision AS target_revision, t.title AS target_title, t.lead AS target_lead, t.blocks AS target_blocks,
            t.cover AS target_cover, t.lang AS target_lang
       FROM page_translation_relations r
       LEFT JOIN pages t ON t.owner = r.owner AND t.id = r.target_page_id AND t.deleted_at IS NULL
      WHERE r.owner = $1 AND r.source_page_id = $2 AND r.detached_at IS NULL`,
    [owner, sourcePageId],
  );
  const linked = relationResult.rows[0] ?? null;
  // 壊れた relation や現在 en でない target は管理翻訳の入力に使わない（修復なしに別 target も作らない）。
  if (linked && (linked.target_revision === null || linked.target_lang !== "en" || linked.target_blocks === null || linked.target_title === null)) return null;
  const targetPageId = linked?.target_page_id ?? null;
  const assets = await db.query<{
    id: string; bucket_path: string; bytes: string; sha256: string; content_type: string; alt: string | null; credit: string | null; consent: boolean; reused_target: string | null;
  }>(
    `SELECT a.id, a.bucket_path, a.bytes::text AS bytes, a.sha256, a.content_type, a.alt, a.credit, a.consent,
            (SELECT c.target_asset_id
               FROM page_translation_asset_copies c
               JOIN page_translation_proposals p ON p.id = c.proposal_id
               JOIN assets ta ON ta.owner = p.owner AND ta.page_id = p.target_page_id AND ta.id = c.target_asset_id
              WHERE p.owner = $1 AND p.target_page_id = $3::uuid AND c.source_asset_id = a.id AND c.state = 'adopted'
              ORDER BY p.created_at DESC LIMIT 1) AS reused_target
       FROM assets a
      WHERE a.owner = $1 AND a.page_id = $2 AND a.kind = 'image' AND a.upload_status = 'ready'
      ORDER BY a.id`,
    [owner, sourcePageId, targetPageId],
  );
  return {
    source: { id: source.id, kind: source.kind, title: source.title, lead: source.lead, blocks: source.blocks, cover: source.cover, revision: source.revision },
    relation: linked ? { id: linked.id, version: linked.version, targetPageId: linked.target_page_id, reviewedSourceRevision: linked.reviewed_source_revision, reviewedTargetRevision: linked.reviewed_target_revision } : null,
    target: linked ? { id: linked.target_page_id, revision: linked.target_revision!, title: linked.target_title!, lead: linked.target_lead, blocks: linked.target_blocks!, cover: linked.target_cover } : null,
    assets: assets.rows.map((asset) => ({
      assetId: asset.id,
      objectPath: asset.bucket_path,
      bytes: Number(asset.bytes),
      sha256: asset.sha256,
      contentType: asset.content_type,
      alt: asset.alt,
      credit: asset.credit,
      consent: asset.consent,
      reusedTargetAssetId: asset.reused_target,
    })),
  };
}

export type StartTranslationProposalInput = {
  proposalId: string;
  operationId: string;
  targetPageId: string;
  relationId: string | null;
  relationVersion: number | null;
  inputHash: string;
  sourceRevision: number;
  targetRevision: number | null;
  fieldCount: number;
  codepointCount: number;
  omissions: readonly string[];
  expiresAt: string;
  envelope: TranslationEnvelope;
  copies: readonly {
    sourceAssetId: string;
    targetAssetId: string;
    sourceObjectPath: string;
    sourceGeneration: string;
    sourceBytes: number;
    sourceSha256: string;
    sourceContentType: string;
    sourceAlt: string | null;
    sourceCredit: string | null;
    sourceConsent: boolean;
    reused: boolean;
  }[];
};

export type StartTranslationProposalResult = { proposal: TranslationProposal; created: boolean } | null | "conflict";

/** source row lock で generation を採番し、operation id の再送は同じ proposal に収束させる。 */
export async function startTranslationProposal(
  db: Database,
  owner: OwnerId,
  sourcePageId: string,
  input: StartTranslationProposalInput,
): Promise<StartTranslationProposalResult> {
  assertOwner(owner);
  assertEnvelope(input.envelope);
  if (![sourcePageId, input.proposalId, input.operationId, input.targetPageId].every(isPageId) || !HASH.test(input.inputHash)) throw new TypeError("editor-store: invalid translation proposal id");
  if ((input.relationId === null) !== (input.relationVersion === null) || (input.relationVersion !== null && (!Number.isSafeInteger(input.relationVersion) || input.relationVersion < 1))) {
    throw new TypeError("editor-store: invalid translation relation version");
  }
  if (!Number.isSafeInteger(input.fieldCount) || input.fieldCount < 1 || input.fieldCount > 256 || !Number.isSafeInteger(input.codepointCount) || input.codepointCount < 1 || input.codepointCount > 20_000) {
    throw new TypeError("editor-store: invalid translation proposal size");
  }
  const expiresAt = new Date(input.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString() !== input.expiresAt || expiresAt.getTime() <= Date.now()) {
    throw new TypeError("editor-store: invalid translation proposal expiry");
  }
  try {
    return await transaction(db, async (client): Promise<StartTranslationProposalResult> => {
      const source = (await client.query<{ revision: number; lang: string; blocks: Block[]; cover: string | null }>(
        "SELECT revision, lang, blocks, cover FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE",
        [owner, sourcePageId],
      )).rows[0];
      if (!source || source.lang !== "ja") return null;
      await client.query(
        `UPDATE page_translation_proposals
            SET status = 'expired', lease_until = NULL, error_code = COALESCE(error_code, 'expired'),
                payload_key_id = NULL, payload_nonce = NULL, payload_ciphertext = NULL, payload_tag = NULL,
                updated_at = GREATEST(clock_timestamp(), updated_at)
          WHERE owner = $1 AND source_identity = $2 AND expires_at <= clock_timestamp()
            AND status IN ('generating', 'ready', 'failed')`,
        [owner, sourcePageId],
      );
      const replay = (await client.query<ProposalRow>(
        `SELECT ${PROPOSAL_COLUMNS} FROM page_translation_proposals WHERE owner = $1 AND source_identity = $2 AND operation_id = $3`,
        [owner, sourcePageId, input.operationId],
      )).rows[0];
      if (replay) return replay.input_hash === input.inputHash ? { proposal: proposalOf(replay), created: false } : "conflict";
      if (source.revision !== input.sourceRevision) return "conflict";
      if (input.relationId === null) {
        const active = await client.query("SELECT 1 FROM page_translation_relations WHERE owner = $1 AND source_page_id = $2 AND detached_at IS NULL", [owner, sourcePageId]);
        if (active.rows.length > 0) return "conflict";
      } else {
        const relation = (await client.query<{ target_page_id: string; relation_version: number; revision: number; lang: string }>(
          `SELECT r.target_page_id, r.version AS relation_version, p.revision, p.lang
             FROM page_translation_relations r
             JOIN pages p ON p.owner = r.owner AND p.id = r.target_page_id AND p.deleted_at IS NULL
            WHERE r.id = $1 AND r.owner = $2 AND r.source_page_id = $3 AND r.detached_at IS NULL
            FOR SHARE OF r, p`,
          [input.relationId, owner, sourcePageId],
        )).rows[0];
        if (!relation || relation.target_page_id !== input.targetPageId || relation.relation_version !== input.relationVersion || relation.lang !== "en" || relation.revision !== input.targetRevision) return "conflict";
      }
      const occupied = (await client.query<ProposalRow>(
        `SELECT ${PROPOSAL_COLUMNS}
           FROM page_translation_proposals
          WHERE owner = $1 AND source_identity = $2 AND status = 'generating'
            AND lease_until >= clock_timestamp() AND expires_at > clock_timestamp()
          ORDER BY generation DESC LIMIT 1`,
        [owner, sourcePageId],
      )).rows[0];
      if (occupied) return occupied.input_hash === input.inputHash ? { proposal: proposalOf(occupied), created: false } : "conflict";
      const generation = (await client.query<{ generation: number }>(
        "SELECT COALESCE(max(generation), 0)::int + 1 AS generation FROM page_translation_proposals WHERE owner = $1 AND source_identity = $2",
        [owner, sourcePageId],
      )).rows[0]!.generation;
      const inserted = (await client.query<ProposalRow>(
        `INSERT INTO page_translation_proposals
           (id, owner, source_page_id, source_identity, target_page_id, relation_id, relation_version, generation, operation_id, input_hash,
            source_revision, target_revision, status, lease_until, payload_key_id, payload_nonce, payload_ciphertext,
            payload_tag, field_count, codepoint_count, omissions, expires_at)
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'generating',
                 clock_timestamp() + make_interval(mins => $12::int), $13, $14, $15, $16, $17, $18, $19::text[],
                 $20::timestamptz)
         RETURNING ${PROPOSAL_COLUMNS}`,
        [input.proposalId, owner, sourcePageId, input.targetPageId, input.relationId, input.relationVersion, generation, input.operationId, input.inputHash,
          input.sourceRevision, input.targetRevision, TRANSLATION_LEASE_MINUTES, input.envelope.keyId, Buffer.from(input.envelope.nonce),
          Buffer.from(input.envelope.ciphertext), Buffer.from(input.envelope.tag), input.fieldCount, input.codepointCount, [...input.omissions], input.expiresAt],
      )).rows[0]!;
      const sourceIds = new Set<string>();
      const targetIds = new Set<string>();
      for (const copy of input.copies) {
        if (
          ![copy.sourceAssetId, copy.targetAssetId].every(isPageId)
          || sourceIds.has(copy.sourceAssetId.toLowerCase())
          || targetIds.has(copy.targetAssetId.toLowerCase())
          || !Number.isSafeInteger(copy.sourceBytes)
          || copy.sourceBytes < 1
          || !HASH.test(copy.sourceSha256)
          || typeof copy.sourceContentType !== "string"
          || copy.sourceContentType.length < 1
          || copy.sourceContentType.length > 255
          || (copy.sourceAlt !== null && typeof copy.sourceAlt !== "string")
          || (copy.sourceCredit !== null && typeof copy.sourceCredit !== "string")
          || typeof copy.sourceConsent !== "boolean"
          || !/^[1-9][0-9]{0,30}$/.test(copy.sourceGeneration)
        ) throw new TypeError("editor-store: invalid translation asset snapshot");
        sourceIds.add(copy.sourceAssetId.toLowerCase());
        targetIds.add(copy.targetAssetId.toLowerCase());
        const owned = await client.query(
          `SELECT 1 FROM assets
            WHERE owner = $1 AND page_id = $2 AND id = $3 AND kind = 'image' AND upload_status = 'ready'
              AND bucket_path = $4 AND bytes = $5 AND sha256 = $6 AND content_type = $7
              AND alt IS NOT DISTINCT FROM $8::text AND credit IS NOT DISTINCT FROM $9::text AND consent = $10
            FOR SHARE`,
          [owner, sourcePageId, copy.sourceAssetId, copy.sourceObjectPath, copy.sourceBytes, copy.sourceSha256,
            copy.sourceContentType, copy.sourceAlt, copy.sourceCredit, copy.sourceConsent],
        );
        if (owned.rows.length === 0) throw new TranslationStartConflict();
        if (copy.reused) {
          const target = await client.query(
            "SELECT 1 FROM assets WHERE owner = $1 AND page_id = $2 AND id = $3 AND kind = 'image' AND upload_status = 'ready' AND bucket_path = $4 FOR SHARE",
            [owner, input.targetPageId, copy.targetAssetId, imageObjectPath(copy.targetAssetId)],
          );
          if (target.rows.length === 0) throw new TranslationStartConflict();
        }
        await client.query(
          `INSERT INTO page_translation_asset_copies
             (proposal_id, source_asset_id, target_asset_id, source_object_path, target_object_path, source_generation, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [input.proposalId, copy.sourceAssetId, copy.targetAssetId, copy.sourceObjectPath, imageObjectPath(copy.targetAssetId), copy.sourceGeneration, copy.reused ? "reused" : "planned"],
        );
      }
      const referenced = pageImageIds(source.blocks);
      if (source.cover !== null) referenced.add(source.cover.toLowerCase());
      if (referenced.size !== sourceIds.size || [...referenced].some((id) => !sourceIds.has(id))) {
        throw new TranslationStartConflict();
      }
      return { proposal: proposalOf(inserted), created: true };
    });
  } catch (error) {
    if (error instanceof TranslationStartConflict) return "conflict";
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505") {
      const replay = await getTranslationProposalByOperation(db, owner, sourcePageId, input.operationId);
      if (replay) return replay.inputHash === input.inputHash ? { proposal: replay, created: false } : "conflict";
    }
    throw error;
  }
}

export async function getTranslationProposalByOperation(db: Queryable, owner: OwnerId, sourcePageId: string, operationId: string): Promise<TranslationProposal | null> {
  assertOwner(owner);
  if (!isPageId(sourcePageId) || !isPageId(operationId)) return null;
  await db.query(
    `UPDATE page_translation_proposals
        SET status = 'expired', lease_until = NULL, error_code = COALESCE(error_code, 'expired'),
            payload_key_id = NULL, payload_nonce = NULL, payload_ciphertext = NULL, payload_tag = NULL,
            updated_at = GREATEST(clock_timestamp(), updated_at)
      WHERE owner = $1 AND source_identity = $2 AND operation_id = $3 AND expires_at <= clock_timestamp()
        AND status IN ('generating', 'ready', 'failed')`,
    [owner, sourcePageId, operationId],
  );
  const row = (await db.query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM page_translation_proposals WHERE owner = $1 AND source_identity = $2 AND operation_id = $3`,
    [owner, sourcePageId, operationId],
  )).rows[0];
  return row ? proposalOf(row) : null;
}

/** source の直近 proposal。候補本文は返さず、画面の状態表示と再読込にだけ使う。 */
export async function getLatestTranslationProposal(db: Queryable, owner: OwnerId, sourcePageId: string): Promise<TranslationProposal | null> {
  assertOwner(owner);
  if (!isPageId(sourcePageId)) return null;
  await db.query(
    `UPDATE page_translation_proposals
        SET status = 'expired', lease_until = NULL, error_code = COALESCE(error_code, 'expired'),
            payload_key_id = NULL, payload_nonce = NULL, payload_ciphertext = NULL, payload_tag = NULL,
            updated_at = GREATEST(clock_timestamp(), updated_at)
      WHERE owner = $1 AND source_identity = $2 AND expires_at <= clock_timestamp()
        AND status IN ('generating', 'ready', 'failed')`,
    [owner, sourcePageId],
  );
  const row = (await db.query<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM page_translation_proposals
      WHERE owner = $1 AND source_identity = $2
      ORDER BY generation DESC LIMIT 1`,
    [owner, sourcePageId],
  )).rows[0];
  return row ? proposalOf(row) : null;
}

export type TranslationProposalPayload = { proposal: TranslationProposal; envelope: TranslationEnvelope | null; copies: TranslationCopy[] };

export async function getTranslationProposal(db: Queryable, owner: OwnerId, proposalId: string): Promise<TranslationProposalPayload | null> {
  assertOwner(owner);
  if (!isPageId(proposalId)) return null;
  await db.query(
    `UPDATE page_translation_proposals
        SET status = 'expired', lease_until = NULL, error_code = COALESCE(error_code, 'expired'),
            payload_key_id = NULL, payload_nonce = NULL, payload_ciphertext = NULL, payload_tag = NULL,
            updated_at = GREATEST(clock_timestamp(), updated_at)
      WHERE owner = $1 AND id = $2 AND expires_at <= clock_timestamp()
        AND status IN ('generating', 'ready', 'failed')`,
    [owner, proposalId],
  );
  const row = (await db.query<ProposalRow>(`SELECT ${PROPOSAL_COLUMNS} FROM page_translation_proposals WHERE owner = $1 AND id = $2`, [owner, proposalId])).rows[0];
  if (!row) return null;
  const copies = await db.query<CopyRow>(`SELECT ${COPY_COLUMNS} FROM page_translation_asset_copies WHERE proposal_id = $1 ORDER BY source_asset_id`, [proposalId]);
  const envelope = row.payload_key_id && row.payload_nonce && row.payload_ciphertext && row.payload_tag
    ? { keyId: row.payload_key_id, nonce: row.payload_nonce, ciphertext: row.payload_ciphertext, tag: row.payload_tag }
    : null;
  return { proposal: proposalOf(row), envelope, copies: copies.rows.map(copyOf) };
}

/** generation/operation/status/lease の CAS。遅着した provider 応答は ready にできない。 */
export async function finishTranslationProposal(
  db: Queryable,
  owner: OwnerId,
  proposalId: string,
  generation: number,
  operationId: string,
  envelope: TranslationEnvelope,
): Promise<boolean> {
  assertOwner(owner);
  assertEnvelope(envelope);
  if (!isPageId(proposalId) || !isPageId(operationId) || !Number.isSafeInteger(generation) || generation < 1) return false;
  const result = await db.query(
    `UPDATE page_translation_proposals
        SET status = 'ready', lease_until = NULL, payload_key_id = $5, payload_nonce = $6,
            payload_ciphertext = $7, payload_tag = $8, updated_at = GREATEST(clock_timestamp(), updated_at)
      WHERE owner = $1 AND id = $2 AND generation = $3 AND operation_id = $4
        AND status = 'generating' AND lease_until >= clock_timestamp() AND expires_at > clock_timestamp()`,
    [owner, proposalId, generation, operationId, envelope.keyId, Buffer.from(envelope.nonce), Buffer.from(envelope.ciphertext), Buffer.from(envelope.tag)],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function failTranslationProposal(db: Queryable, owner: OwnerId, proposalId: string, generation: number, operationId: string, errorCode: string): Promise<boolean> {
  assertOwner(owner);
  if (!isPageId(proposalId) || !isPageId(operationId) || !Number.isSafeInteger(generation) || generation < 1 || !ERROR_CODE.test(errorCode)) return false;
  const result = await db.query(
    `UPDATE page_translation_proposals
        SET status = 'failed', lease_until = NULL, error_code = $5, payload_key_id = NULL, payload_nonce = NULL,
            payload_ciphertext = NULL, payload_tag = NULL, updated_at = GREATEST(clock_timestamp(), updated_at)
      WHERE owner = $1 AND id = $2 AND generation = $3 AND operation_id = $4 AND status = 'generating'`,
    [owner, proposalId, generation, operationId, errorCode],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function markTranslationCopy(
  db: Queryable,
  owner: OwnerId,
  proposalId: string,
  sourceAssetId: string,
  result: { state: "copied"; sourceGeneration: string } | { state: "failed"; errorCode: string },
): Promise<boolean> {
  assertOwner(owner);
  if (![proposalId, sourceAssetId].every(isPageId)) return false;
  if (result.state === "copied" && !/^[1-9][0-9]{0,30}$/.test(result.sourceGeneration)) return false;
  if (result.state === "failed" && !ERROR_CODE.test(result.errorCode)) return false;
  const updated = await db.query(
    `UPDATE page_translation_asset_copies c
        SET state = $4, source_generation = CASE WHEN $4 = 'copied' THEN $5 ELSE source_generation END,
            error_code = CASE WHEN $4 = 'failed' THEN $6 ELSE NULL END,
            updated_at = GREATEST(clock_timestamp(), c.updated_at)
       FROM page_translation_proposals p
      WHERE p.id = c.proposal_id AND p.owner = $1 AND p.id = $2 AND c.source_asset_id = $3
        AND p.status = 'ready' AND p.expires_at > clock_timestamp() AND c.state IN ('planned', 'failed')`,
    [owner, proposalId, sourceAssetId, result.state, result.state === "copied" ? result.sourceGeneration : null, result.state === "failed" ? result.errorCode : null],
  );
  return (updated.rowCount ?? 0) === 1;
}

export type AdoptTranslationAsset = {
  sourceAssetId: string;
  sourceObjectPath: string;
  sourceGeneration: string;
  sourceBytes: number;
  sourceSha256: string;
  sourceContentType: string;
  sourceAlt: string | null;
  sourceCredit: string | null;
  sourceConsent: boolean;
  targetAssetId: string;
  targetObjectPath: string;
  bytes: number;
  sha256: string;
  contentType: string;
  alt: string | null;
  credit: string | null;
  consent: boolean;
  reused: boolean;
};

export type AdoptTranslationInput = {
  sourceRevision: number;
  targetRevision: number | null;
  kind: PageKind;
  title: string;
  lead: string | null;
  blocks: readonly Block[];
  cover: string | null;
  assets: readonly AdoptTranslationAsset[];
};

export type AdoptTranslationResult =
  | { status: "adopted"; targetPageId: string; targetRevision: number; created: boolean }
  | { status: "conflict" }
  | { status: "page_full" }
  | { status: "too_many_images" }
  | { status: "not_ready" }
  | null;

/** copy 完了後、source/target revision と relation を同じ transaction で CAS して初めて target を変更する。 */
export async function adoptTranslationProposal(
  db: Database,
  owner: OwnerId,
  proposalId: string,
  input: AdoptTranslationInput,
): Promise<AdoptTranslationResult> {
  assertOwner(owner);
  if (!isPageId(proposalId)) return null;
  return transaction(db, async (client): Promise<AdoptTranslationResult> => {
    const proposal = (await client.query<ProposalRow>(
      `SELECT ${PROPOSAL_COLUMNS} FROM page_translation_proposals WHERE owner = $1 AND id = $2 FOR UPDATE`,
      [owner, proposalId],
    )).rows[0];
    if (!proposal) return null;
    if (proposal.status === "adopted") {
      const target = (await client.query<{ revision: number }>("SELECT revision FROM pages WHERE owner = $1 AND id = $2", [owner, proposal.target_page_id])).rows[0];
      return target ? { status: "adopted", targetPageId: proposal.target_page_id, targetRevision: target.revision, created: proposal.target_revision === null } : null;
    }
    if (proposal.status !== "ready" || proposal.expires_at.getTime() <= Date.now() || proposal.source_page_id === null) return { status: "not_ready" };
    if (proposal.source_revision !== input.sourceRevision || proposal.target_revision !== input.targetRevision) return { status: "conflict" };
    const source = (await client.query<{ revision: number; lang: string }>(
      "SELECT revision, lang FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE",
      [owner, proposal.source_page_id],
    )).rows[0];
    if (!source) return null;
    if (source.lang !== "ja" || source.revision !== proposal.source_revision) return { status: "conflict" };
    const copies = await client.query<CopyRow>(`SELECT ${COPY_COLUMNS} FROM page_translation_asset_copies WHERE proposal_id = $1 ORDER BY source_asset_id FOR UPDATE`, [proposalId]);
    if (copies.rows.some((copy) => copy.state !== "copied" && copy.state !== "reused")) return { status: "not_ready" };
    const bySource = new Map(copies.rows.map((copy) => [copy.source_asset_id, copy] as const));
    if (input.assets.length !== copies.rows.length || input.assets.some((asset) => {
      const copy = bySource.get(asset.sourceAssetId);
      return !copy
        || copy.target_asset_id !== asset.targetAssetId
        || copy.source_object_path !== asset.sourceObjectPath
        || copy.target_object_path !== asset.targetObjectPath
        || copy.source_generation !== asset.sourceGeneration
        || asset.bytes !== asset.sourceBytes
        || asset.sha256 !== asset.sourceSha256
        || asset.contentType !== asset.sourceContentType
        || asset.credit !== asset.sourceCredit
        || asset.consent !== asset.sourceConsent;
    })) return { status: "not_ready" };
    for (const asset of input.assets) {
      const current = await client.query(
        `SELECT 1 FROM assets
          WHERE owner = $1 AND page_id = $2 AND id = $3 AND kind = 'image' AND upload_status = 'ready'
            AND bucket_path = $4 AND bytes = $5 AND sha256 = $6 AND content_type = $7
            AND alt IS NOT DISTINCT FROM $8::text AND credit IS NOT DISTINCT FROM $9::text AND consent = $10
          FOR SHARE`,
        [owner, proposal.source_page_id, asset.sourceAssetId, asset.sourceObjectPath, asset.sourceBytes,
          asset.sourceSha256, asset.sourceContentType, asset.sourceAlt, asset.sourceCredit, asset.sourceConsent],
      );
      if (current.rows.length === 0) return { status: "conflict" };
    }

    let targetRevision: number;
    const created = proposal.target_revision === null;
    if (created) {
      const competing = await client.query("SELECT 1 FROM page_translation_relations WHERE owner = $1 AND source_page_id = $2 AND detached_at IS NULL", [owner, proposal.source_page_id]);
      if (competing.rows.length > 0) return { status: "conflict" };
      const exists = await client.query("SELECT 1 FROM pages WHERE id = $1", [proposal.target_page_id]);
      if (exists.rows.length > 0) return { status: "conflict" };
      targetRevision = 1;
    } else {
      const relation = (await client.query<{ target_page_id: string; version: number }>(
        "SELECT target_page_id, version FROM page_translation_relations WHERE id = $1 AND owner = $2 AND source_page_id = $3 AND detached_at IS NULL FOR UPDATE",
        [proposal.relation_id, owner, proposal.source_page_id],
      )).rows[0];
      if (!relation || relation.target_page_id !== proposal.target_page_id || relation.version !== proposal.relation_version) return { status: "conflict" };
      const target = (await client.query<{ revision: number; lang: string }>(
        "SELECT revision, lang FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE",
        [owner, proposal.target_page_id],
      )).rows[0];
      if (!target || target.lang !== "en" || target.revision !== proposal.target_revision) return { status: "conflict" };
      targetRevision = target.revision + 1;
    }

    const existingCharges = created ? [] : (await client.query<{ id: string; bytes: string; upload_status: "uploading" | "ready"; reservation_expires_at: Date | null }>(
      "SELECT id, bytes::text AS bytes, upload_status, reservation_expires_at FROM assets WHERE owner = $1 AND page_id = $2 AND kind = 'image'",
      [owner, proposal.target_page_id],
    )).rows.map((row) => ({ id: row.id, bytes: Number(row.bytes), status: row.upload_status, reservationExpiresAt: row.reservation_expires_at }));
    const newAssets = input.assets.filter((asset) => !asset.reused);
    if (existingCharges.length + newAssets.length > PAGE_IMAGE_MAX_COUNT) return { status: "too_many_images" };
    const charges = [...existingCharges, ...newAssets.map((asset) => ({ id: asset.targetAssetId, bytes: asset.bytes, status: "ready" as const, reservationExpiresAt: null }))];
    if (pageSizeBytes(input.title, [...input.blocks], charges, input.cover, input.lead) > PAGE_MAX_BYTES) return { status: "page_full" };

    if (created) {
      await client.query(
        `INSERT INTO pages (id, owner, kind, title, lang, blocks, cover, lead, revision)
         VALUES ($1, $2, $3, $4, 'en', $5::jsonb, NULL, $6, 1)`,
        [proposal.target_page_id, owner, input.kind, input.title, JSON.stringify(input.blocks), input.lead],
      );
    }
    for (const asset of input.assets) {
      if (asset.reused) {
        const updated = await client.query(
          `UPDATE assets SET alt = $4, credit = $5, consent = $6
            WHERE owner = $1 AND page_id = $2 AND id = $3 AND kind = 'image' AND upload_status = 'ready'`,
          [owner, proposal.target_page_id, asset.targetAssetId, asset.alt, asset.credit, asset.consent],
        );
        if ((updated.rowCount ?? 0) !== 1) return { status: "conflict" };
      } else {
        await client.query(
          `INSERT INTO assets
             (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type, alt, credit, consent, upload_status)
           VALUES ($1, $2, $3, 'image', $4, $5, $6, $7, $8, $9, $10, 'ready')`,
          [asset.targetAssetId, owner, proposal.target_page_id, asset.targetObjectPath, asset.bytes, asset.sha256, asset.contentType, asset.alt, asset.credit, asset.consent],
        );
      }
    }
    if (created) {
      if (input.cover !== null) await client.query("UPDATE pages SET cover = $3 WHERE owner = $1 AND id = $2", [owner, proposal.target_page_id, input.cover]);
      await client.query(
        `INSERT INTO page_translation_relations (owner, source_page_id, target_page_id)
         VALUES ($1, $2, $3)`,
        [owner, proposal.source_page_id, proposal.target_page_id],
      );
    } else {
      await client.query(
        `INSERT INTO page_versions (page_id, version, blocks, reason, cover, lead, metadata_tracked)
         SELECT p.id, COALESCE((SELECT max(version) FROM page_versions WHERE page_id = p.id), 0) + 1,
                p.blocks, 'ai', p.cover, p.lead, true
           FROM pages p WHERE p.owner = $1 AND p.id = $2`,
        [owner, proposal.target_page_id],
      );
      const updated = await client.query(
        `UPDATE pages SET title = $3, blocks = $4::jsonb, cover = $5, lead = $6,
                          revision = revision + 1, updated_at = GREATEST(clock_timestamp(), updated_at)
          WHERE owner = $1 AND id = $2 AND deleted_at IS NULL AND revision = $7 AND lang = 'en'`,
        [owner, proposal.target_page_id, input.title, JSON.stringify(input.blocks), input.cover, input.lead, proposal.target_revision],
      );
      if ((updated.rowCount ?? 0) !== 1) return { status: "conflict" };
      await client.query(
        `UPDATE page_translation_relations
            SET reviewed_source_revision = NULL, reviewed_target_revision = NULL, updated_at = GREATEST(clock_timestamp(), updated_at)
          WHERE id = $1 AND owner = $2`,
        [proposal.relation_id, owner],
      );
    }
    await client.query("UPDATE page_translation_asset_copies SET state = 'adopted', updated_at = GREATEST(clock_timestamp(), updated_at) WHERE proposal_id = $1", [proposalId]);
    await client.query(
      `UPDATE page_translation_proposals
          SET status = 'adopted', lease_until = NULL, payload_key_id = NULL, payload_nonce = NULL,
              payload_ciphertext = NULL, payload_tag = NULL, updated_at = GREATEST(clock_timestamp(), updated_at)
        WHERE id = $1`,
      [proposalId],
    );
    return { status: "adopted", targetPageId: proposal.target_page_id, targetRevision, created };
  });
}

export type TranslationRelationState = {
  relationId: string;
  version: number;
  sourcePageId: string | null;
  targetPageId: string;
  sourceRevision: number | null;
  targetRevision: number;
  reviewedSourceRevision: number | null;
  reviewedTargetRevision: number | null;
  sourceMissing: boolean;
  detached: boolean;
};

export async function getTranslationRelation(db: Queryable, owner: OwnerId, pageId: string): Promise<TranslationRelationState | null> {
  assertOwner(owner);
  if (!isPageId(pageId)) return null;
  const row = (await db.query<{
    id: string; version: number; source_page_id: string | null; target_page_id: string; source_revision: number | null; target_revision: number;
    reviewed_source_revision: number | null; reviewed_target_revision: number | null; source_deleted: boolean; detached_at: Date | null;
  }>(
    `SELECT r.id, r.version, r.source_page_id, r.target_page_id, s.revision AS source_revision, t.revision AS target_revision,
            r.reviewed_source_revision, r.reviewed_target_revision,
            (s.id IS NULL OR s.deleted_at IS NOT NULL) AS source_deleted, r.detached_at
       FROM page_translation_relations r
       JOIN pages t ON t.owner = r.owner AND t.id = r.target_page_id
       LEFT JOIN pages s ON s.owner = r.owner AND s.id = r.source_page_id
      WHERE r.owner = $1 AND (r.source_page_id = $2 OR r.target_page_id = $2)
      ORDER BY (r.detached_at IS NULL) DESC LIMIT 1`,
    [owner, pageId],
  )).rows[0];
  return row ? {
    relationId: row.id,
    version: row.version,
    sourcePageId: row.source_page_id,
    targetPageId: row.target_page_id,
    sourceRevision: row.source_revision,
    targetRevision: row.target_revision,
    reviewedSourceRevision: row.reviewed_source_revision,
    reviewedTargetRevision: row.reviewed_target_revision,
    sourceMissing: row.source_deleted,
    detached: row.detached_at !== null,
  } : null;
}

export type ReviewTranslationResult = "reviewed" | "conflict" | "source_missing" | null;

export async function reviewManagedTranslation(db: Database, owner: OwnerId, targetPageId: string, sourceRevision: number, targetRevision: number): Promise<ReviewTranslationResult> {
  assertOwner(owner);
  if (!isPageId(targetPageId)) return null;
  return transaction(db, async (client): Promise<ReviewTranslationResult> => {
    const relation = (await client.query<{ id: string; source_page_id: string | null }>(
      "SELECT id, source_page_id FROM page_translation_relations WHERE owner = $1 AND target_page_id = $2 AND detached_at IS NULL FOR UPDATE",
      [owner, targetPageId],
    )).rows[0];
    if (!relation) return null;
    if (relation.source_page_id === null) return "source_missing";
    const source = (await client.query<{ revision: number; lang: string }>(
      "SELECT revision, lang FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL FOR SHARE",
      [owner, relation.source_page_id],
    )).rows[0];
    if (!source) return "source_missing";
    const target = (await client.query<{ revision: number; lang: string }>(
      "SELECT revision, lang FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL FOR SHARE",
      [owner, targetPageId],
    )).rows[0];
    if (!target) return null;
    if (source.lang !== "ja" || target.lang !== "en" || source.revision !== sourceRevision || target.revision !== targetRevision) return "conflict";
    await client.query(
      `UPDATE page_translation_relations
          SET reviewed_source_revision = $3, reviewed_target_revision = $4, updated_at = GREATEST(clock_timestamp(), updated_at)
        WHERE owner = $1 AND id = $2`,
      [owner, relation.id, sourceRevision, targetRevision],
    );
    return "reviewed";
  });
}

export type DetachTranslationResult = "detached" | "conflict" | "source_available" | null;

export async function detachManagedTranslation(db: Database, owner: OwnerId, targetPageId: string, targetRevision: number): Promise<DetachTranslationResult> {
  assertOwner(owner);
  if (!isPageId(targetPageId)) return null;
  return transaction(db, async (client): Promise<DetachTranslationResult> => {
    const relation = (await client.query<{ id: string; source_page_id: string | null }>(
      "SELECT id, source_page_id FROM page_translation_relations WHERE owner = $1 AND target_page_id = $2 AND detached_at IS NULL FOR UPDATE",
      [owner, targetPageId],
    )).rows[0];
    if (!relation) return null;
    const target = (await client.query<{ revision: number; lang: string }>(
      "SELECT revision, lang FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL FOR SHARE",
      [owner, targetPageId],
    )).rows[0];
    if (!target) return null;
    if (target.lang !== "en" || target.revision !== targetRevision) return "conflict";
    if (relation.source_page_id !== null) {
      const source = await client.query("SELECT 1 FROM pages WHERE owner = $1 AND id = $2 AND deleted_at IS NULL", [owner, relation.source_page_id]);
      if (source.rows.length > 0) return "source_available";
    }
    await client.query(
      `UPDATE page_translation_relations
          SET source_page_id = NULL, detached_at = clock_timestamp(), reviewed_source_revision = NULL,
              reviewed_target_revision = NULL, updated_at = GREATEST(clock_timestamp(), updated_at)
        WHERE owner = $1 AND id = $2`,
      [owner, relation.id],
    );
    return "detached";
  });
}

export type TranslationReviewProblem = "source_missing" | "source_updated" | "target_updated" | "language_changed";

/** PublishService の transaction 内で呼び、managed target だけを現在 revision で gate する。 */
export async function managedTranslationReviewProblem(db: Queryable, owner: OwnerId, targetPageId: string): Promise<TranslationReviewProblem | null> {
  assertOwner(owner);
  if (!isPageId(targetPageId)) return null;
  const row = (await db.query<{
    source_page_id: string | null; source_revision: number | null; source_lang: string | null; source_deleted: Date | null;
    target_revision: number; target_lang: string; reviewed_source_revision: number | null; reviewed_target_revision: number | null;
  }>(
    `SELECT r.source_page_id, s.revision AS source_revision, s.lang AS source_lang, s.deleted_at AS source_deleted,
            t.revision AS target_revision, t.lang AS target_lang, r.reviewed_source_revision, r.reviewed_target_revision
       FROM page_translation_relations r
       JOIN pages t ON t.owner = r.owner AND t.id = r.target_page_id
       LEFT JOIN pages s ON s.owner = r.owner AND s.id = r.source_page_id
      WHERE r.owner = $1 AND r.target_page_id = $2 AND r.detached_at IS NULL`,
    [owner, targetPageId],
  )).rows[0];
  if (!row) return null;
  if (row.source_page_id === null || row.source_revision === null || row.source_deleted !== null) return "source_missing";
  if (row.source_lang !== "ja" || row.target_lang !== "en") return "language_changed";
  if (row.reviewed_source_revision !== row.source_revision) return "source_updated";
  if (row.reviewed_target_revision !== row.target_revision) return "target_updated";
  return null;
}

/** 期限切れの内容を消し、未採用 copy object の回収位置を返す。object 自体はこの port では削除しない。 */
export async function purgeExpiredTranslationProposals(db: Database, owner?: OwnerId): Promise<string[]> {
  if (owner !== undefined) assertOwner(owner);
  return transaction(db, async (client) => {
    const due = await client.query<{ id: string }>(
      `SELECT id FROM page_translation_proposals
        WHERE ($1::text IS NULL OR owner = $1)
          AND ((expires_at <= clock_timestamp() AND status IN ('generating', 'ready', 'failed'))
               OR (status = 'expired' AND EXISTS (
                 SELECT 1 FROM page_translation_asset_copies c
                  WHERE c.proposal_id = page_translation_proposals.id AND c.state IN ('planned', 'copied', 'failed')
               )))
        ORDER BY id FOR UPDATE`,
      [owner ?? null],
    );
    const ids = due.rows.map((row) => row.id);
    if (ids.length === 0) return [];
    const paths = await client.query<{ target_object_path: string }>(
      `SELECT target_object_path FROM page_translation_asset_copies
        WHERE proposal_id = ANY($1::uuid[]) AND state IN ('planned', 'copied', 'failed')
        ORDER BY target_object_path COLLATE "C"`,
      [ids],
    );
    await client.query(
      `UPDATE page_translation_proposals
          SET status = 'expired', lease_until = NULL, error_code = COALESCE(error_code, 'expired'),
              payload_key_id = NULL, payload_nonce = NULL, payload_ciphertext = NULL, payload_tag = NULL,
              updated_at = GREATEST(clock_timestamp(), updated_at)
        WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return paths.rows.map((row) => row.target_object_path);
  });
}

/** アカウント消去の transaction から呼ぶ境界。未採用objectの回収位置を返し、候補・copy台帳・relationを消す。 */
export async function purgeOwnerTranslationData(db: Queryable, owner: OwnerId): Promise<string[]> {
  assertOwner(owner);
  const paths = await db.query<{ target_object_path: string }>(
    `SELECT DISTINCT c.target_object_path
       FROM page_translation_asset_copies c
       JOIN page_translation_proposals p ON p.id = c.proposal_id
      WHERE p.owner = $1 AND c.state IN ('planned', 'copied', 'failed')
      ORDER BY c.target_object_path COLLATE "C"`,
    [owner],
  );
  await db.query("DELETE FROM page_translation_proposals WHERE owner = $1", [owner]);
  await db.query("DELETE FROM page_translation_relations WHERE owner = $1", [owner]);
  return paths.rows.map((row) => row.target_object_path);
}
