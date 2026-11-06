import { isPageId } from "./store.ts";
import type { Block, Database, OwnerId, Queryable } from "./types.ts";

export const GOOGLE_DOCS_BATCH_MAX_PAGES = 200;
export const GOOGLE_DOCS_BATCH_MAX_BYTES = 32 * 1024 * 1024;
export const GOOGLE_DOCS_BATCH_MAX_ITEM_BYTES = 4 * 1024 * 1024;
export const GOOGLE_DOCS_BATCH_MAX_RAW_SOURCE_BYTES = 32 * 1024 * 1024;
export const GOOGLE_DOCS_BATCH_TTL_MINUTES = 23 * 60 + 50;
export const GOOGLE_DOCS_BATCH_LEASE_MINUTES = 6;

export type GoogleDocsBatchOptions = { includeBackground: boolean; includeTranscript: boolean };
export type GoogleDocsBatchOmission = { reason: string; count: number };
export type GoogleDocsBatchStatus = "prepared" | "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed" | "expired";
export type GoogleDocsBatchItemStatus = "prepared" | "queued" | "running" | "pending" | "completed" | "failed" | "cancelled" | "expired";

export type GoogleDocsBatchTreePageMetadata = {
  id: string;
  title: string;
  revision: number;
  parent: string | null;
  depth: number;
  hasBackground: boolean;
  hasTranscript: boolean;
  hasRecording: boolean;
};

export type GoogleDocsBatchTreePage = GoogleDocsBatchTreePageMetadata & {
  blocks: Block[];
  entities: unknown;
  terms: unknown;
  /** 録音の背景（`page_fields.background`。文字。2026-11-06）。 */
  background: unknown;
  transcriptSegments: unknown;
  speakerNames: unknown;
  backgroundCount: number;
  transcriptCount: number;
};
export type GoogleDocsBatchSourceResult =
  | { ok: true; page: GoogleDocsBatchTreePage }
  | { ok: false; reason: "source_too_large" };

export type GoogleDocsBatchEnvelope = { keyId: string; nonce: Uint8Array; ciphertext: Uint8Array; tag: Uint8Array };
export type PreparedGoogleDocsBatchItem = {
  title: string;
  markdown: string;
  payloadSha256: string;
  payloadBytes: number;
  omissions: readonly GoogleDocsBatchOmission[];
  envelope: GoogleDocsBatchEnvelope;
};

export type GoogleDocsBatchJob = {
  id: string;
  rootPageId: string;
  operationId: string;
  status: GoogleDocsBatchStatus;
  options: GoogleDocsBatchOptions;
  grantAttached: boolean;
  grantRevoked: boolean;
  nextOrdinal: number;
  generation: number;
  errorCode: string | null;
  expiresAt: string;
  createdAt: string;
  cancelledAt: string | null;
  completedAt: string | null;
};

export type GoogleDocsBatchItem = {
  id: string;
  ordinal: number;
  pageId: string;
  pageRevision: number;
  exportId: string;
  payloadSha256: string;
  payloadBytes: number;
  omissions: GoogleDocsBatchOmission[];
  status: GoogleDocsBatchItemStatus;
  sentAt: string | null;
  documentId: string | null;
  retryable: boolean;
  errorCode: string | null;
  title: string;
};

export type GoogleDocsBatchView = { job: GoogleDocsBatchJob; items: GoogleDocsBatchItem[] };

type JobRow = {
  id: string; root_page_id: string; operation_id: string; status: GoogleDocsBatchStatus; options: unknown;
  grant_id: string | null; grant_expires_at: Date | null; grant_revoked_at: Date | null; next_ordinal: number; generation: number;
  error_code: string | null; expires_at: Date; created_at: Date; cancelled_at: Date | null; completed_at: Date | null;
};
type ItemRow = {
  id: string; ordinal: number; page_id: string; page_revision: number; export_id: string; payload_sha256: string; payload_bytes: number;
  omissions: unknown; status: GoogleDocsBatchItemStatus; sent_at: Date | null; document_id: string | null; retryable: boolean;
  error_code: string | null; title: string;
};
type TreeRow = {
  id: string; title: string; revision: number; parent: string | null; depth: number;
  has_background: boolean; has_transcript: boolean; has_recording: boolean;
};
type SourceRow = {
  id: string; title: string; blocks: Block[] | null; revision: number; parent: string | null;
  entities: unknown | null; terms: unknown | null; background: unknown | null; segments: unknown | null; speaker_names: unknown | null;
  has_recording: boolean; background_count: number; transcript_count: number; raw_bytes: string | number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const JOB_COLUMNS = `id, root_page_id, operation_id, status, options, grant_id, grant_expires_at, grant_revoked_at, next_ordinal,
       generation, error_code, expires_at, created_at, cancelled_at, completed_at`;

export class GoogleDocsBatchStoreError extends Error {
  readonly code: "not_found" | "operation_conflict" | "revision_conflict" | "invalid_selection" | "too_many_pages" | "source_too_large" | "payload_too_large" | "state_conflict";
  constructor(code: GoogleDocsBatchStoreError["code"]) {
    super(`editor-store: google docs batch ${code}`);
    this.code = code;
  }
}

function assertOwner(owner: OwnerId): void {
  if (typeof owner !== "string" || owner.length < 1 || owner.length > 256) throw new TypeError("editor-store: owner must be a non-empty stable user id");
}

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new TypeError(`editor-store: invalid ${label}`);
}

function optionsOf(value: unknown): GoogleDocsBatchOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("editor-store: invalid google docs batch options");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "includeBackground,includeTranscript"
    || typeof record.includeBackground !== "boolean" || typeof record.includeTranscript !== "boolean") {
    throw new Error("editor-store: invalid google docs batch options");
  }
  return { includeBackground: record.includeBackground, includeTranscript: record.includeTranscript };
}

function omissionsOf(value: unknown): GoogleDocsBatchOmission[] {
  if (!Array.isArray(value)) return [];
  const out: GoogleDocsBatchOmission[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "count,reason" || typeof record.reason !== "string" || !ERROR_CODE.test(record.reason)
      || !Number.isSafeInteger(record.count) || (record.count as number) < 1) return [];
    out.push({ reason: record.reason, count: record.count as number });
  }
  return out;
}

function jobOf(row: JobRow): GoogleDocsBatchJob {
  return {
    id: row.id,
    rootPageId: row.root_page_id,
    operationId: row.operation_id,
    status: row.status,
    options: optionsOf(row.options),
    grantAttached: row.grant_id !== null,
    grantRevoked: row.grant_revoked_at !== null,
    nextOrdinal: row.next_ordinal,
    generation: row.generation,
    errorCode: row.error_code,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

function itemOf(row: ItemRow): GoogleDocsBatchItem {
  return {
    id: row.id,
    ordinal: row.ordinal,
    pageId: row.page_id,
    pageRevision: row.page_revision,
    exportId: row.export_id,
    payloadSha256: row.payload_sha256,
    payloadBytes: row.payload_bytes,
    omissions: omissionsOf(row.omissions),
    status: row.status,
    sentAt: row.sent_at?.toISOString() ?? null,
    documentId: row.document_id,
    retryable: row.retryable,
    errorCode: row.error_code,
    title: row.title,
  };
}

function assertEnvelope(value: GoogleDocsBatchEnvelope): void {
  if (!value || !/^[A-Za-z0-9._-]{1,32}$/.test(value.keyId) || value.nonce.byteLength !== 12 || value.tag.byteLength !== 16 || value.ciphertext.byteLength < 1) {
    throw new TypeError("editor-store: invalid private payload envelope");
  }
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
    try { await client.query("ROLLBACK"); } catch { broken = true; }
    throw error;
  } finally {
    client.release(broken);
  }
}

async function treeRows(db: Queryable, owner: OwnerId, rootPageId: string, lock: boolean): Promise<TreeRow[]> {
  const result = await db.query<TreeRow>(
    `WITH RECURSIVE tree AS (
       SELECT p.id, 0 AS depth, ARRAY[]::text[] AS path
         FROM pages p WHERE p.owner = $1 AND p.id = $2 AND p.deleted_at IS NULL
       UNION ALL
       SELECT c.id, t.depth + 1,
              -- タブは入れ物の並びの後ろに（入れ物の並び ＋ タブの並び。store の listPageTree と同じ規則。#307）
              t.path || COALESCE((SELECT to_char(h.sort_order, 'FM0000000000') || to_char(h.created_at, 'YYYYMMDDHH24MISSUS') || h.id::text
                                     FROM pages h WHERE h.owner = c.owner AND h.id = c.page), '')
                     || to_char(c.sort_order, 'FM0000000000') || to_char(c.created_at, 'YYYYMMDDHH24MISSUS') || c.id::text
         FROM pages c JOIN tree t ON c.parent = t.id
        WHERE c.owner = $1 AND c.deleted_at IS NULL AND t.depth < 2
     )
     SELECT p.id, p.title, p.revision, p.parent, t.depth,
            (f.page_id IS NOT NULL) AS has_background,
            (r.page_id IS NOT NULL) AS has_transcript,
            (r.page_id IS NOT NULL) AS has_recording
       FROM tree t
       -- 入れ物（kind='page'）は本文を持たないので、件数（上限 200）にも書き出しにも入れない
       JOIN pages p ON p.owner = $1 AND p.id = t.id AND p.deleted_at IS NULL AND p.kind <> 'page'
       LEFT JOIN page_fields f ON f.owner = p.owner AND f.page_id = p.id
       LEFT JOIN page_recordings r ON r.owner = p.owner AND r.page_id = p.id
      ORDER BY t.path
      LIMIT $3${lock ? " FOR UPDATE OF p" : ""}`,
    [owner, rootPageId, GOOGLE_DOCS_BATCH_MAX_PAGES + 1],
  );
  return result.rows;
}

function metadataOf(row: TreeRow): GoogleDocsBatchTreePageMetadata {
  return {
    id: row.id, title: row.title, revision: row.revision, parent: row.parent, depth: row.depth,
    hasBackground: row.has_background, hasTranscript: row.has_transcript, hasRecording: row.has_recording,
  };
}

export async function readGoogleDocsBatchTree(db: Queryable, owner: OwnerId, rootPageId: string): Promise<GoogleDocsBatchTreePageMetadata[] | null> {
  assertOwner(owner);
  if (!isPageId(rootPageId)) return null;
  const rows = await treeRows(db, owner, rootPageId, false);
  if (rows.length === 0) return null;
  if (rows.length > GOOGLE_DOCS_BATCH_MAX_PAGES) throw new GoogleDocsBatchStoreError("too_many_pages");
  return rows.map(metadataOf);
}

async function sourceRow(
  db: Queryable,
  owner: OwnerId,
  pageId: string,
  options: GoogleDocsBatchOptions,
): Promise<SourceRow | null> {
  const backgroundBytes = options.includeBackground
    ? " + octet_length(COALESCE(f.entities, '[]'::jsonb)::text)::bigint + octet_length(COALESCE(f.terms, '[]'::jsonb)::text)::bigint + octet_length(COALESCE(f.background, ''))::bigint"
    : "";
  const transcriptBytes = options.includeTranscript
    ? " + octet_length(COALESCE(r.segments, '[]'::jsonb)::text)::bigint + octet_length(COALESCE(r.speaker_names, '{}'::jsonb)::text)::bigint"
    : "";
  const result = await db.query<SourceRow>(
    `SELECT p.id, p.title, p.revision, p.parent, (r.page_id IS NOT NULL) AS has_recording, sized.raw_bytes,
            (jsonb_array_length(COALESCE(f.entities, '[]'::jsonb)) + jsonb_array_length(COALESCE(f.terms, '[]'::jsonb))
              + CASE WHEN btrim(COALESCE(f.background, '')) <> '' THEN 1 ELSE 0 END) AS background_count,
            jsonb_array_length(COALESCE(r.segments, '[]'::jsonb)) AS transcript_count,
            CASE WHEN sized.raw_bytes <= $3 THEN p.blocks ELSE NULL END AS blocks,
            CASE WHEN sized.raw_bytes <= $3 AND $4::boolean THEN COALESCE(f.entities, '[]'::jsonb) ELSE NULL END AS entities,
            CASE WHEN sized.raw_bytes <= $3 AND $4::boolean THEN COALESCE(f.terms, '[]'::jsonb) ELSE NULL END AS terms,
            CASE WHEN sized.raw_bytes <= $3 AND $4::boolean THEN COALESCE(f.background, '') ELSE NULL END AS background,
            CASE WHEN sized.raw_bytes <= $3 AND $5::boolean THEN COALESCE(r.segments, '[]'::jsonb) ELSE NULL END AS segments,
            CASE WHEN sized.raw_bytes <= $3 AND $5::boolean THEN COALESCE(r.speaker_names, '{}'::jsonb) ELSE NULL END AS speaker_names
       FROM pages p
       LEFT JOIN page_fields f ON f.owner = p.owner AND f.page_id = p.id
       LEFT JOIN page_recordings r ON r.owner = p.owner AND r.page_id = p.id
       CROSS JOIN LATERAL (
         SELECT octet_length(p.title)::bigint + octet_length(p.blocks::text)::bigint${backgroundBytes}${transcriptBytes} AS raw_bytes
       ) sized
      WHERE p.owner = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
    [owner, pageId, GOOGLE_DOCS_BATCH_MAX_RAW_SOURCE_BYTES, options.includeBackground, options.includeTranscript],
  );
  return result.rows[0] ?? null;
}

async function readSource(
  db: Queryable,
  owner: OwnerId,
  metadata: GoogleDocsBatchTreePageMetadata,
  options: GoogleDocsBatchOptions,
): Promise<GoogleDocsBatchSourceResult | null> {
  const row = await sourceRow(db, owner, metadata.id, options);
  if (!row) return null;
  if (Number(row.raw_bytes) > GOOGLE_DOCS_BATCH_MAX_RAW_SOURCE_BYTES || row.blocks === null) {
    return { ok: false, reason: "source_too_large" };
  }
  return {
    ok: true,
    page: {
      ...metadata, title: row.title, revision: row.revision, parent: row.parent, blocks: row.blocks,
      entities: row.entities ?? [], terms: row.terms ?? [], background: row.background ?? "", transcriptSegments: row.segments ?? [], speakerNames: row.speaker_names ?? {},
      hasRecording: row.has_recording, backgroundCount: row.background_count, transcriptCount: row.transcript_count,
    },
  };
}

export async function readGoogleDocsBatchSource(
  db: Queryable,
  owner: OwnerId,
  metadata: GoogleDocsBatchTreePageMetadata,
  options: GoogleDocsBatchOptions,
): Promise<GoogleDocsBatchSourceResult | null> {
  assertOwner(owner);
  if (!isPageId(metadata.id)) return null;
  return readSource(db, owner, metadata, options);
}

export type PrepareGoogleDocsBatchInput = {
  jobId: string;
  rootPageId: string;
  operationId: string;
  requestSha256: string;
  selections: readonly { pageId: string; expectedRevision: number; itemId: string; exportId: string }[];
  options: GoogleDocsBatchOptions;
  expiresAt: string;
  prepare: (page: GoogleDocsBatchTreePage, identity: { jobId: string; itemId: string; expiresAt: string }) => PreparedGoogleDocsBatchItem;
};

export async function prepareGoogleDocsBatch(db: Database, owner: OwnerId, input: PrepareGoogleDocsBatchInput): Promise<{ job: GoogleDocsBatchJob; created: boolean }> {
  assertOwner(owner);
  for (const [value, label] of [[input.jobId, "job id"], [input.rootPageId, "root page id"], [input.operationId, "operation id"]] as const) assertUuid(value, label);
  if (!HASH.test(input.requestSha256) || new Date(input.expiresAt).toISOString() !== input.expiresAt) throw new TypeError("editor-store: invalid google docs batch request");
  if (input.selections.length < 1 || input.selections.length > GOOGLE_DOCS_BATCH_MAX_PAGES) throw new GoogleDocsBatchStoreError("invalid_selection");
  const selected = new Map<string, PrepareGoogleDocsBatchInput["selections"][number]>();
  for (const selection of input.selections) {
    assertUuid(selection.pageId, "page id"); assertUuid(selection.itemId, "item id"); assertUuid(selection.exportId, "export id");
    if (!Number.isSafeInteger(selection.expectedRevision) || selection.expectedRevision < 1 || selected.has(selection.pageId.toLowerCase())) {
      throw new GoogleDocsBatchStoreError("invalid_selection");
    }
    selected.set(selection.pageId.toLowerCase(), selection);
  }
  return transaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${owner}:${input.operationId.toLowerCase()}`]);
    const existing = (await client.query<JobRow>(
      `SELECT ${JOB_COLUMNS} FROM google_docs_batch_jobs WHERE owner = $1 AND operation_id = $2`, [owner, input.operationId],
    )).rows[0];
    if (existing) {
      if (existing.root_page_id !== input.rootPageId.toLowerCase() || (await client.query<{ request_sha256: string }>(
        "SELECT request_sha256 FROM google_docs_batch_jobs WHERE owner = $1 AND id = $2", [owner, existing.id],
      )).rows[0]?.request_sha256 !== input.requestSha256) throw new GoogleDocsBatchStoreError("operation_conflict");
      return { job: jobOf(existing), created: false };
    }
    const rows = await treeRows(client, owner, input.rootPageId, true);
    if (rows.length === 0) throw new GoogleDocsBatchStoreError("not_found");
    if (rows.length > GOOGLE_DOCS_BATCH_MAX_PAGES) throw new GoogleDocsBatchStoreError("too_many_pages");
    const ordered = rows.filter((row) => selected.has(row.id.toLowerCase()));
    if (ordered.length !== selected.size) throw new GoogleDocsBatchStoreError("invalid_selection");
    const submittedOrder = input.selections.map((selection) => selection.pageId.toLowerCase());
    if (ordered.some((row, index) => row.id.toLowerCase() !== submittedOrder[index])) throw new GoogleDocsBatchStoreError("invalid_selection");
    for (const row of ordered) {
      const selection = selected.get(row.id.toLowerCase())!;
      if (row.revision !== selection.expectedRevision) throw new GoogleDocsBatchStoreError("revision_conflict");
    }
    const inserted = (await client.query<JobRow>(
      `INSERT INTO google_docs_batch_jobs (id, owner, root_page_id, operation_id, request_sha256, options, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING ${JOB_COLUMNS}`,
      [input.jobId, owner, input.rootPageId, input.operationId, input.requestSha256, JSON.stringify(input.options), input.expiresAt],
    )).rows[0]!;
    let totalBytes = 0;
    for (let ordinal = 0; ordinal < ordered.length; ordinal += 1) {
      const row = ordered[ordinal]!;
      const selection = selected.get(row.id.toLowerCase())!;
      const source = await readSource(client, owner, metadataOf(row), input.options);
      if (!source) throw new GoogleDocsBatchStoreError("revision_conflict");
      if (!source.ok) throw new GoogleDocsBatchStoreError(source.reason);
      if (source.page.revision !== selection.expectedRevision) throw new GoogleDocsBatchStoreError("revision_conflict");
      const payload = input.prepare(source.page, { jobId: input.jobId, itemId: selection.itemId, expiresAt: input.expiresAt });
      assertEnvelope(payload.envelope);
      if (!HASH.test(payload.payloadSha256) || !Number.isSafeInteger(payload.payloadBytes) || payload.payloadBytes < 1) throw new TypeError("editor-store: invalid Google Docs payload");
      if (payload.payloadBytes > GOOGLE_DOCS_BATCH_MAX_ITEM_BYTES) throw new GoogleDocsBatchStoreError("payload_too_large");
      totalBytes += payload.payloadBytes;
      if (totalBytes > GOOGLE_DOCS_BATCH_MAX_BYTES) throw new GoogleDocsBatchStoreError("payload_too_large");
      await client.query(
        `INSERT INTO google_docs_batch_items
           (id, job_id, owner, ordinal, page_id, page_revision, export_id, payload_sha256, payload_bytes, omissions,
            payload_key_id, payload_nonce, payload_ciphertext, payload_tag)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)`,
        [selection.itemId, input.jobId, owner, ordinal, row.id, row.revision, selection.exportId, payload.payloadSha256, payload.payloadBytes,
          JSON.stringify(payload.omissions), payload.envelope.keyId, Buffer.from(payload.envelope.nonce), Buffer.from(payload.envelope.ciphertext), Buffer.from(payload.envelope.tag)],
      );
    }
    return { job: jobOf(inserted), created: true };
  });
}

export async function getGoogleDocsBatch(db: Queryable, owner: OwnerId, jobId: string): Promise<GoogleDocsBatchView | null> {
  assertOwner(owner);
  if (!isPageId(jobId)) return null;
  const job = (await db.query<JobRow>(`SELECT ${JOB_COLUMNS} FROM google_docs_batch_jobs WHERE owner = $1 AND id = $2`, [owner, jobId])).rows[0];
  if (!job) return null;
  const items = await db.query<ItemRow>(
    `SELECT i.id, i.ordinal, i.page_id, i.page_revision, i.export_id, i.payload_sha256, i.payload_bytes, i.omissions,
            i.status, i.sent_at, i.document_id, i.retryable, i.error_code, COALESCE(p.title, '') AS title
       FROM google_docs_batch_items i
       LEFT JOIN pages p ON p.owner = i.owner AND p.id = i.page_id
      WHERE i.owner = $1 AND i.job_id = $2 ORDER BY i.ordinal`,
    [owner, jobId],
  );
  return { job: jobOf(job), items: items.rows.map(itemOf) };
}

/**
 * ページから batch 面を開き直したときに復帰する、同じ root の最新 job。
 * job id を URL・cookie・browser storage に置かず、owner と root の組で DB から引き直す。
 */
export async function getLatestGoogleDocsBatchForRoot(
  db: Queryable,
  owner: OwnerId,
  rootPageId: string,
): Promise<GoogleDocsBatchView | null> {
  assertOwner(owner);
  if (!isPageId(rootPageId)) return null;
  const latest = (await db.query<{ id: string }>(
    `SELECT id FROM google_docs_batch_jobs
      WHERE owner=$1 AND root_page_id=$2
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [owner, rootPageId],
  )).rows[0];
  return latest ? getGoogleDocsBatch(db, owner, latest.id) : null;
}

export async function attachGoogleDocsBatchGrant(db: Database, owner: OwnerId, jobId: string, grantId: string, grantExpiresAt: string): Promise<boolean> {
  assertOwner(owner); assertUuid(jobId, "job id"); assertUuid(grantId, "grant id");
  if (new Date(grantExpiresAt).toISOString() !== grantExpiresAt) throw new TypeError("editor-store: invalid grant expiry");
  return transaction(db, async (client) => {
    const job = (await client.query<JobRow & { request_sha256: string }>(
      `SELECT ${JOB_COLUMNS}, request_sha256 FROM google_docs_batch_jobs WHERE owner = $1 AND id = $2 FOR UPDATE`, [owner, jobId],
    )).rows[0];
    if (!job || ["cancelled", "completed", "failed", "expired"].includes(job.status)) return false;
    const effectiveGrantExpiresAt = new Date(Math.min(Date.parse(grantExpiresAt), job.expires_at.getTime() + 10 * 60_000)).toISOString();
    if (job.grant_id !== null) return job.grant_id === grantId && job.grant_expires_at?.toISOString() === effectiveGrantExpiresAt;
    const changed = await client.query(
      `UPDATE google_docs_batch_jobs SET grant_id=$3, grant_expires_at=$4, status='queued', updated_at=clock_timestamp()
        WHERE owner=$1 AND id=$2 AND $4::timestamptz>clock_timestamp()`, [owner, jobId, grantId, effectiveGrantExpiresAt],
    );
    if (changed.rowCount !== 1) return false;
    await client.query("UPDATE google_docs_batch_items SET status='queued', updated_at=clock_timestamp() WHERE owner=$1 AND job_id=$2 AND status='prepared'", [owner, jobId]);
    await client.query(
      `INSERT INTO google_docs_batch_outbox (job_id, generation, dispatch_attempt)
       VALUES ($1, $2, 1) ON CONFLICT DO NOTHING`, [jobId, job.generation],
    );
    return true;
  });
}

export async function markGoogleDocsBatchGrantRevoked(
  db: Queryable,
  owner: OwnerId,
  jobId: string,
  grantId: string,
): Promise<boolean> {
  assertOwner(owner); assertUuid(jobId, "job id"); assertUuid(grantId, "grant id");
  const result = await db.query(
    `UPDATE google_docs_batch_jobs SET grant_revoked_at=COALESCE(grant_revoked_at,clock_timestamp()),updated_at=clock_timestamp()
      WHERE owner=$1 AND id=$2 AND grant_id=$3 AND status IN ('cancelling','cancelled')`,
    [owner, jobId, grantId],
  );
  return result.rowCount === 1;
}

export type GoogleDocsBatchOutboxEntry = { jobId: string; generation: number; dispatchAttempt: number };

export async function listGoogleDocsBatchOutbox(db: Queryable, limit = 100): Promise<GoogleDocsBatchOutboxEntry[]> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
  const rows = await db.query<{ job_id: string; generation: number; dispatch_attempt: number }>(
    `SELECT o.job_id, o.generation, o.dispatch_attempt
       FROM google_docs_batch_outbox o
       JOIN google_docs_batch_jobs j ON j.id=o.job_id AND j.generation=o.generation
      WHERE o.state='pending' AND o.available_at <= clock_timestamp()
        AND j.status IN ('queued','running','cancelling')
      ORDER BY o.available_at, o.job_id, o.generation, o.dispatch_attempt LIMIT $1`, [safeLimit],
  );
  return rows.rows.map((row) => ({ jobId: row.job_id, generation: row.generation, dispatchAttempt: row.dispatch_attempt }));
}

export async function markGoogleDocsBatchOutboxSubmitted(db: Queryable, entry: GoogleDocsBatchOutboxEntry): Promise<boolean> {
  const result = await db.query(
    `UPDATE google_docs_batch_outbox SET state='submitted', submitted_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE job_id=$1 AND generation=$2 AND dispatch_attempt=$3 AND state='pending'`,
    [entry.jobId, entry.generation, entry.dispatchAttempt],
  );
  return result.rowCount === 1;
}

export type ClaimedGoogleDocsBatchItem = {
  owner: string;
  jobId: string;
  itemId: string;
  ordinal: number;
  generation: number;
  grantId: string;
  exportId: string;
  payloadSha256: string;
  payloadBytes: number;
  envelope: GoogleDocsBatchEnvelope | null;
  expiresAt: string;
  alreadySent: boolean;
  /** owner cancel 後の inflight。payload/export は使わず receipt status だけを読む。 */
  receiptOnly: boolean;
};

export async function claimGoogleDocsBatchItem(db: Database, jobId: string, generation: number): Promise<ClaimedGoogleDocsBatchItem | null> {
  if (!isPageId(jobId) || !Number.isSafeInteger(generation) || generation < 1) return null;
  return transaction(db, async (client) => {
    const job = (await client.query<{
      owner: string; status: GoogleDocsBatchStatus; grant_id: string | null; next_ordinal: number; generation: number;
      lease_available: boolean; processable: boolean; expires_at: Date;
    }>(`SELECT owner,status,grant_id,next_ordinal,generation,expires_at,
               (lease_until IS NULL OR lease_until<=clock_timestamp()) AS lease_available,
               (expires_at>clock_timestamp() OR (status='cancelling' AND grant_expires_at>clock_timestamp())) AS processable
          FROM google_docs_batch_jobs WHERE id=$1 FOR UPDATE`, [jobId])).rows[0];
    if (!job || job.grant_id === null || job.generation !== generation || !["queued", "running", "cancelling"].includes(job.status)
      || !job.processable || !job.lease_available) return null;
    const item = (await client.query<{
      id: string; ordinal: number; export_id: string; payload_sha256: string; payload_bytes: number; payload_key_id: string | null;
      payload_nonce: Buffer | null; payload_ciphertext: Buffer | null; payload_tag: Buffer | null; sent_at: Date | null; status: GoogleDocsBatchItemStatus;
    }>(
      `SELECT id,ordinal,export_id,payload_sha256,payload_bytes,payload_key_id,payload_nonce,payload_ciphertext,payload_tag,sent_at,status
         FROM google_docs_batch_items WHERE job_id=$1 AND ordinal=$2 FOR UPDATE`, [jobId, job.next_ordinal],
    )).rows[0];
    if (!item) {
      await client.query(
        "UPDATE google_docs_batch_jobs SET status='failed',error_code='page_deleted',lease_until=NULL,heartbeat_at=NULL,updated_at=clock_timestamp() WHERE id=$1",
        [jobId],
      );
      await client.query(
        `UPDATE google_docs_batch_items SET status=CASE WHEN status='completed' THEN status ELSE 'cancelled' END,retryable=false,
                payload_key_id=NULL,payload_nonce=NULL,payload_ciphertext=NULL,payload_tag=NULL,updated_at=clock_timestamp()
          WHERE job_id=$1`, [jobId],
      );
      return null;
    }
    if (!["queued", "pending", "running"].includes(item.status)) return null;
    const receiptOnly = job.status === "cancelling";
    if (receiptOnly ? item.sent_at === null : (item.payload_key_id === null || item.payload_nonce === null
      || item.payload_ciphertext === null || item.payload_tag === null)) return null;
    await client.query(
      `UPDATE google_docs_batch_jobs SET status=CASE WHEN status='cancelling' THEN status ELSE 'running' END,
              lease_until=clock_timestamp()+($3::text || ' minutes')::interval,
              heartbeat_at=clock_timestamp(), updated_at=clock_timestamp()
        WHERE id=$1 AND generation=$2`, [jobId, generation, GOOGLE_DOCS_BATCH_LEASE_MINUTES],
    );
    await client.query("UPDATE google_docs_batch_items SET status='running', updated_at=clock_timestamp() WHERE job_id=$1 AND id=$2", [jobId, item.id]);
    return {
      owner: job.owner, jobId, itemId: item.id, ordinal: item.ordinal, generation, grantId: job.grant_id,
      exportId: item.export_id, payloadSha256: item.payload_sha256, payloadBytes: item.payload_bytes,
      envelope: receiptOnly ? null : { keyId: item.payload_key_id!, nonce: item.payload_nonce!, ciphertext: item.payload_ciphertext!, tag: item.payload_tag! },
      expiresAt: job.expires_at.toISOString(), alreadySent: item.sent_at !== null, receiptOnly,
    };
  });
}

/** 外部 POST の直前の CAS。取消・期限切れが先なら false で、worker は receipt-only status 以外へ進まない。 */
export async function markGoogleDocsBatchItemSent(db: Queryable, claim: ClaimedGoogleDocsBatchItem): Promise<boolean> {
  const result = await db.query(
    `UPDATE google_docs_batch_items i SET sent_at=COALESCE(i.sent_at,clock_timestamp()), updated_at=clock_timestamp()
       FROM google_docs_batch_jobs j
      WHERE i.job_id=j.id AND i.id=$1 AND j.id=$2 AND j.generation=$3 AND j.next_ordinal=i.ordinal
        AND j.status='running' AND j.lease_until > clock_timestamp() AND j.expires_at > clock_timestamp()
        AND EXISTS (SELECT 1 FROM pages root WHERE root.owner=j.owner AND root.id=j.root_page_id AND root.deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM pages source WHERE source.owner=i.owner AND source.id=i.page_id AND source.deleted_at IS NULL)
        AND i.status='running'`,
    [claim.itemId, claim.jobId, claim.generation],
  );
  return result.rowCount === 1;
}

async function nextOutbox(client: Queryable, jobId: string, generation: number, delaySeconds = 0): Promise<void> {
  await client.query(
    `INSERT INTO google_docs_batch_outbox (job_id,generation,dispatch_attempt,available_at)
     VALUES ($1,$2,1,clock_timestamp()+($3::text || ' seconds')::interval) ON CONFLICT DO NOTHING`,
    [jobId, generation, Math.max(0, Math.trunc(delaySeconds))],
  );
}

export async function completeGoogleDocsBatchItem(db: Database, claim: ClaimedGoogleDocsBatchItem, documentId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{10,256}$/.test(documentId)) throw new TypeError("editor-store: invalid Google document id");
  return transaction(db, async (client) => {
    const job = (await client.query<{ status: GoogleDocsBatchStatus; generation: number; next_ordinal: number }>(
      "SELECT status,generation,next_ordinal FROM google_docs_batch_jobs WHERE id=$1 FOR UPDATE", [claim.jobId],
    )).rows[0];
    if (!job || job.generation !== claim.generation || job.next_ordinal !== claim.ordinal || !["running", "cancelling"].includes(job.status)) return false;
    const changed = await client.query(
      `UPDATE google_docs_batch_items SET status='completed',document_id=$3,retryable=false,error_code=NULL,
              payload_key_id=NULL,payload_nonce=NULL,payload_ciphertext=NULL,payload_tag=NULL,updated_at=clock_timestamp()
        WHERE job_id=$1 AND id=$2 AND status='running'`, [claim.jobId, claim.itemId, documentId],
    );
    if (changed.rowCount !== 1) return false;
    if (job.status === "cancelling") {
      await client.query(
        `UPDATE google_docs_batch_items SET status='cancelled',retryable=false,
                payload_key_id=NULL,payload_nonce=NULL,payload_ciphertext=NULL,payload_tag=NULL,updated_at=clock_timestamp()
          WHERE job_id=$1 AND status NOT IN ('completed','cancelled')`, [claim.jobId],
      );
      await client.query(
        `UPDATE google_docs_batch_jobs SET status='cancelled',lease_until=NULL,heartbeat_at=NULL,cancelled_at=COALESCE(cancelled_at,clock_timestamp()),updated_at=clock_timestamp()
          WHERE id=$1`, [claim.jobId],
      );
      return true;
    }
    const more = (await client.query<{ ordinal: number }>(
      "SELECT ordinal FROM google_docs_batch_items WHERE job_id=$1 AND ordinal>$2 ORDER BY ordinal LIMIT 1", [claim.jobId, claim.ordinal],
    )).rows[0];
    if (!more) {
      await client.query(
        `UPDATE google_docs_batch_jobs SET status='completed',next_ordinal=$2+1,lease_until=NULL,heartbeat_at=NULL,
                completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`, [claim.jobId, claim.ordinal],
      );
      await client.query(
        `UPDATE google_docs_batch_items SET payload_key_id=NULL,payload_nonce=NULL,payload_ciphertext=NULL,payload_tag=NULL,updated_at=clock_timestamp()
          WHERE job_id=$1`, [claim.jobId],
      );
      return true;
    }
    const generation = claim.generation + 1;
    await client.query(
      `UPDATE google_docs_batch_jobs SET status='queued',next_ordinal=$2,generation=$3,lease_until=NULL,heartbeat_at=NULL,updated_at=clock_timestamp()
        WHERE id=$1`, [claim.jobId, more.ordinal, generation],
    );
    await client.query("UPDATE google_docs_batch_items SET status='queued',updated_at=clock_timestamp() WHERE job_id=$1 AND ordinal=$2", [claim.jobId, more.ordinal]);
    await nextOutbox(client, claim.jobId, generation);
    return true;
  });
}

/** 一時障害・pending/UNCERTAIN は同じ item/export id のまま新 generation へ積み直す。 */
export async function requeueGoogleDocsBatchItem(
  db: Database,
  claim: ClaimedGoogleDocsBatchItem,
  input: { errorCode: string; retryable: boolean; delaySeconds: number },
): Promise<boolean> {
  if (!ERROR_CODE.test(input.errorCode)) throw new TypeError("editor-store: invalid Google Docs error code");
  return transaction(db, async (client) => {
    const job = (await client.query<{ status: GoogleDocsBatchStatus; generation: number; next_ordinal: number }>(
      "SELECT status,generation,next_ordinal FROM google_docs_batch_jobs WHERE id=$1 FOR UPDATE", [claim.jobId],
    )).rows[0];
    if (!job || !["running", "cancelling"].includes(job.status) || job.generation !== claim.generation || job.next_ordinal !== claim.ordinal) return false;
    const nextGeneration = claim.generation + 1;
    await client.query(
      `UPDATE google_docs_batch_items SET status='pending',retryable=$3,error_code=$4,updated_at=clock_timestamp()
        WHERE job_id=$1 AND id=$2 AND status='running'`, [claim.jobId, claim.itemId, input.retryable, input.errorCode],
    );
    await client.query(
      `UPDATE google_docs_batch_jobs SET status=CASE WHEN status='cancelling' THEN status ELSE 'queued' END,
              generation=$2,lease_until=NULL,heartbeat_at=NULL,error_code=NULL,updated_at=clock_timestamp()
        WHERE id=$1`, [claim.jobId, nextGeneration],
    );
    await nextOutbox(client, claim.jobId, nextGeneration, input.delaySeconds);
    return true;
  });
}

export async function failGoogleDocsBatchItem(
  db: Database,
  claim: ClaimedGoogleDocsBatchItem,
  input: { errorCode: string; retryable: boolean; stopFuture?: boolean },
): Promise<boolean> {
  if (!ERROR_CODE.test(input.errorCode)) throw new TypeError("editor-store: invalid Google Docs error code");
  return transaction(db, async (client) => {
    const job = (await client.query<{ status: GoogleDocsBatchStatus; generation: number; next_ordinal: number }>(
      "SELECT status,generation,next_ordinal FROM google_docs_batch_jobs WHERE id=$1 FOR UPDATE", [claim.jobId],
    )).rows[0];
    if (!job || !["running", "cancelling"].includes(job.status) || job.generation !== claim.generation || job.next_ordinal !== claim.ordinal) return false;
    await client.query(
      `UPDATE google_docs_batch_items SET status='failed',retryable=$3,error_code=$4,
              payload_key_id=CASE WHEN $3 THEN payload_key_id ELSE NULL END,
              payload_nonce=CASE WHEN $3 THEN payload_nonce ELSE NULL END,
              payload_ciphertext=CASE WHEN $3 THEN payload_ciphertext ELSE NULL END,
              payload_tag=CASE WHEN $3 THEN payload_tag ELSE NULL END,updated_at=clock_timestamp()
        WHERE job_id=$1 AND id=$2`, [claim.jobId, claim.itemId, input.retryable, input.errorCode],
    );
    if (input.stopFuture || job.status === "cancelling") {
      await client.query(
        `UPDATE google_docs_batch_items SET status='cancelled',retryable=false,
                payload_key_id=NULL,payload_nonce=NULL,payload_ciphertext=NULL,payload_tag=NULL,updated_at=clock_timestamp()
          WHERE job_id=$1 AND ordinal>$2 AND status NOT IN ('completed','cancelled')`, [claim.jobId, claim.ordinal],
      );
    }
    const cancelled = job.status === "cancelling";
    await client.query(
      `UPDATE google_docs_batch_jobs SET status=$2,error_code=$3,lease_until=NULL,heartbeat_at=NULL,
              cancelled_at=CASE WHEN $2='cancelled' THEN COALESCE(cancelled_at,clock_timestamp()) ELSE cancelled_at END,
              updated_at=clock_timestamp() WHERE id=$1`,
      [claim.jobId, cancelled ? "cancelled" : "failed", input.errorCode],
    );
    return true;
  });
}

export async function settleCancelledGoogleDocsBatchClaim(db: Database, claim: ClaimedGoogleDocsBatchItem): Promise<boolean> {
  return transaction(db, async (client) => {
    const job = (await client.query<{ status: GoogleDocsBatchStatus; generation: number; next_ordinal: number }>(
      "SELECT status,generation,next_ordinal FROM google_docs_batch_jobs WHERE id=$1 FOR UPDATE", [claim.jobId],
    )).rows[0];
    if (!job || job.status !== "cancelling" || job.generation !== claim.generation || job.next_ordinal !== claim.ordinal) return false;
    await client.query(
      `UPDATE google_docs_batch_items SET status='cancelled',retryable=false,error_code=NULL,
              payload_key_id=NULL,payload_nonce=NULL,payload_ciphertext=NULL,payload_tag=NULL,updated_at=clock_timestamp()
        WHERE job_id=$1 AND id=$2 AND status='running'`, [claim.jobId, claim.itemId],
    );
    await client.query(
      `UPDATE google_docs_batch_jobs SET status='cancelled',lease_until=NULL,heartbeat_at=NULL,
              cancelled_at=COALESCE(cancelled_at,clock_timestamp()),updated_at=clock_timestamp() WHERE id=$1`, [claim.jobId],
    );
    return true;
  });
}

export async function retryGoogleDocsBatchItem(db: Database, owner: OwnerId, jobId: string, ordinal: number): Promise<boolean> {
  assertOwner(owner);
  if (!isPageId(jobId) || !Number.isSafeInteger(ordinal) || ordinal < 0) return false;
  return transaction(db, async (client) => {
    const job = (await client.query<{ status: GoogleDocsBatchStatus; generation: number; next_ordinal: number }>(
      "SELECT status,generation,next_ordinal FROM google_docs_batch_jobs WHERE owner=$1 AND id=$2 AND expires_at>clock_timestamp() FOR UPDATE", [owner, jobId],
    )).rows[0];
    if (!job || job.status !== "failed" || job.next_ordinal !== ordinal) return false;
    const item = (await client.query<{ id: string; retryable: boolean; payload_key_id: string | null }>(
      "SELECT id,retryable,payload_key_id FROM google_docs_batch_items WHERE owner=$1 AND job_id=$2 AND ordinal=$3 FOR UPDATE", [owner, jobId, ordinal],
    )).rows[0];
    if (!item?.retryable || item.payload_key_id === null) return false;
    const generation = job.generation + 1;
    await client.query("UPDATE google_docs_batch_items SET status='queued',error_code=NULL,retryable=false,updated_at=clock_timestamp() WHERE id=$1", [item.id]);
    await client.query(
      "UPDATE google_docs_batch_jobs SET status='queued',generation=$3,error_code=NULL,updated_at=clock_timestamp() WHERE owner=$1 AND id=$2",
      [owner, jobId, generation],
    );
    await nextOutbox(client, jobId, generation);
    return true;
  });
}

export type GoogleDocsBatchCancellation = { grantId: string | null; inflight: boolean };

export async function cancelGoogleDocsBatch(db: Database, owner: OwnerId, jobId: string): Promise<GoogleDocsBatchCancellation | null> {
  assertOwner(owner);
  if (!isPageId(jobId)) return null;
  return transaction(db, async (client) => {
    const job = (await client.query<{ status: GoogleDocsBatchStatus; grant_id: string | null; grant_revoked_at: Date | null; next_ordinal: number }>(
      "SELECT status,grant_id,grant_revoked_at,next_ordinal FROM google_docs_batch_jobs WHERE owner=$1 AND id=$2 FOR UPDATE", [owner, jobId],
    )).rows[0];
    if (!job) return null;
    if (["completed", "expired"].includes(job.status)) return { grantId: null, inflight: false };
    if (job.status === "cancelled") return { grantId: job.grant_revoked_at === null ? job.grant_id : null, inflight: false };
    const current = (await client.query<{ status: GoogleDocsBatchItemStatus; sent_at: Date | null }>(
      "SELECT status,sent_at FROM google_docs_batch_items WHERE owner=$1 AND job_id=$2 AND ordinal=$3 FOR UPDATE", [owner, jobId, job.next_ordinal],
    )).rows[0];
    const inflight = current?.sent_at !== null && current?.sent_at !== undefined
      && ["running", "pending", "queued"].includes(current.status);
    // 取消後は、現在の item も含め snapshot payload を即時消去する。inflight は receipt の照会だけで完了を回収できる。
    await client.query(
      `UPDATE google_docs_batch_items SET payload_key_id=NULL,payload_nonce=NULL,payload_ciphertext=NULL,payload_tag=NULL,updated_at=clock_timestamp()
        WHERE owner=$1 AND job_id=$2`, [owner, jobId],
    );
    await client.query(
      `UPDATE google_docs_batch_items SET status='cancelled',retryable=false,
              payload_key_id=NULL,payload_nonce=NULL,payload_ciphertext=NULL,payload_tag=NULL,updated_at=clock_timestamp()
        WHERE owner=$1 AND job_id=$2 AND ordinal ${inflight ? ">" : ">="} $3 AND status NOT IN ('completed','cancelled')`,
      [owner, jobId, job.next_ordinal],
    );
    await client.query(
      `UPDATE google_docs_batch_jobs SET status=$3,lease_until=CASE WHEN $4 THEN lease_until ELSE NULL END,
              cancelled_at=COALESCE(cancelled_at,clock_timestamp()),updated_at=clock_timestamp()
        WHERE owner=$1 AND id=$2`, [owner, jobId, inflight ? "cancelling" : "cancelled", inflight],
    );
    return { grantId: job.grant_revoked_at === null ? job.grant_id : null, inflight };
  });
}

export async function listPreparedGoogleDocsBatches(db: Queryable, limit = 100): Promise<Array<{ jobId: string; owner: string }>> {
  const rows = await db.query<{ id: string; owner: string }>(
    `SELECT id,owner FROM google_docs_batch_jobs
      WHERE status='prepared' AND grant_id IS NULL AND expires_at>clock_timestamp()
      ORDER BY updated_at,id LIMIT $1`, [Math.max(1, Math.min(Math.trunc(limit), 100))],
  );
  return rows.rows.map((row) => ({ jobId: row.id, owner: row.owner }));
}

/** lease切れと、送信済みtaskが届かなかったqueued itemを新しいtask名へ戻す。 */
export async function recoverGoogleDocsBatchDispatches(db: Database): Promise<number> {
  return transaction(db, async (client) => {
    const expired = await client.query<{ id: string; generation: number; next_ordinal: number }>(
      `SELECT id,generation,next_ordinal FROM google_docs_batch_jobs
        WHERE status IN ('running','cancelling') AND lease_until<=clock_timestamp()
          AND (expires_at>clock_timestamp() OR (status='cancelling' AND grant_expires_at>clock_timestamp()))
        ORDER BY lease_until,id FOR UPDATE`,
    );
    let recovered = 0;
    for (const job of expired.rows) {
      const generation = job.generation + 1;
      await client.query(
        `UPDATE google_docs_batch_jobs SET status=CASE WHEN status='cancelling' THEN status ELSE 'queued' END,
                generation=$2,lease_until=NULL,heartbeat_at=NULL,updated_at=clock_timestamp() WHERE id=$1`,
        [job.id, generation],
      );
      await client.query(
        `UPDATE google_docs_batch_items SET status=CASE WHEN sent_at IS NULL THEN 'queued' ELSE 'pending' END,
                error_code='lease_expired',retryable=false,updated_at=clock_timestamp()
          WHERE job_id=$1 AND ordinal=$2 AND status='running'`, [job.id, job.next_ordinal],
      );
      await nextOutbox(client, job.id, generation);
      recovered += 1;
    }
    const stranded = await client.query<{ id: string; generation: number; attempt: number }>(
      `SELECT j.id,j.generation,COALESCE(max(o.dispatch_attempt),0)::int+1 AS attempt
         FROM google_docs_batch_jobs j
         LEFT JOIN google_docs_batch_outbox o ON o.job_id=j.id AND o.generation=j.generation
        WHERE j.status IN ('queued','cancelling')
          AND (j.expires_at>clock_timestamp() OR (j.status='cancelling' AND j.grant_expires_at>clock_timestamp()))
        GROUP BY j.id,j.generation,j.updated_at
       HAVING bool_and(o.state IS NULL OR o.state='submitted')
          AND COALESCE(max(o.submitted_at),j.updated_at) <= clock_timestamp()-interval '1 minute'
        ORDER BY j.id`,
    );
    for (const job of stranded.rows) {
      await client.query(
        `INSERT INTO google_docs_batch_outbox(job_id,generation,dispatch_attempt)
         VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [job.id, job.generation, job.attempt],
      );
      recovered += 1;
    }
    return recovered;
  });
}

/** 共通 private-jobs cleanup から呼び、暗号化payloadを正常時24時間以内に消す。 */
export async function purgeExpiredGoogleDocsBatches(db: Queryable, owner?: OwnerId): Promise<number> {
  if (owner !== undefined) assertOwner(owner);
  const due = await db.query<{ id: string; status: GoogleDocsBatchStatus }>(
    `UPDATE google_docs_batch_jobs j SET
            status=CASE
              WHEN j.status IN ('completed','cancelled') THEN j.status
              WHEN j.grant_expires_at>clock_timestamp() AND EXISTS (
                SELECT 1 FROM google_docs_batch_items i
                 WHERE i.job_id=j.id AND i.ordinal=j.next_ordinal AND i.sent_at IS NOT NULL
                   AND i.status IN ('running','pending','queued')
              ) THEN 'cancelling'
              ELSE 'expired'
            END,
            lease_until=CASE
              WHEN j.status IN ('running','cancelling') AND j.lease_until>clock_timestamp() THEN j.lease_until ELSE NULL
            END,
            heartbeat_at=CASE
              WHEN j.status IN ('running','cancelling') AND j.lease_until>clock_timestamp() THEN j.heartbeat_at ELSE NULL
            END,
            error_code=COALESCE(j.error_code,'expired'),updated_at=clock_timestamp()
      WHERE ($1::text IS NULL OR j.owner=$1) AND j.expires_at<=clock_timestamp()
        AND (j.status NOT IN ('completed','cancelled','expired','failed') OR EXISTS (
          SELECT 1 FROM google_docs_batch_items retained
           WHERE retained.job_id=j.id AND retained.payload_key_id IS NOT NULL
        ))
      RETURNING j.id,j.status`, [owner ?? null],
  );
  if (due.rows.length === 0) return 0;
  await db.query(
    `UPDATE google_docs_batch_items i SET
            status=CASE
              WHEN i.status IN ('completed','cancelled') THEN i.status
              WHEN j.status='cancelling' AND i.ordinal=j.next_ordinal AND i.sent_at IS NOT NULL
                THEN CASE WHEN i.status='running' THEN 'running' ELSE 'pending' END
              ELSE 'expired'
            END,
            retryable=false,payload_key_id=NULL,payload_nonce=NULL,payload_ciphertext=NULL,payload_tag=NULL,updated_at=clock_timestamp()
       FROM google_docs_batch_jobs j
      WHERE i.job_id=j.id AND i.job_id=ANY($1::uuid[])`, [due.rows.map((row) => row.id)],
  );
  return due.rows.length;
}

export async function purgeOwnerGoogleDocsBatchData(db: Queryable, owner: OwnerId): Promise<void> {
  assertOwner(owner);
  await db.query("DELETE FROM google_docs_batch_jobs WHERE owner=$1", [owner]);
}
