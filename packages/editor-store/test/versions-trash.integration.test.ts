import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations } from "../src/migrate.ts";
import { EditorStore, VERSION_KEEP_LIMIT } from "../src/store.ts";
import type { Block, Page, RestoreResult, SaveResult } from "../src/types.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID だけを使う（実在の人の値を入れない）
const OWNER = "synthetic-owner-a";
const OTHER = "synthetic-owner-b";
const MINUTE = 60_000;

const paragraph = (text: string): Block => ({ type: "paragraph", content: [{ type: "text", text }] });
const acceptAll = (blocks: unknown) => blocks as Block[];

/** 公開の行を store を通さずに入れる（0009 の形: NIHO への公開版 1 と、それを指す公開）。 */
async function insertPublication(db: Pick<PgPool, "query">, pageId: string, slug: string, options: { stopped?: boolean } = {}): Promise<void> {
  await db.query(
    "INSERT INTO publication_versions (page_id, version, handle, snapshot) VALUES ($1, 1, 'niho', jsonb_build_object('id', $2::text, 'version', 1, 'dest', 'niho'))",
    [pageId, pageId],
  );
  await db.query(
    `INSERT INTO publications (page_id, dest, handle, slug, range, extras_app, extras_news, extras_xp, version, published_at, updated_at, stopped_at)
     VALUES ($1, 'niho', 'niho', $2, 'live', false, false, false, 1, clock_timestamp(), clock_timestamp(),
             CASE WHEN $3::boolean THEN clock_timestamp() END)`,
    [pageId, slug, options.stopped === true],
  );
}

function expectSaved(result: SaveResult | RestoreResult | null): Page {
  assert.ok(result !== null && (result.status === "saved" || result.status === "restored"), `expected a write, got ${result === null ? "null" : result.status}`);
  return result.page;
}

function expectConflict(result: SaveResult | RestoreResult | null): Page {
  assert.ok(result !== null && result.status === "conflict", `expected a conflict, got ${result === null ? "null" : result.status}`);
  return result.page;
}

describe("PostgreSQL editor store: revisions, versions and trash", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_test_${randomUUID().replaceAll("-", "")}`;
  const pools: PgPool[] = [];
  let pool: PgPool;

  async function newPool(max = 4): Promise<PgPool> {
    const { Pool } = await import("pg");
    const created = new Pool({ connectionString: databaseUrl, max, options: `-c search_path=${schema}` });
    pools.push(created);
    return created;
  }

  /** 版を数と中身で読む（store を通さずに DB の行を見る）。 */
  async function versionsOf(pageId: string) {
    const result = await pool.query<{ version: number; reason: string; blocks: Block[] }>(
      "SELECT version, reason, blocks FROM page_versions WHERE page_id = $1 ORDER BY version",
      [pageId],
    );
    return result.rows;
  }

  async function rowOf(pageId: string) {
    const result = await pool.query<{ title: string; blocks: Block[]; revision: number; deleted_at: Date | null; parent: string | null }>(
      "SELECT title, blocks, revision, deleted_at, parent FROM pages WHERE id = $1",
      [pageId],
    );
    return result.rows[0];
  }

  /** 最新の版を間隔より前に作られたことにする（sleep しない）。 */
  async function ageVersions(pageId: string, minutes: number) {
    await pool.query("UPDATE page_versions SET created_at = created_at - make_interval(mins => $2) WHERE page_id = $1", [pageId, minutes]);
  }

  before(async () => {
    pool = await newPool();
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    for (const created of pools) await created.end();
  });

  describe("optimistic locking", () => {
    it("bumps the revision on every save and refuses a stale baseRevision without writing anything", async () => {
      const store = new EditorStore(pool, { autosaveVersionIntervalMs: 0 });
      const page = await store.createPage(OWNER, { title: "t", blocks: [paragraph("一")] });
      assert.equal(page.revision, 1);
      const first = expectSaved(await store.savePage(OWNER, page.id, { title: "t2" }, { baseRevision: 1 }));
      assert.equal(first.revision, 2);
      const second = expectSaved(await store.savePage(OWNER, page.id, { blocks: [paragraph("二")] }, { baseRevision: 2 }));
      assert.equal(second.revision, 3);
      const before = await versionsOf(page.id);

      const stale = expectConflict(await store.savePage(OWNER, page.id, { title: "stale", blocks: [paragraph("古い端末")] }, { baseRevision: 2 }));
      assert.equal(stale.revision, 3, "the conflict carries the current page");
      assert.equal(stale.title, "t2");
      assert.deepEqual(stale.blocks, [paragraph("二")]);
      assert.equal(stale.updatedAt, second.updatedAt);

      const row = await rowOf(page.id);
      assert.equal(row?.revision, 3);
      assert.equal(row?.title, "t2");
      assert.deepEqual(row?.blocks, [paragraph("二")]);
      assert.deepEqual(await versionsOf(page.id), before, "a conflict writes no version");
      // 先の番号（まだ無い revision）も競合
      expectConflict(await store.savePage(OWNER, page.id, { title: "future" }, { baseRevision: 4 }));
    });

    it("lets exactly one of two concurrent saves with the same baseRevision win, on separate connections", async () => {
      const storeA = new EditorStore(await newPool(2), { autosaveVersionIntervalMs: 0 });
      const storeB = new EditorStore(await newPool(2), { autosaveVersionIntervalMs: 0 });
      for (let round = 0; round < 5; round++) {
        const page = await storeA.createPage(OWNER, { blocks: [paragraph("元")] });
        const results = await Promise.all([
          storeA.savePage(OWNER, page.id, { title: "A", blocks: [paragraph("A の本文")] }, { baseRevision: 1 }),
          storeB.savePage(OWNER, page.id, { title: "B", blocks: [paragraph("B の本文")] }, { baseRevision: 1 }),
        ]);
        const saved = results.filter((result) => result?.status === "saved");
        const conflicts = results.filter((result) => result?.status === "conflict");
        assert.equal(saved.length, 1, `round ${round}: one save wins`);
        assert.equal(conflicts.length, 1, `round ${round}: the other is a conflict`);
        const winner = saved[0]!.page;
        const loser = conflicts[0]!.page;
        assert.equal(winner.revision, 2);
        assert.deepEqual(loser, winner, "the loser sees the winner's page");
        const row = await rowOf(page.id);
        assert.equal(row?.revision, 2);
        assert.equal(row?.title, winner.title);
        assert.deepEqual(row?.blocks, winner.blocks);
        // 版は勝った保存の前の本文 1 つだけ（負けた保存は版も書かない）
        assert.deepEqual((await versionsOf(page.id)).map((version) => [version.version, version.reason, version.blocks]), [[1, "autosave", [paragraph("元")]]]);
      }
    });

    it("waits for a save in progress on the row lock, then reports the conflict instead of overwriting it", async () => {
      const store = new EditorStore(await newPool(2));
      const page = await store.createPage(OWNER, { blocks: [paragraph("元")] });
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM pages WHERE id = $1 FOR UPDATE", [page.id]);
        const pending = store.savePage(OWNER, page.id, { title: "待った保存" }, { baseRevision: 1 });
        // 保存が行の lock を待っているのを確かめる（有限回）
        let waiting = false;
        for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
          const result = await pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'",
          );
          waiting = (result.rows[0]?.n ?? 0) > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(waiting, "the save waits for the row lock");
        await holder.query("UPDATE pages SET revision = revision + 1, title = '先の保存' WHERE id = $1", [page.id]);
        await holder.query("COMMIT");
        const latest = expectConflict(await pending);
        assert.equal(latest.title, "先の保存");
        assert.equal(latest.revision, 2);
        assert.equal((await rowOf(page.id))?.title, "先の保存");
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }
    });

    it("hides another owner's page as missing (null) even when the baseRevision would conflict", async () => {
      const store = new EditorStore(pool);
      const theirs = await store.createPage(OTHER, { title: "theirs" });
      assert.equal(await store.savePage(OWNER, theirs.id, { title: "x" }, { baseRevision: 7 }), null);
      assert.equal(await store.savePage(OWNER, theirs.id, { title: "x" }, { baseRevision: 1 }), null);
      assert.equal(await store.restoreVersion(OWNER, theirs.id, 1, { baseRevision: 7, accept: acceptAll }), null);
      assert.equal((await rowOf(theirs.id))?.title, "theirs");
    });

    it("keeps the current body as an overwrite version before an overwrite", async () => {
      const store = new EditorStore(pool);
      const page = await store.createPage(OWNER, { blocks: [paragraph("最初")] });
      // 別の画面の保存
      const elsewhere = expectSaved(await store.savePage(OWNER, page.id, { blocks: [paragraph("別の画面")] }, { baseRevision: 1 }));
      const conflict = expectConflict(await store.savePage(OWNER, page.id, { blocks: [paragraph("この画面")] }, { baseRevision: 1 }));
      const versionsBefore = await versionsOf(page.id);
      // 「この内容で上書き」: 競合の応答の revision を取り直して再送する
      const overwritten = expectSaved(
        await store.savePage(OWNER, page.id, { blocks: [paragraph("この画面")] }, { baseRevision: conflict.revision, overwrite: true }),
      );
      assert.equal(overwritten.revision, elsewhere.revision + 1);
      assert.deepEqual(overwritten.blocks, [paragraph("この画面")]);
      const versions = await versionsOf(page.id);
      assert.equal(versions.length, versionsBefore.length + 1);
      assert.deepEqual(versions.at(-1)?.blocks, [paragraph("別の画面")], "the other screen's text is kept as a version");
      assert.equal(versions.at(-1)?.reason, "overwrite");
      // overwrite でも baseRevision が古ければ競合
      expectConflict(await store.savePage(OWNER, page.id, { blocks: [paragraph("x")] }, { baseRevision: conflict.revision, overwrite: true }));
    });
  });

  describe("versions", () => {
    it("keeps the body before a save as an autosave version at the interval, never twice in a row, never empty, never for title-only saves", async () => {
      const store = new EditorStore(pool, { autosaveVersionIntervalMs: 10 * MINUTE });
      const page = await store.createPage(OWNER);
      let revision = page.revision;
      const save = async (patch: { title?: string; blocks?: Block[] }) => {
        const saved = expectSaved(await store.savePage(OWNER, page.id, patch, { baseRevision: revision }));
        revision = saved.revision;
        return saved;
      };
      const reasons = async () => (await versionsOf(page.id)).map((version) => [version.version, version.reason, version.blocks]);

      await save({ blocks: [paragraph("A")] });
      assert.deepEqual(await reasons(), [], "the empty body before the first save is not kept");
      await save({ blocks: [paragraph("B")] });
      assert.deepEqual(await reasons(), [[1, "autosave", [paragraph("A")]]], "the first change with no version keeps the body before the save");
      await save({ blocks: [paragraph("C")] });
      assert.equal((await reasons()).length, 1, "within the interval no version is kept");

      await ageVersions(page.id, 11);
      await save({ title: "題名だけ" });
      await save({ blocks: [paragraph("C")] });
      assert.equal((await reasons()).length, 1, "title-only saves and saves that do not change the body keep nothing");
      // JSON として等しい（key の順が違う）本文も「変わらない」
      await save({ blocks: [{ content: [{ text: "C", type: "text" }], type: "paragraph" }] });
      assert.equal((await reasons()).length, 1);

      await save({ blocks: [paragraph("D")] });
      assert.deepEqual((await reasons()).at(-1), [2, "autosave", [paragraph("C")]], "after the interval the body before the save is kept");

      // 直前の版と同じ本文は残さない
      await store.createVersion(OWNER, page.id, "ai");
      await ageVersions(page.id, 11);
      const count = (await reasons()).length;
      await save({ blocks: [paragraph("E")] });
      assert.equal((await reasons()).length, count, "the body equal to the latest version is not kept again");

      // 空の本文は残さない
      await save({ blocks: [] });
      await ageVersions(page.id, 11);
      await save({ blocks: [paragraph("F")] });
      const last = (await reasons()).at(-1);
      assert.notDeepEqual(last?.[2], [], "an empty body is never a version");
    });

    it("always keeps ai and publish versions, but not an autosave, overwrite or restore equal to the latest", async () => {
      const store = new EditorStore(pool);
      const page = await store.createPage(OWNER, { blocks: [paragraph("本文")] });
      const ai = await store.createVersion(OWNER, page.id, "ai");
      const again = await store.createVersion(OWNER, page.id, "ai");
      const publish = await store.createVersion(OWNER, page.id, "publish");
      assert.deepEqual([ai?.version, again?.version, publish?.version], [1, 2, 3]);
      assert.equal(ai?.blockCount, 1);
      for (const reason of ["autosave", "overwrite", "restore"] as const) {
        assert.equal(await store.createVersion(OWNER, page.id, reason), null, reason);
      }
      const empty = await store.createPage(OWNER);
      assert.equal(await store.createVersion(OWNER, empty.id, "restore"), null, "an empty body is not kept for restore");
      assert.equal((await store.createVersion(OWNER, empty.id, "publish"))?.blockCount, 0, "publish keeps even an empty body");
      assert.equal(await store.createVersion(OTHER, page.id, "ai"), null, "another owner's page is missing");
    });

    it("numbers versions per page without gaps or duplicates under concurrent writers", async () => {
      const storeA = new EditorStore(await newPool(3));
      const storeB = new EditorStore(await newPool(3));
      const page = await storeA.createPage(OWNER, { blocks: [paragraph("同時")] });
      const other = await storeA.createPage(OWNER, { blocks: [paragraph("別のページ")] });
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? storeA : storeB).createVersion(OWNER, index < 6 ? page.id : other.id, "ai")),
      );
      assert.ok(results.every((result) => result !== null));
      assert.deepEqual((await versionsOf(page.id)).map((version) => version.version), [1, 2, 3, 4, 5, 6]);
      assert.deepEqual((await versionsOf(other.id)).map((version) => version.version), [1, 2], "numbers are per page");
    });

    it("keeps at most the newest versions, dropping the oldest autosave versions first", async () => {
      const store = new EditorStore(pool, { autosaveVersionIntervalMs: 0 });
      const page = await store.createPage(OWNER, { blocks: [paragraph("上限")] });
      // v1 autosave、v2 ai、v3 overwrite、v4.. autosave で上限ちょうど
      await pool.query(
        `INSERT INTO page_versions (page_id, version, blocks, reason)
         SELECT $1, n, jsonb_build_array(jsonb_build_object('type', 'paragraph', 'n', n)),
                CASE n WHEN 2 THEN 'ai' WHEN 3 THEN 'overwrite' ELSE 'autosave' END
           FROM generate_series(1, $2::int) AS n`,
        [page.id, VERSION_KEEP_LIMIT],
      );
      // 公開は publication_versions に自分の公開版を持つので、公開していても page_versions の版は守らない（0009）
      await insertPublication(pool, page.id, `cap-${page.id.slice(0, 8)}`, { stopped: true });
      const added = await store.createVersion(OWNER, page.id, "ai");
      assert.equal(added?.version, VERSION_KEEP_LIMIT + 1);
      let numbers = (await versionsOf(page.id)).map((version) => version.version);
      assert.equal(numbers.length, VERSION_KEEP_LIMIT);
      assert.ok(!numbers.includes(1), "the oldest autosave version is dropped");
      assert.ok(numbers.includes(2) && numbers.includes(3), "ai and overwrite versions are kept");
      assert.ok(numbers.includes(4));

      // 今の本文は直前の ai の版と同じなので、1 回目の保存は版を残さない。2 回目で autosave の版が増える
      expectSaved(await store.savePage(OWNER, page.id, { blocks: [paragraph("次")] }, { baseRevision: 1 }));
      assert.equal((await versionsOf(page.id)).length, VERSION_KEEP_LIMIT);
      expectSaved(await store.savePage(OWNER, page.id, { blocks: [paragraph("その次")] }, { baseRevision: 2 }));
      numbers = (await versionsOf(page.id)).map((version) => version.version);
      assert.equal(numbers.length, VERSION_KEEP_LIMIT);
      assert.equal(numbers.at(-1), VERSION_KEEP_LIMIT + 2, "numbers are never reused");
      assert.ok(!numbers.includes(4));
      assert.ok(numbers.includes(2) && numbers.includes(3) && numbers.includes(5));
      assert.equal((await pool.query("SELECT 1 FROM publication_versions WHERE page_id = $1", [page.id])).rows.length, 1, "the published version is untouched");
    });

    it("lists versions newest first without bodies and reads one version with its body", async () => {
      const store = new EditorStore(pool);
      const page = await store.createPage(OWNER, { blocks: [paragraph("一"), paragraph("二")] });
      assert.deepEqual(await store.listVersions(OWNER, page.id), []);
      await store.createVersion(OWNER, page.id, "ai");
      await store.createVersion(OWNER, page.id, "publish");
      const list = await store.listVersions(OWNER, page.id);
      assert.deepEqual(list?.map(({ version, reason, blockCount }) => ({ version, reason, blockCount })), [
        { version: 2, reason: "publish", blockCount: 2 },
        { version: 1, reason: "ai", blockCount: 2 },
      ]);
      assert.ok(list?.every((item) => !("blocks" in item) && typeof item.createdAt === "string"));
      const one = await store.getVersion(OWNER, page.id, 1);
      assert.deepEqual(one?.blocks, [paragraph("一"), paragraph("二")]);
      assert.equal(one?.reason, "ai");
      assert.equal(await store.getVersion(OWNER, page.id, 3), null);
      assert.equal(await store.getVersion(OTHER, page.id, 1), null);
      assert.equal(await store.listVersions(OTHER, page.id), null);
      await pool.query(
        `INSERT INTO page_versions (page_id, version, blocks, reason)
         SELECT $1, n, '[]'::jsonb, 'ai' FROM generate_series(3, 130) AS n`,
        [page.id],
      );
      const capped = await store.listVersions(OWNER, page.id);
      assert.equal(capped?.length, 100);
      assert.equal(capped?.[0]?.version, 130);
    });

    it("restores a version after keeping the current body as a restore version", async () => {
      const store = new EditorStore(pool, { autosaveVersionIntervalMs: 0 });
      const page = await store.createPage(OWNER, { blocks: [paragraph("一版")] });
      const second = expectSaved(await store.savePage(OWNER, page.id, { blocks: [paragraph("二版")] }, { baseRevision: 1 }));
      assert.deepEqual((await versionsOf(page.id)).map((version) => version.blocks), [[paragraph("一版")]]);

      const stale = expectConflict(await store.restoreVersion(OWNER, page.id, 1, { baseRevision: 1, accept: acceptAll }));
      assert.equal(stale.revision, second.revision);
      assert.equal((await versionsOf(page.id)).length, 1, "a conflict writes nothing");

      assert.deepEqual(
        await store.restoreVersion(OWNER, page.id, 1, { baseRevision: second.revision, accept: () => null }),
        { status: "unrestorable" },
      );
      assert.equal((await rowOf(page.id))?.revision, second.revision, "an unrestorable version writes nothing");
      assert.equal((await versionsOf(page.id)).length, 1);

      assert.equal(await store.restoreVersion(OWNER, page.id, 9, { baseRevision: second.revision, accept: acceptAll }), null);

      let seen: unknown;
      const restored = expectSaved(
        await store.restoreVersion(OWNER, page.id, 1, {
          baseRevision: second.revision,
          accept: (blocks) => {
            seen = blocks;
            return [paragraph("一版（組み直し）")];
          },
        }),
      );
      assert.deepEqual(seen, [paragraph("一版")], "the stored version is checked");
      assert.deepEqual(restored.blocks, [paragraph("一版（組み直し）")], "the checked copy is written");
      assert.equal(restored.revision, second.revision + 1);
      const versions = await versionsOf(page.id);
      assert.deepEqual(versions.at(-1), { version: 2, reason: "restore", blocks: [paragraph("二版")] }, "the body before the restore is kept");
    });

    it("keeps cover and lead in metadata history and restores them together", async () => {
      const store = new EditorStore(pool);
      const page = await store.createPage(OWNER, { title: "記事", blocks: [paragraph("本文")] });
      const firstCover = randomUUID();
      const secondCover = randomUUID();
      for (const assetId of [firstCover, secondCover]) {
        await pool.query(
          `INSERT INTO assets (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type, upload_status)
           VALUES ($1, $2, $3, 'image', $4, 1024, $5, 'image/png', 'ready')`,
          [assetId, OWNER, page.id, `image/${assetId}`, "a".repeat(64)],
        );
      }
      const first = expectSaved(await store.savePage(OWNER, page.id, { cover: firstCover, lead: "初版のリード" }, { baseRevision: page.revision }));
      const second = expectSaved(await store.savePage(OWNER, page.id, { cover: secondCover, lead: "次のリード" }, { baseRevision: first.revision }));
      const savedVersion = (await pool.query<{ cover: string | null; lead: string | null; metadata_tracked: boolean }>(
        "SELECT cover, lead, metadata_tracked FROM page_versions WHERE page_id = $1 AND version = 2",
        [page.id],
      )).rows[0]!;
      assert.deepEqual(savedVersion, { cover: firstCover, lead: "初版のリード", metadata_tracked: true });

      const restored = expectSaved(await store.restoreVersion(OWNER, page.id, 2, { baseRevision: second.revision, accept: acceptAll }));
      assert.equal(restored.cover, firstCover);
      assert.equal(restored.lead, "初版のリード");
      assert.equal(restored.revision, second.revision + 1);
      const restoreSnapshot = (await pool.query<{ cover: string | null; lead: string | null; metadata_tracked: boolean }>(
        "SELECT cover, lead, metadata_tracked FROM page_versions WHERE page_id = $1 ORDER BY version DESC LIMIT 1",
        [page.id],
      )).rows[0]!;
      assert.deepEqual(restoreSnapshot, { cover: secondCover, lead: "次のリード", metadata_tracked: true });
    });
  });

  describe("trash", () => {
    it("moves a page and its descendants to the trash together and restores them together", async () => {
      const store = new EditorStore(pool);
      const parent = await store.createPage(OWNER, { title: "親" });
      const child = await store.createPage(OWNER, { title: "子" });
      const grandchild = await store.createPage(OWNER, { title: "孫" });
      const earlier = await store.createPage(OWNER, { title: "先に消した子" });
      await pool.query("UPDATE pages SET parent = $1 WHERE id = ANY($2::uuid[])", [parent.id, [child.id, earlier.id]]);
      await pool.query("UPDATE pages SET parent = $1 WHERE id = $2", [child.id, grandchild.id]);
      assert.equal(await store.deletePage(OWNER, earlier.id), "deleted");

      assert.equal(await store.deletePage(OWNER, parent.id), "deleted");
      const stamps = await pool.query<{ id: string; deleted: string }>(
        "SELECT id, deleted_at::text AS deleted FROM pages WHERE id = ANY($1::uuid[])",
        [[parent.id, child.id, grandchild.id, earlier.id]],
      );
      const stamp = new Map(stamps.rows.map((row) => [row.id, row.deleted]));
      assert.ok(stamp.get(parent.id));
      assert.equal(stamp.get(child.id), stamp.get(parent.id), "the child has the same deleted_at");
      assert.equal(stamp.get(grandchild.id), stamp.get(parent.id), "the grandchild has the same deleted_at");
      assert.notEqual(stamp.get(earlier.id), stamp.get(parent.id));

      const listed = (await store.listPages(OWNER)).map((page) => page.id);
      for (const id of [parent.id, child.id, grandchild.id, earlier.id]) {
        assert.ok(!listed.includes(id));
        assert.equal(await store.getPage(OWNER, id), null);
        assert.equal(await store.savePage(OWNER, id, { title: "x" }, { baseRevision: 1 }), null);
        assert.equal(await store.deletePage(OWNER, id), null, "a page in the trash cannot be deleted again");
      }
      const trash = await store.listTrash(OWNER);
      const trashIds = trash.map((page) => page.id);
      for (const id of [parent.id, child.id, grandchild.id, earlier.id]) assert.ok(trashIds.includes(id));
      assert.ok(trashIds.indexOf(parent.id) < trashIds.indexOf(earlier.id), "newest deletions first");
      assert.deepEqual(Object.keys(trash[0]!).sort(), ["deletedAt", "id", "kind", "title"]);

      // 別の人はゴミ箱を見られず、戻せない
      assert.ok(!(await store.listTrash(OTHER)).some((page) => page.id === parent.id));
      assert.equal(await store.restoreFromTrash(OTHER, parent.id), false);
      assert.equal(await store.restoreFromTrash(OWNER, randomUUID()), false);
      assert.equal(await store.restoreFromTrash(OWNER, "not-a-uuid"), false);

      assert.equal(await store.restoreFromTrash(OWNER, parent.id), true);
      for (const id of [parent.id, child.id, grandchild.id]) assert.ok(await store.getPage(OWNER, id), "restored together");
      assert.equal(await store.getPage(OWNER, earlier.id), null, "a child deleted on its own stays in the trash");
      assert.equal(await store.restoreFromTrash(OWNER, parent.id), false, "a page not in the trash is missing");
    });

    it("trashes a parent and its child deleted at the same moment without a deadlock", async () => {
      const storeA = new EditorStore(await newPool(2));
      const storeB = new EditorStore(await newPool(2));
      for (let round = 0; round < 10; round++) {
        const parent = await storeA.createPage(OWNER, { title: "親" });
        const child = await storeA.createPage(OWNER, { title: "子" });
        const grandchild = await storeA.createPage(OWNER, { title: "孫" });
        await pool.query("UPDATE pages SET parent = $1 WHERE id = $2", [parent.id, child.id]);
        await pool.query("UPDATE pages SET parent = $1 WHERE id = $2", [child.id, grandchild.id]);
        // 親が先なら子は親と一緒にゴミ箱へ入っているので、子の削除は「無い」（null）。子が先なら両方 deleted
        const [a, b] = await Promise.all([storeA.deletePage(OWNER, parent.id), storeB.deletePage(OWNER, child.id)]);
        assert.equal(a, "deleted", `round ${round}`);
        assert.ok(b === "deleted" || b === null, `round ${round}: ${String(b)}`);
        for (const page of [parent, child, grandchild]) assert.notEqual((await rowOf(page.id))?.deleted_at, null);
        const [r1, r2] = await Promise.all([storeA.restoreFromTrash(OWNER, parent.id), storeB.restoreFromTrash(OWNER, child.id)]);
        assert.ok(r1 || r2, `round ${round}: a restore succeeds`);
        for (const page of [parent, child, grandchild]) assert.equal((await rowOf(page.id))?.deleted_at, null, `round ${round}: ${page.title}`);
      }
    });

    it("refuses to trash a published page or a page with a published descendant, and never touches another owner's page", async () => {
      const store = new EditorStore(pool);
      const published = await store.createPage(OWNER, { title: "公開中", blocks: [paragraph("公開")] });
      await insertPublication(pool, published.id, `pub-${published.id.slice(0, 8)}`);
      assert.equal(await store.deletePage(OWNER, published.id), "published");
      assert.equal((await rowOf(published.id))?.deleted_at, null);

      const parent = await store.createPage(OWNER, { title: "公開中の子を持つ親" });
      await pool.query("UPDATE pages SET parent = $1 WHERE id = $2", [parent.id, published.id]);
      assert.equal(await store.deletePage(OWNER, parent.id), "published");
      assert.equal((await rowOf(parent.id))?.deleted_at, null, "nothing is trashed");

      // 公開をやめたら削除できる
      await pool.query("UPDATE publications SET stopped_at = clock_timestamp() WHERE page_id = $1", [published.id]);
      assert.equal(await store.deletePage(OWNER, parent.id), "deleted");

      const theirs = await store.createPage(OTHER, { title: "theirs" });
      assert.equal(await store.deletePage(OWNER, theirs.id), null);
      assert.equal((await rowOf(theirs.id))?.deleted_at, null);
    });
  });

  describe("purge", () => {
    it("purges pages trashed longer than the retention, children first, and keeps everything else", async () => {
      // このテストだけの schema（ほかのテストのゴミ箱を巻き込まない）
      const purgeSchema = `${schema}_purge`;
      await pool.query(`CREATE SCHEMA "${purgeSchema}"`);
      const { Pool } = await import("pg");
      const purgePool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${purgeSchema}` });
      try {
        const client = await purgePool.connect();
        try {
          await applyMigrations(client);
        } finally {
          client.release();
        }
        const store = new EditorStore(purgePool);
        const make = (owner: string, title: string) => store.createPage(owner, { title, blocks: [paragraph(title)] });
        const setParent = (child: Page, parent: Page) => purgePool.query("UPDATE pages SET parent = $1 WHERE id = $2", [parent.id, child.id]);
        const asset = async (owner: string, page: Page, path: string) =>
          (
            await purgePool.query<{ id: string }>(
              "INSERT INTO assets (owner, page_id, kind, bucket_path, bytes, sha256, content_type) VALUES ($1, $2, 'image', $3, 1, $4, 'image/png') RETURNING id",
              [owner, page.id, path, "a".repeat(64)],
            )
          ).rows[0]!.id;
        /** ゴミ箱に入れ、その時刻を days 日前にする（一緒に入った子孫も同じだけ）。 */
        const trashAgo = async (owner: string, page: Page, days: number) => {
          assert.equal(await store.deletePage(owner, page.id), "deleted");
          await purgePool.query(
            `UPDATE pages
                SET created_at = created_at - make_interval(days => $2 + 1),
                    updated_at = updated_at - make_interval(days => $2 + 1),
                    deleted_at = deleted_at - make_interval(days => $2)
              WHERE deleted_at = (SELECT deleted_at FROM pages WHERE id = $1)`,
            [page.id, days],
          );
        };
        const exists = async (page: Page) => (await purgePool.query("SELECT 1 FROM pages WHERE id = $1", [page.id])).rows.length === 1;

        // 親・子・孫を一緒に 31 日前にゴミ箱へ。版と資産（親のカバーは自分の資産）を持つ
        const parent = await make(OWNER, "親");
        const child = await make(OWNER, "子");
        const grandchild = await make(OWNER, "孫");
        await setParent(child, parent);
        await setParent(grandchild, child);
        await store.createVersion(OWNER, parent.id, "ai");
        await store.createVersion(OWNER, grandchild.id, "ai");
        const cover = await asset(OWNER, parent, "synthetic/parent.png");
        await purgePool.query("UPDATE pages SET cover = $1 WHERE id = $2", [cover, parent.id]);
        await asset(OWNER, child, "synthetic/child.png");
        // 子のカバーが孫の資産を指す（孫が先に消えて資産が CASCADE で消えるときに、カバーの RESTRICT で止まらないこと）
        const grandchildAsset = await asset(OWNER, grandchild, "synthetic/grandchild.png");
        await purgePool.query("UPDATE pages SET cover = $1 WHERE id = $2", [grandchildAsset, child.id]);
        await trashAgo(OWNER, parent, 31);

        // 戻された子を持つ親: 親だけ消え、子は親を外して残る
        const oldParent = await make(OWNER, "古い親");
        const rescued = await make(OWNER, "戻した子");
        await setParent(rescued, oldParent);
        await trashAgo(OWNER, oldParent, 40);
        assert.equal(await store.restoreFromTrash(OWNER, rescued.id), true);

        const recent = await make(OWNER, "29 日前");
        await trashAgo(OWNER, recent, 29);
        const alive = await make(OWNER, "生きている");
        const otherAlive = await make(OTHER, "別の人の生きている");
        const otherRecent = await make(OTHER, "別の人の 29 日前");
        await trashAgo(OTHER, otherRecent, 29);
        const otherOld = await make(OTHER, "別の人の 31 日前");
        await trashAgo(OTHER, otherOld, 31);
        // 公開の記録がある（公開をやめた）ページは消さない
        const wasPublished = await make(OWNER, "公開をやめた");
        await insertPublication(purgePool, wasPublished.id, "stopped", { stopped: true });
        await trashAgo(OWNER, wasPublished, 31);
        // 生きているページのカバーが使っている資産を持つページは消さない
        const coverSource = await make(OWNER, "カバーの元");
        const borrowed = await asset(OWNER, coverSource, "synthetic/borrowed.png");
        await purgePool.query("UPDATE pages SET cover = $1 WHERE id = $2", [borrowed, alive.id]);
        await trashAgo(OWNER, coverSource, 31);

        const notYet = await store.purgeTrash({ olderThanDays: 45 });
        assert.deepEqual(notYet, { pages: 0, assetPaths: [] }, "nothing is older than 45 days");
        assert.ok(await exists(oldParent));

        const purged = await store.purgeTrash();
        assert.equal(purged.pages, 5);
        assert.deepEqual(purged.assetPaths, ["synthetic/child.png", "synthetic/grandchild.png", "synthetic/parent.png"]);
        for (const page of [parent, child, grandchild, oldParent, otherOld]) assert.equal(await exists(page), false, page.title);
        for (const page of [rescued, recent, alive, otherAlive, otherRecent, wasPublished, coverSource]) assert.equal(await exists(page), true, page.title);
        assert.equal((await purgePool.query<{ parent: string | null }>("SELECT parent FROM pages WHERE id = $1", [rescued.id])).rows[0]?.parent, null);
        const leftovers = await purgePool.query<{ n: number }>(
          "SELECT (SELECT count(*) FROM page_versions WHERE page_id = ANY($1::uuid[])) + (SELECT count(*) FROM assets WHERE page_id = ANY($1::uuid[]))::int AS n",
          [[parent.id, child.id, grandchild.id]],
        );
        assert.equal(Number(leftovers.rows[0]?.n), 0, "versions and assets go with the page");
        assert.equal((await purgePool.query("SELECT 1 FROM assets WHERE id = $1", [borrowed])).rows.length, 1);
        assert.deepEqual(await store.purgeTrash(), { pages: 0, assetPaths: [] }, "a second run has nothing to do");
      } finally {
        await purgePool.end();
        await pool.query(`DROP SCHEMA IF EXISTS "${purgeSchema}" CASCADE`);
      }
    });
  });
});
