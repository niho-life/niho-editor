import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { Pool as PgPool } from "pg";
import { MIGRATION_FILE_PATTERN, MIGRATIONS_TABLE, applyMigrations, defaultMigrationsDir } from "../src/migrate.ts";
import {
  addPublicationVersion,
  connectionByKeySha256,
  connectionLive,
  createPreviewToken,
  deleteExpiredPreviewTokens,
  deleteRedirect,
  findConnectionKeyBySha256,
  findPreviewToken,
  getConnectionByHandle,
  getDraftPage,
  getPublication,
  getPublicationVersion,
  latestPublicationVersion,
  listConnectionKeys,
  listDraftAssets,
  listLivePublished,
  listRedirectsTo,
  publishDestOfHandle,
  putConnection,
  putConnectionKey,
  putPublication,
  putRedirect,
  readPublishedForHandle,
  takenSlugs,
  withTransaction,
  type PublicationRow,
  type PublishedCursor,
  type SiteConnectionRow,
} from "../src/publications.ts";
import { EditorStore, InvalidPageCursorError } from "../src/store.ts";
import type { PublishRange, Queryable } from "../src/types.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID・合成の題名・合成のハッシュだけを使う（実在の人・鍵の値を入れない）
const OWNER = "synthetic-publish-owner-a";
const OTHER = "synthetic-publish-owner-b";
const T0 = "2026-10-01T09:00:00.000Z";

const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const fakeSha = (label: string): string => createHash("sha256").update(`synthetic:${label}`).digest("hex");

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

async function rejectsWith(work: () => Promise<unknown>, code: string, message?: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.equal(codeOf(error), code, message ?? `expected SQLSTATE ${code}`);
    return true;
  });
}

/** 合成の公開版（SQL が読む値だけ。契約の検証は editor-publish の側）。 */
function snapshotOf(pageId: string, version: number, handle: string, slug: string, range: PublishRange, updatedAt: string): Record<string, unknown> {
  const dest = publishDestOfHandle(handle);
  return {
    id: pageId,
    version,
    dest,
    slug,
    range,
    title: `合成の題名 v${version}`,
    updatedAt,
    canonicalUrl: `https://${handle}.example.com/${slug}`,
    blocks: [{ type: "paragraph", content: [{ type: "text", text: "合成の本文" }] }],
    markdown: "合成の本文\n",
    assets: [],
    fingerprint: "f".repeat(64),
  };
}

type PlaceOptions = { handle: string; slug: string; range?: PublishRange; at: string; publishedAt?: string };

/** PublishService と同じ順で 1 つの transaction に書く: 次の番号の公開版を足し、公開をそれに切り替える。 */
async function place(pool: PgPool, pageId: string, options: PlaceOptions): Promise<PublicationRow> {
  return withTransaction(pool, async (tx) => {
    const page = await getDraftPage(tx, pageId, { lock: true });
    assert.ok(page, "the page exists");
    const current = await getPublication(tx, pageId, { lock: true });
    const version = (await latestPublicationVersion(tx, pageId)) + 1;
    const range = options.range ?? "live";
    await addPublicationVersion(tx, { pageId, version, handle: options.handle, snapshot: snapshotOf(pageId, version, options.handle, options.slug, range, options.at) });
    const row: PublicationRow = {
      pageId,
      dest: publishDestOfHandle(options.handle)!,
      handle: options.handle,
      slug: options.slug,
      range,
      extras: { app: false, news: false, xp: false },
      category: null,
      related: [],
      version,
      publishedAt: options.publishedAt ?? current?.publishedAt ?? options.at,
      updatedAt: options.at,
      stoppedAt: null,
    };
    await putPublication(tx, row);
    return row;
  });
}

async function stop(pool: PgPool, pageId: string, when: string): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const current = await getPublication(tx, pageId, { lock: true });
    assert.ok(current);
    await putPublication(tx, { ...current, stoppedAt: when });
  });
}

function connection(handle: string, patch: Partial<SiteConnectionRow> = {}): SiteConnectionRow {
  return {
    id: randomUUID(),
    ownerId: OWNER,
    handle,
    mode: "api",
    siteUrl: "https://notes.example.net",
    urlShape: { host: "notes.example.net", path: "" },
    assetPolicy: "copy-on-import",
    pushEnabled: false,
    createdAt: T0,
    removedAt: null,
    ...patch,
  };
}

async function newPool(schema: string, options = ""): Promise<PgPool> {
  const { Pool } = await import("pg");
  return new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}${options}` });
}

describe("0009 on a database whose old publications table has rows", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_pub0009_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;
  let dir: string;

  before(async () => {
    pool = await newPool(schema);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    dir = await mkdtemp(join(tmpdir(), "editor-store-0009-"));
    for (const name of await readdir(defaultMigrationsDir)) {
      if (MIGRATION_FILE_PATTERN.test(name) && name < "0009") await copyFile(new URL(name, defaultMigrationsDir), join(dir, name));
    }
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses to recreate the table while it has rows, and recreates it once it is empty", async () => {
    const client = await pool.connect();
    try {
      await applyMigrations(client, pathToFileURL(`${dir}/`));
      const page = await client.query<{ id: string }>("INSERT INTO pages (owner, title) VALUES ($1, '旧い公開') RETURNING id", [OWNER]);
      const pageId = page.rows[0]!.id;
      await client.query("INSERT INTO page_versions (page_id, version, blocks, reason) VALUES ($1, 1, '[]', 'publish')", [pageId]);
      await client.query("INSERT INTO publications (page_id, dest, slug, range, published_version) VALUES ($1, 'synthetic', 'old', 'live', 1)", [pageId]);

      await assert.rejects(() => applyMigrations(client), /editor-store 0009: publications has rows/);
      const recorded = await client.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE} WHERE name LIKE '0009%'`);
      assert.equal(recorded.rows.length, 0, "0009 is not recorded as applied");
      assert.equal((await client.query("SELECT 1 FROM publications WHERE published_version = 1")).rows.length, 1, "the old row is kept");
      assert.equal((await client.query("SELECT to_regclass('publication_versions') AS t")).rows[0]?.t, null, "nothing of 0009 is left behind");

      await client.query("DELETE FROM publications");
      const applied = await applyMigrations(client);
      // 0009 から先の migration が、番号の順に適用される（あとから足された migration があっても、0009 が先頭）
      assert.equal(applied.applied[0], "0009_publications.sql");
      const columns = await client.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'publications' ORDER BY ordinal_position",
        [schema],
      );
      assert.ok(columns.rows.some((row) => row.column_name === "handle"));
      assert.ok(!columns.rows.some((row) => row.column_name === "published_version"));
    } finally {
      client.release();
    }
  });
});

describe("0010 on a database that already has preview tokens", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_pub0010_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;
  let dir: string;

  before(async () => {
    pool = await newPool(schema);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    dir = await mkdtemp(join(tmpdir(), "editor-store-0010-"));
    for (const name of await readdir(defaultMigrationsDir)) {
      if (MIGRATION_FILE_PATTERN.test(name) && name < "0010") await copyFile(new URL(name, defaultMigrationsDir), join(dir, name));
    }
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the tokens issued before it, without an author", async () => {
    const client = await pool.connect();
    try {
      await applyMigrations(client, pathToFileURL(`${dir}/`));
      const page = await client.query<{ id: string }>("INSERT INTO pages (owner, title) VALUES ($1, '合成のページ') RETURNING id", [OWNER]);
      const pageId = page.rows[0]!.id;
      await client.query(
        "INSERT INTO preview_tokens (sha256, page_id, owner, handle, issued_at, expires_at) VALUES ($1, $2, $3, 'exp', $4, $5)",
        [fakeSha("pv-before-0010"), pageId, OWNER, at(0), at(10)],
      );
      const applied = await applyMigrations(client);
      // 0010 から先の migration が、番号の順に適用される（あとから足された migration があっても、0010 が先頭）
      assert.equal(applied.applied[0], "0010_preview_token_author.sql");
      assert.deepEqual(await findPreviewToken(client, fakeSha("pv-before-0010"), at(1)), {
        sha256: fakeSha("pv-before-0010"),
        pageId,
        ownerId: OWNER,
        handle: "exp",
        issuedAt: at(0),
        expiresAt: at(10),
        author: null,
      });
    } finally {
      client.release();
    }
  });
});

describe("PostgreSQL publications (0009)", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_pub_${randomUUID().replaceAll("-", "")}`;
  const pools: PgPool[] = [];
  let pool: PgPool;
  let store: EditorStore;

  async function makePage(owner = OWNER, title = "合成のページ"): Promise<string> {
    return (await store.createPage(owner, { title, lang: "en", blocks: [{ type: "paragraph", content: [{ type: "text", text: "合成" }] }] })).id;
  }

  before(async () => {
    pool = await newPool(schema);
    pools.push(pool);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
    store = new EditorStore(pool);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    for (const created of pools) await created.end();
  });

  describe("drafts", () => {
    it("reads the page as the publish ports need it and its assets, and nothing from the trash", async () => {
      const pageId = await makePage();
      const asset = await pool.query<{ id: string }>(
        `INSERT INTO assets (owner, page_id, kind, bucket_path, bytes, sha256, content_type, alt, credit, consent)
         VALUES ($1, $2, 'image', $3, 120000, $4, 'image/jpeg', '合成の写真', null, true) RETURNING id`,
        [OWNER, pageId, `synthetic/${pageId}.jpg`, fakeSha("photo")],
      );
      const assetId = asset.rows[0]!.id;
      await pool.query("UPDATE pages SET lead = '合成のリード', cover = $2 WHERE id = $1", [pageId, assetId]);

      const page = await getDraftPage(pool, pageId);
      const saved = await pool.query<{ revision: number; updated_at: Date }>("SELECT revision, updated_at FROM pages WHERE id = $1", [pageId]);
      assert.deepEqual(page, {
        id: pageId,
        ownerId: OWNER,
        title: "合成のページ",
        lang: "en",
        lead: "合成のリード",
        coverAssetId: assetId,
        content: [{ type: "paragraph", content: [{ type: "text", text: "合成" }] }],
        kind: "note",
        revision: saved.rows[0]!.revision,
        savedAt: saved.rows[0]!.updated_at.toISOString(),
      });
      assert.deepEqual(await listDraftAssets(pool, pageId), [
        { id: assetId, kind: "image", bytes: 120000, sha256: fakeSha("photo"), contentType: "image/jpeg", alt: "合成の写真", credit: null, consent: true },
      ]);
      assert.equal(await getDraftPage(pool, "not-a-uuid"), null);
      assert.deepEqual(await listDraftAssets(pool, "not-a-uuid"), []);

      const trashed = await makePage();
      assert.equal(await store.deletePage(OWNER, trashed), "deleted");
      assert.equal(await getDraftPage(pool, trashed), null);
    });
  });

  describe("constraints", () => {
    it("gives one URL (handle and slug) to one page, live or stopped", async () => {
      const first = await makePage();
      const second = await makePage();
      await place(pool, first, { handle: "niho", slug: "shared-slug", at: at(1) });
      await rejectsWith(() => place(pool, second, { handle: "niho", slug: "shared-slug", at: at(2) }), "23505");
      await stop(pool, first, at(3));
      await rejectsWith(() => place(pool, second, { handle: "niho", slug: "shared-slug", at: at(4) }), "23505", "a stopped publication keeps its slug");
      // 別の handle なら同じ slug でよい。失敗した transaction は何も残さない
      await place(pool, second, { handle: "exp", slug: "shared-slug", at: at(5) });
      assert.equal(await latestPublicationVersion(pool, second), 1);
    });

    it("keeps published versions immutable and consistent with their row", async () => {
      const pageId = await makePage();
      await place(pool, pageId, { handle: "niho", slug: `immutable-${pageId.slice(0, 8)}`, at: at(1) });
      await rejectsWith(() => pool.query("UPDATE publication_versions SET snapshot = snapshot WHERE page_id = $1", [pageId]), "23001");
      await rejectsWith(() => pool.query("DELETE FROM publication_versions WHERE page_id = $1", [pageId]), "23001");
      await rejectsWith(
        () => addPublicationVersion(pool, { pageId, version: 1, handle: "niho", snapshot: snapshotOf(pageId, 1, "niho", "x", "live", at(2)) }),
        "23505",
        "a version number is never reused",
      );
      // スナップショットは行のページ・番号・発信先のもの
      await rejectsWith(() => addPublicationVersion(pool, { pageId, version: 2, handle: "niho", snapshot: snapshotOf(randomUUID(), 2, "niho", "x", "live", at(2)) }), "23514");
      await rejectsWith(() => addPublicationVersion(pool, { pageId, version: 2, handle: "niho", snapshot: snapshotOf(pageId, 3, "niho", "x", "live", at(2)) }), "23514");
      await rejectsWith(() => addPublicationVersion(pool, { pageId, version: 2, handle: "niho", snapshot: snapshotOf(pageId, 2, "exp", "x", "live", at(2)) }), "23514");
      await rejectsWith(() => addPublicationVersion(pool, { pageId, version: 2, handle: "admin", snapshot: snapshotOf(pageId, 2, "admin", "x", "live", at(2)) }), "23514");

      // 公開はいつも自分の handle の版を指す
      const current = await getPublication(pool, pageId);
      assert.ok(current);
      await rejectsWith(() => putPublication(pool, { ...current, dest: "exp", handle: "exp" }), "23503");
      await rejectsWith(() => putPublication(pool, { ...current, version: 9 }), "23503");
      // 公開のある（やめたものも含む）ページは完全に消せない。公開版も残る
      await stop(pool, pageId, at(3));
      await rejectsWith(() => pool.query("DELETE FROM pages WHERE id = $1", [pageId]), "23503");
      assert.ok(await getPublicationVersion(pool, pageId, 1));
    });

    it("lets a page that has no publication row be deleted, its versions going with it", async () => {
      const pageId = await makePage();
      await addPublicationVersion(pool, { pageId, version: 1, handle: "niho", snapshot: snapshotOf(pageId, 1, "niho", "orphan", "live", at(1)) });
      await pool.query("DELETE FROM pages WHERE id = $1", [pageId]);
      assert.equal(await getPublicationVersion(pool, pageId, 1), null);
    });

    it("checks the shapes of the contract (slug, handle, range per destination, hex hashes)", async () => {
      const pageId = await makePage();
      for (const slug of ["Upper", "two--dashes", "-lead", "trail-", "with space", "x".repeat(161), ""]) {
        await rejectsWith(() => place(pool, pageId, { handle: "niho", slug, at: at(1) }), "23514", slug);
      }
      // 限定公開は NIHO の面だけ
      await putConnection(pool, connection("range-notes"));
      await rejectsWith(() => place(pool, pageId, { handle: "range-notes", slug: "unlisted-site", range: "unlisted", at: at(1) }), "23514");
      for (const handle of ["admin", "preview", "ab", "Upper-case", "-dash", `${"a".repeat(33)}`]) {
        await rejectsWith(() => putConnection(pool, connection(handle)), "23514", handle);
      }
      await rejectsWith(() => putConnection(pool, connection("bad-url", { siteUrl: "http://notes.example.net" })), "23514");
      await rejectsWith(() => putConnection(pool, connection("bad-host", { urlShape: { host: "localhost", path: "" } })), "23514");
      await rejectsWith(() => putConnection(pool, connection("bad-path", { urlShape: { host: "notes.example.net", path: "a/b" } })), "23514");
      await rejectsWith(() => putConnection(pool, connection("push-on", { pushEnabled: true as false })), "23514");
      const site = connection("hash-shapes");
      await putConnection(pool, site);
      for (const sha256 of ["A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
        await rejectsWith(() => putConnectionKey(pool, { id: randomUUID(), connectionId: site.id, sha256, last4: "abcd", createdAt: T0, revokedAt: null }), "23514", sha256);
      }
      await rejectsWith(() => putConnectionKey(pool, { id: randomUUID(), connectionId: site.id, sha256: fakeSha("last4"), last4: "ab c", createdAt: T0, revokedAt: null }), "23514");
    });

    it("never gives a handle to another connection, removed ones included, and never forgets a connection", async () => {
      const original = connection("kept-notes");
      await putConnection(pool, original);
      await rejectsWith(() => putConnection(pool, connection("kept-notes", { ownerId: OTHER })), "23505");
      await putConnection(pool, { ...original, removedAt: at(5) });
      await rejectsWith(() => putConnection(pool, connection("kept-notes", { ownerId: OTHER })), "23505", "a removed connection keeps its handle");
      await rejectsWith(() => putConnection(pool, { ...original, handle: "renamed-notes", removedAt: at(5) }), "23001");
      await rejectsWith(() => putConnection(pool, { ...original, ownerId: OTHER, removedAt: at(5) }), "23001");
      await rejectsWith(() => putConnection(pool, { ...original, removedAt: null }), "23001", "a removal cannot be undone");
      await rejectsWith(() => pool.query("DELETE FROM site_connections WHERE id = $1", [original.id]), "23001");
      assert.equal((await getConnectionByHandle(pool, "kept-notes"))?.removedAt, at(5));
    });

    it("keeps key hashes unique and revocations final", async () => {
      const site = connection("key-notes");
      await putConnection(pool, site);
      const key = { id: randomUUID(), connectionId: site.id, sha256: fakeSha("key-1"), last4: "Ab-_", createdAt: T0, revokedAt: null };
      await putConnectionKey(pool, key);
      await rejectsWith(() => putConnectionKey(pool, { ...key, id: randomUUID() }), "23505");
      await putConnectionKey(pool, { ...key, revokedAt: at(1) });
      await rejectsWith(() => putConnectionKey(pool, { ...key, revokedAt: null }), "23001");
      await rejectsWith(() => putConnectionKey(pool, { ...key, sha256: fakeSha("key-2"), revokedAt: at(1) }), "23001");
      assert.deepEqual(await listConnectionKeys(pool, site.id), [{ ...key, revokedAt: at(1) }]);
      assert.deepEqual(await findConnectionKeyBySha256(pool, key.sha256), { ...key, revokedAt: at(1) });
      assert.equal(await findConnectionKeyBySha256(pool, "not-a-hash"), null);
    });

    it("lets a preview token live at most 15 minutes after it is issued", async () => {
      const pageId = await makePage();
      const issuedAt = at(0);
      const row = { sha256: fakeSha("pv-limit"), pageId, ownerId: OWNER, handle: "niho", issuedAt, expiresAt: at(15), author: null };
      assert.deepEqual(await createPreviewToken(pool, row), row);
      await rejectsWith(() => createPreviewToken(pool, { ...row, sha256: fakeSha("pv-16"), expiresAt: new Date(Date.parse(at(15)) + 1).toISOString() }), "23514");
      await rejectsWith(() => createPreviewToken(pool, { ...row, sha256: fakeSha("pv-past"), expiresAt: issuedAt }), "23514");
      await rejectsWith(() => createPreviewToken(pool, row), "23505");
      await assert.rejects(() => createPreviewToken(pool, { ...row, sha256: "plaintext-is-not-a-hash" }), TypeError);
      await assert.rejects(() => createPreviewToken(pool, { ...row, sha256: fakeSha("pv-handle"), handle: "admin" }), TypeError);
    });

    it("binds the issuer's author to a preview token, and refuses an author without a name or with a non-https url (0009)", async () => {
      const pageId = await makePage();
      const row = {
        sha256: fakeSha("pv-author"),
        pageId,
        ownerId: OWNER,
        handle: "exp",
        issuedAt: at(0),
        // 期限切れの掃除の試験（at(10) で掃く）に数えられないよう、15 分の上限いっぱい
        expiresAt: at(15),
        author: { name: "Example Writer", handle: "example-writer", url: "https://writer.example.com/" },
      };
      assert.deepEqual(await createPreviewToken(pool, row), row);
      assert.deepEqual(await findPreviewToken(pool, row.sha256, at(1)), row);
      const nameOnly = { ...row, sha256: fakeSha("pv-name-only"), author: { name: "Example Writer", handle: null, url: null } };
      assert.deepEqual(await createPreviewToken(pool, nameOnly), nameOnly);
      for (const [label, author] of [
        ["blank name", { name: "  ", handle: null, url: null }],
        ["long name", { name: "a".repeat(257), handle: null, url: null }],
        ["blank handle", { name: "Example Writer", handle: "", url: null }],
        ["http url", { name: "Example Writer", handle: null, url: "http://writer.example.com/" }],
      ] as const) {
        await rejectsWith(() => createPreviewToken(pool, { ...row, sha256: fakeSha(`pv-${label}`), author }), "23514");
      }
      // 名前の無い著者は置けない（handle・url だけの行は CHECK で断る）
      await rejectsWith(
        () => pool.query("UPDATE preview_tokens SET author_name = NULL WHERE sha256 = $1", [row.sha256]),
        "23514",
      );
    });
  });

  describe("slugs and redirects", () => {
    it("lists the slugs other pages hold under a base, live, stopped or left behind by a redirect", async () => {
      const mine = await makePage();
      const a = await makePage();
      const b = await makePage();
      const c = await makePage();
      await place(pool, a, { handle: "niho", slug: "walk", at: at(1) });
      await place(pool, b, { handle: "niho", slug: "walk-2", at: at(1) });
      await stop(pool, b, at(2));
      await place(pool, c, { handle: "niho", slug: "walk-again", at: at(1) });
      await putRedirect(pool, { from: { handle: "niho", slug: "walk-10" }, to: "list", pageId: c, createdAt: at(3) });
      await place(pool, mine, { handle: "niho", slug: "walk-3", at: at(1) });
      assert.deepEqual(await takenSlugs(pool, "niho", "walk", mine), ["walk", "walk-10", "walk-2"]);
      assert.deepEqual(await takenSlugs(pool, "niho", "walk", a), ["walk-10", "walk-2", "walk-3"]);
      assert.deepEqual(await takenSlugs(pool, "exp", "walk", mine), []);
      assert.deepEqual(await takenSlugs(pool, "niho", "walk-2", mine), ["walk-2"]);
    });

    it("replaces a redirect by its from, lists the ones that point at a place, and deletes them", async () => {
      const pageId = await makePage();
      const from = { handle: "exp", slug: `old-${pageId.slice(0, 8)}` };
      const to = { handle: "niho", slug: `new-${pageId.slice(0, 8)}` };
      await putRedirect(pool, { from, to, pageId, createdAt: at(1) });
      assert.deepEqual(await listRedirectsTo(pool, to), [{ from, to, pageId, createdAt: at(1) }]);
      await putRedirect(pool, { from, to: "list", pageId, createdAt: at(2) });
      assert.deepEqual(await listRedirectsTo(pool, to), []);
      await rejectsWith(() => putRedirect(pool, { from: { handle: "site-notes", slug: "x" }, to: "list", pageId, createdAt: at(2) }), "23514", "sites get no redirects");
      await rejectsWith(() => putRedirect(pool, { from, to: from, pageId, createdAt: at(2) }), "23514", "no redirect to itself");
      await deleteRedirect(pool, from);
      await deleteRedirect(pool, from);
      assert.equal((await pool.query("SELECT 1 FROM publication_redirects WHERE from_slug = $1", [from.slug])).rows.length, 0);
    });
  });

  describe("public API v1 reads", () => {
    it("lists live publications newest first, ties by page id, through a microsecond-exact cursor", async () => {
      const handle = "list-notes";
      await putConnection(pool, connection(handle));
      const ids: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        const pageId = await makePage(OWNER, `list ${index}`);
        ids.push(pageId);
        await place(pool, pageId, { handle, slug: `list-${index}`, at: at(10 + index) });
      }
      // 4 行を同じ時刻（マイクロ秒まで）、1 行をその 1 µs 後にする（JavaScript の Date では見分けられない）
      await pool.query("UPDATE publications SET updated_at = timestamptz '2030-01-02 03:04:05.123456+00' WHERE page_id = ANY($1::uuid[])", [ids.slice(0, 4)]);
      await pool.query("UPDATE publications SET updated_at = timestamptz '2030-01-02 03:04:05.123457+00' WHERE page_id = $1", [ids[4]]);
      // 公開をやめたもの・別の handle のものは載らない
      await stop(pool, ids[6]!, at(30));
      const elsewhere = await makePage();
      await place(pool, elsewhere, { handle: "niho", slug: `elsewhere-${elsewhere.slice(0, 8)}`, at: at(40) });

      const expected = await pool.query<{ page_id: string }>(
        "SELECT page_id FROM publications WHERE handle = $1 AND stopped_at IS NULL ORDER BY updated_at DESC, page_id",
        [handle],
      );
      const seen: string[] = [];
      let after: PublishedCursor | null = null;
      let chunks = 0;
      do {
        const chunk = await listLivePublished(pool, handle, { limit: 2, after });
        assert.ok(chunk.items.length <= 2);
        for (const item of chunk.items) {
          seen.push(item.publication.pageId);
          assert.equal(item.publication.handle, handle);
          const listing = item.listing as Record<string, unknown>;
          assert.equal(listing.id, item.publication.pageId);
          assert.equal(listing.version, item.publication.version);
          for (const body of ["blocks", "markdown", "assets"]) assert.ok(!(body in listing), `${body} is not part of a list item`);
          assert.match(item.cursor.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
        }
        after = chunk.next;
        chunks += 1;
        assert.ok(chunks < 10, "the cursor must advance");
      } while (after !== null);
      assert.equal(chunks, 3);
      assert.deepEqual(seen, expected.rows.map((row) => row.page_id));
      assert.equal(seen.length, 6);
      assert.equal(seen[0], ids[4], "the row 1 µs later comes first");
      assert.deepEqual(seen.slice(1, 5), [...ids.slice(0, 4)].sort(), "ties are in page id order");

      const all = await listLivePublished(pool, handle);
      assert.equal(all.next, null);
      assert.equal(all.items.length, 6);
      assert.deepEqual(await listLivePublished(pool, "admin"), { items: [], next: null });
    });

    it("lists unlisted publications only when asked", async () => {
      const live = await makePage();
      const unlisted = await makePage();
      await place(pool, live, { handle: "exp", slug: `live-${live.slice(0, 8)}`, at: at(50) });
      await place(pool, unlisted, { handle: "exp", slug: `unlisted-${unlisted.slice(0, 8)}`, range: "unlisted", at: at(51) });
      const plain = (await listLivePublished(pool, "exp")).items.map((item) => item.publication.pageId);
      assert.ok(plain.includes(live) && !plain.includes(unlisted));
      const included = (await listLivePublished(pool, "exp", { includeUnlisted: true })).items.map((item) => item.publication.pageId);
      assert.ok(included.includes(live) && included.includes(unlisted));
    });

    it("rejects cursors that are not exactly what the list returned", async () => {
      const id = randomUUID();
      for (const updatedAt of ["", "2030-01-02T03:04:05.123Z", "2030-01-02 03:04:05.123456Z", "2030-02-30T03:04:05.123456Z", "2030-13-01T03:04:05.123456Z"]) {
        await assert.rejects(() => listLivePublished(pool, "niho", { after: { updatedAt, pageId: id } }), InvalidPageCursorError, updatedAt);
      }
      await assert.rejects(() => listLivePublished(pool, "niho", { after: { updatedAt: "2030-01-02T03:04:05.123456Z", pageId: "x' OR '1'='1" } }), InvalidPageCursorError);
      assert.deepEqual(await listLivePublished(pool, "niho", { after: { updatedAt: "1970-01-01T00:00:00.000000Z", pageId: id } }), { items: [], next: null });
    });

    it("reads one publication per handle: live, stopped, moved face to face, moved to a site, never published there", async () => {
      await putConnection(pool, connection("moved-notes"));
      const pageId = await makePage();
      const slug = `moving-${pageId.slice(0, 8)}`;
      assert.equal(await readPublishedForHandle(pool, "niho", pageId), null, "never published");

      await place(pool, pageId, { handle: "niho", slug, at: at(1) });
      const live = await readPublishedForHandle(pool, "niho", pageId);
      assert.equal(live?.status, "live");
      assert.equal(live?.status === "live" && (live.snapshot as { version: number }).version, 1);
      assert.equal(await readPublishedForHandle(pool, "exp", pageId), null, "another handle");

      // 面から面へ: 旧い handle は「離れた」で、転送の先で公開中なら movedTo
      await place(pool, pageId, { handle: "exp", slug, at: at(2) });
      await putRedirect(pool, { from: { handle: "niho", slug }, to: { handle: "exp", slug }, pageId, createdAt: at(2) });
      assert.deepEqual(await readPublishedForHandle(pool, "niho", pageId), {
        status: "left",
        pageId,
        handle: "niho",
        dest: "niho",
        slug,
        range: "live",
        version: 1,
        stoppedAt: at(2),
        movedTo: { handle: "exp", dest: "exp", canonicalUrl: `https://exp.example.com/${slug}` },
      });
      assert.equal((await readPublishedForHandle(pool, "exp", pageId))?.status, "live");

      // 移動先でやめると movedTo は付かない（移動先の場所も一覧へ）
      await stop(pool, pageId, at(3));
      const stopped = await readPublishedForHandle(pool, "exp", pageId);
      assert.deepEqual(stopped, { status: "left", pageId, handle: "exp", dest: "exp", slug, range: "live", version: 2, stoppedAt: at(3), movedTo: null });
      const niho = await readPublishedForHandle(pool, "niho", pageId);
      assert.equal(niho?.status, "left");
      assert.equal(niho?.status === "left" ? niho.movedTo : "live", null);

      // 面から本人のサイトへ: 旧い面は「離れた」、転送は一覧なので movedTo なし
      const other = await makePage();
      const otherSlug = `to-site-${other.slice(0, 8)}`;
      await place(pool, other, { handle: "exp", slug: otherSlug, range: "unlisted", at: at(4) });
      await place(pool, other, { handle: "moved-notes", slug: otherSlug, at: at(5) });
      await putRedirect(pool, { from: { handle: "exp", slug: otherSlug }, to: "list", pageId: other, createdAt: at(5) });
      assert.deepEqual(await readPublishedForHandle(pool, "exp", other), {
        status: "left",
        pageId: other,
        handle: "exp",
        dest: "exp",
        slug: otherSlug,
        range: "unlisted",
        version: 1,
        stoppedAt: at(5),
        movedTo: null,
      });
      assert.equal((await readPublishedForHandle(pool, "moved-notes", other))?.status, "live");
      assert.equal(await readPublishedForHandle(pool, "admin", other), null);
      assert.equal(await readPublishedForHandle(pool, "exp", "not-a-uuid"), null);
    });

    it("authenticates a key hash only while the key is active and its connection is not removed", async () => {
      const site = connection("auth-notes");
      await putConnection(pool, site);
      const active = { id: randomUUID(), connectionId: site.id, sha256: fakeSha("auth-1"), last4: "wxyz", createdAt: T0, revokedAt: null };
      const revoked = { id: randomUUID(), connectionId: site.id, sha256: fakeSha("auth-2"), last4: "abcd", createdAt: T0, revokedAt: at(1) };
      await putConnectionKey(pool, active);
      await putConnectionKey(pool, revoked);
      assert.deepEqual(await connectionByKeySha256(pool, active.sha256), { connectionId: site.id, handle: "auth-notes" });
      assert.equal(await connectionByKeySha256(pool, revoked.sha256), null);
      assert.equal(await connectionByKeySha256(pool, fakeSha("unknown")), null);
      assert.equal(await connectionByKeySha256(pool, "ek_plaintext-is-never-looked-up"), null);
      await putConnection(pool, { ...site, removedAt: at(2) });
      assert.equal(await connectionByKeySha256(pool, active.sha256), null, "a removed connection");
    });

    it("finds preview tokens only for the owner's page, before they expire, and sweeps expired ones", async () => {
      const pageId = await makePage();
      const row = { sha256: fakeSha("pv-1"), pageId, ownerId: OWNER, handle: "exp", issuedAt: at(0), expiresAt: at(10), author: null };
      assert.deepEqual(await createPreviewToken(pool, row), row);
      assert.equal(await createPreviewToken(pool, { ...row, sha256: fakeSha("pv-other"), ownerId: OTHER }), null, "another owner's page");
      assert.equal(await createPreviewToken(pool, { ...row, sha256: fakeSha("pv-missing"), pageId: randomUUID() }), null);

      assert.deepEqual(await findPreviewToken(pool, row.sha256, at(9)), row);
      assert.equal(await findPreviewToken(pool, row.sha256, at(10)), null, "expired at expiresAt");
      assert.equal(await findPreviewToken(pool, row.sha256), null, "the database clock is long past 2026-10-01");
      assert.equal(await findPreviewToken(pool, "pv_plaintext-is-never-looked-up", at(1)), null);

      const trashed = await makePage();
      const onTrashed = { ...row, sha256: fakeSha("pv-trashed"), pageId: trashed };
      await createPreviewToken(pool, onTrashed);
      assert.equal(await store.deletePage(OWNER, trashed), "deleted");
      assert.equal(await findPreviewToken(pool, onTrashed.sha256, at(1)), null, "a page in the trash");
      assert.equal(await createPreviewToken(pool, { ...onTrashed, sha256: fakeSha("pv-trashed-2") }), null);

      assert.equal(await deleteExpiredPreviewTokens(pool, at(9)), 0);
      assert.equal(await deleteExpiredPreviewTokens(pool, at(10)), 2);
      assert.equal((await pool.query("SELECT 1 FROM preview_tokens WHERE sha256 = ANY($1::text[])", [[row.sha256, onTrashed.sha256]])).rows.length, 0);
    });
  });

  describe("locks", () => {
    it("holds the connection row while a publish checks it, so a removal waits", async () => {
      const site = connection("locked-notes");
      await putConnection(pool, site);
      const impatient = await newPool(schema, " -c lock_timeout=200");
      pools.push(impatient);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        assert.equal(await connectionLive(client, OWNER, "locked-notes"), true);
        assert.equal(await connectionLive(client, OTHER, "locked-notes"), false);
        await rejectsWith(() => putConnection(impatient, { ...site, removedAt: at(1) }), "55P03");
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      await putConnection(impatient, { ...site, removedAt: at(1) });
      assert.equal(await connectionLive(pool, OWNER, "locked-notes"), false);
      assert.equal(await connectionLive(pool, OWNER, "no-such-notes"), false);
    });

    it("holds the page row while publishing, so the trash waits for it", async () => {
      const pageId = await makePage();
      const impatient = await newPool(schema, " -c lock_timeout=200");
      pools.push(impatient);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        assert.ok(await getDraftPage(client, pageId, { lock: true }));
        await rejectsWith(() => new EditorStore(impatient).deletePage(OWNER, pageId), "55P03");
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });
  });

  describe("the editor store with publications", () => {
    it("refuses to trash a live page and to purge a page that has a publication, stopped or not", async () => {
      const pageId = await makePage(OWNER, "公開中");
      await place(pool, pageId, { handle: "niho", slug: `trash-${pageId.slice(0, 8)}`, at: at(1) });
      assert.equal(await store.deletePage(OWNER, pageId), "published");
      await stop(pool, pageId, at(2));
      assert.equal(await store.deletePage(OWNER, pageId), "deleted");
      await pool.query(
        `UPDATE pages
            SET created_at = created_at - interval '41 days', updated_at = updated_at - interval '41 days', deleted_at = deleted_at - interval '40 days'
          WHERE id = $1`,
        [pageId],
      );
      await store.purgeTrash();
      assert.equal((await pool.query("SELECT 1 FROM pages WHERE id = $1", [pageId])).rows.length, 1, "the page with a publication stays");
      assert.ok(await getPublicationVersion(pool, pageId, 1));
    });

    it("shows the publication on the second line of the list", async () => {
      const owner = "synthetic-publish-owner-list";
      const privatePage = await makePage(owner, "自分だけ");
      const live = await makePage(owner, "公開中");
      const stopped = await makePage(owner, "やめた");
      await putConnection(pool, connection("second-line", { ownerId: owner }));
      await place(pool, live, { handle: "second-line", slug: "live", at: at(1) });
      await place(pool, stopped, { handle: "exp", slug: `stopped-${stopped.slice(0, 8)}`, range: "unlisted", at: at(1) });
      await stop(pool, stopped, at(2));
      const chunk = await store.listPageChunk(owner, { limit: 10 });
      const byId = new Map(chunk.pages.map((page) => [page.id, page.publication] as const));
      assert.equal(byId.get(privatePage), null);
      assert.deepEqual(byId.get(live), { dest: "site", handle: "second-line", range: "live", stopped: false });
      assert.deepEqual(byId.get(stopped), { dest: "exp", handle: "exp", range: "unlisted", stopped: true });
      const listed = await store.listPages(owner);
      assert.deepEqual(listed.find((page) => page.id === live)?.publication, { dest: "site", handle: "second-line", range: "live", stopped: false });
    });
  });

  describe("transactions", () => {
    it("rolls everything back when the work throws, and commits when it returns", async () => {
      const pageId = await makePage();
      await assert.rejects(
        () =>
          withTransaction(pool, async (tx: Queryable) => {
            await addPublicationVersion(tx, { pageId, version: 1, handle: "niho", snapshot: snapshotOf(pageId, 1, "niho", "rolled", "live", at(1)) });
            throw new Error("synthetic failure");
          }),
        /synthetic failure/,
      );
      assert.equal(await latestPublicationVersion(pool, pageId), 0);
      assert.equal(await withTransaction(pool, async (tx) => latestPublicationVersion(tx, pageId)), 0);
    });
  });
});
