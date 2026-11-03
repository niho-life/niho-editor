import { createHash, randomUUID } from "node:crypto";
import {
  ConnectionService,
  PublishService,
  connectionSource,
  deriveStatus,
  siteDeclarationSource,
  type ConnectionStore,
  type ConnectionTx,
  type PlaceInput,
  type PublishResult,
  type PublishSettings,
  type Target,
} from "@niho/editor-publish";
import { ManualClock, MemoryAssetBytes, MemoryAuthors, MemoryDeclarations, MemoryFacts, MemoryRoles, memoryAssetUrls } from "@niho/editor-publish/test-support";
import {
  EditorStore,
  connectionByKeySha256,
  getPublication,
  getPublicationVersion,
  latestPublicationVersion,
  listLivePublished,
  readPublishedForHandle,
} from "@niho/editor-store";
import { applyMigrations } from "@niho/editor-store/migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgDraftFingerprints, pgPublishStore } from "./pg-store";

// 本物の PublishService と ConnectionService を Postgres の adapter で動かし、受入の流れを確かめる
// （packages/editor-publish の acceptance・atomicity のテストを手本にした最小限の写し）。TEST_DATABASE_URL が無ければ skip。
// 値はすべて合成（example.com の host、合成のユーザー ID・本文。鍵は実行時にサービスが作る）。
const databaseUrl = process.env.TEST_DATABASE_URL;

const ACTOR = "synthetic-publish-actor-a";
const OTHER_ACTOR = "synthetic-publish-actor-b";
const LEAD = "Start early, follow the shoreline, and stop for tea.";

/** packages/editor-publish/fixtures/destinations の exp・niho の写し（面の宣言）。 */
const FACE_DECLARATIONS = {
  exp: {
    schemaVersion: 1,
    id: "exp",
    label: "NIHO Experience",
    host: "exp.example.com",
    path: "guides",
    ranges: ["live", "unlisted"],
    extras: ["app", "news", "xp"],
    accepts: { blocks: ["paragraph", "heading", "list", "figure", "note"], marks: ["bold", "italic", "link"] },
    requires: [
      { id: "lang-en", kind: "lang", equals: "en", message: "英語で書いてください", fix: "lang" },
      { id: "cover", kind: "cover", consent: true, message: "掲載許諾のあるカバー写真を選んでください", fix: "cover" },
      { id: "lead", kind: "lead", max: 200, message: "リードを 200 字以内で書いてください", fix: "lead" },
      { id: "category", kind: "category", oneOf: ["walks", "food", "stay"], message: "カテゴリを選んでください", fix: "category" },
      { id: "headings", kind: "headings", min: 1, message: "本文に見出しを 1 つ以上入れてください", fix: "body" },
      { id: "no-confirm", kind: "noConfirm", message: "未確認の印（CONFIRM）を解消してください", fix: "body" },
      { id: "related-live", kind: "relatedLive", message: "掲載中の関連する体験を選んでください", fix: "related" },
    ],
  },
  niho: {
    schemaVersion: 1,
    id: "niho",
    label: "NIHO",
    host: "niho.example.com",
    path: "article",
    ranges: ["live", "unlisted"],
    extras: ["app", "news"],
    accepts: {
      blocks: ["paragraph", "heading", "list", "quote", "figure", "divider", "note"],
      marks: ["bold", "italic", "strike", "code", "link"],
    },
    requires: [
      { id: "cover", kind: "cover", consent: false, message: "カバー写真を選んでください", fix: "cover" },
      { id: "lead", kind: "lead", message: "リードを書いてください", fix: "lead" },
      { id: "category", kind: "category", message: "カテゴリを選んでください", fix: "category" },
    ],
  },
} as const;

const SETTINGS: { readonly exp: PublishSettings; readonly niho: PublishSettings; readonly site: PublishSettings } = {
  exp: { range: "live", extras: { app: true, news: false, xp: true }, category: "walks", related: ["coastal-tea-ceremony"] },
  niho: { range: "live", extras: { app: true, news: true, xp: false }, category: "essay", related: [] },
  site: { range: "live", extras: { app: false, news: false, xp: false }, category: null, related: [] },
};

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** 1 つ目の公開に使える本文（見出し・太字・画像・録音・リンク）。 */
function readyBlocks(figureId: string, audioId: string): unknown[] {
  return [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Getting there" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Meet at the " },
        { type: "text", text: "station", marks: [{ type: "bold" }] },
        { type: "text", text: " at 7:00." },
      ],
    },
    { type: "image", attrs: { assetId: figureId, alt: "Fishing boats in the harbor", caption: "The harbor at 7:30" } },
    { type: "recording", attrs: { assetId: audioId } },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Then follow " },
        { type: "text", text: "the coastal path", marks: [{ type: "link", attrs: { href: "https://maps.example.com/coast" } }] },
        { type: "text", text: "." },
      ],
    },
  ];
}

describe.skipIf(databaseUrl === undefined)("the publish ports on PostgreSQL", () => {
  const schema = `editor_publish_pg_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;
  let store: ConnectionStore;
  const clock = new ManualClock("2026-10-01T09:00:00.000Z", 60);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
    store = pgPublishStore(pool);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  /** サービス一式。store を差し替えれば、包んだ adapter で同じ操作を動かせる。 */
  function services(over: ConnectionStore = store, actorRoles: readonly string[] = ["writer"]) {
    const roles = new MemoryRoles();
    roles.set(ACTOR, actorRoles);
    roles.set(OTHER_ACTOR, ["writer"]);
    const faces = new MemoryDeclarations();
    faces.set("exp", FACE_DECLARATIONS.exp);
    faces.set("niho", FACE_DECLARATIONS.niho);
    const authors = new MemoryAuthors();
    authors.set(ACTOR, { name: "Example Writer", handle: "example-writer", url: "https://writer.example.com/" });
    authors.set(OTHER_ACTOR, { name: "Another Writer", handle: null, url: null });
    const facts = new MemoryFacts();
    facts.set(ACTOR, { relatedLive: true });
    facts.set(OTHER_ACTOR, { relatedLive: true });
    const publisher = new PublishService({
      store: over,
      roles,
      storage: { read: async () => "CLOUD" },
      connections: connectionSource(over),
      declarations: siteDeclarationSource(over, faces),
      authors,
      facts,
      assetUrls: memoryAssetUrls(),
      clock,
    });
    const connections = new ConnectionService({ store: over, clock, drafts: pgDraftFingerprints(pool), assetBytes: new MemoryAssetBytes() });
    return { publisher, connections };
  }

  /** 公開できる下書き（カバー・画像・録音の資産つき）。題名は slug が重ならないように毎回変える。 */
  async function readyPage(owner = ACTOR): Promise<{ pageId: string; title: string; slug: string }> {
    const word = `w${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const title = `Coastal walk ${word}`;
    const created = await pool.query<{ id: string }>("INSERT INTO pages (owner, title, lang, lead) VALUES ($1, $2, 'en', $3) RETURNING id", [owner, title, LEAD]);
    const pageId = created.rows[0]!.id;
    const asset = async (label: string, kind: string, contentType: string, alt: string | null, credit: string | null): Promise<string> => {
      const bytes = `synthetic ${label} ${pageId}`;
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO assets (owner, page_id, kind, bucket_path, bytes, sha256, content_type, alt, credit, consent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true) RETURNING id`,
        [owner, pageId, kind, `synthetic/${pageId}/${label}`, Buffer.byteLength(bytes), sha256(bytes), contentType, alt, credit],
      );
      return inserted.rows[0]!.id;
    };
    const cover = await asset("cover", "image", "image/jpeg", "Shoreline at sunrise", "Example Photo Studio");
    const figure = await asset("figure", "image", "image/webp", "Boats", null);
    const audio = await asset("audio", "audio", "audio/mp4", null, null);
    await pool.query("UPDATE pages SET cover = $2, blocks = $3::jsonb WHERE id = $1", [pageId, cover, JSON.stringify(readyBlocks(figure, audio))]);
    return { pageId, title, slug: `coastal-walk-${word}` };
  }

  function input(pageId: string, target: Target, settings: PublishSettings, patch: Partial<PlaceInput> = {}): PlaceInput {
    return { actorId: ACTOR, pageId, target, settings, ...patch };
  }

  const NIHO: Target = { dest: "niho" };
  const EXP: Target = { dest: "exp" };

  async function versionsOf(pageId: string): Promise<Array<{ version: number; handle: string; title: string; updatedAt: string }>> {
    const result = await pool.query<{ version: number; handle: string; title: string; updated_at: string }>(
      "SELECT version, handle, snapshot ->> 'title' AS title, snapshot ->> 'updatedAt' AS updated_at FROM publication_versions WHERE page_id = $1 ORDER BY version",
      [pageId],
    );
    return result.rows.map((row) => ({ version: row.version, handle: row.handle, title: row.title, updatedAt: row.updated_at }));
  }

  async function redirectsOf(pageId: string) {
    const result = await pool.query<{ from_handle: string; from_slug: string; to_handle: string | null; to_slug: string | null }>(
      "SELECT from_handle, from_slug, to_handle, to_slug FROM publication_redirects WHERE page_id = $1 ORDER BY from_handle, from_slug",
      [pageId],
    );
    return result.rows;
  }

  /** 公開に関わる表とページの行の全体（2 つを比べて「何も変わっていない」を確かめる）。 */
  async function dump(): Promise<string> {
    const tables = {
      pages: "SELECT id, title, blocks, revision, updated_at, deleted_at FROM pages ORDER BY id",
      publications: "SELECT * FROM publications ORDER BY page_id",
      publication_versions: "SELECT page_id, version, handle, snapshot FROM publication_versions ORDER BY page_id, version",
      publication_redirects: "SELECT * FROM publication_redirects ORDER BY from_handle, from_slug",
      site_connections: "SELECT * FROM site_connections ORDER BY id",
      site_connection_keys: "SELECT * FROM site_connection_keys ORDER BY id",
    };
    const out: Record<string, unknown> = {};
    for (const [name, sql] of Object.entries(tables)) out[name] = (await pool.query(sql)).rows;
    return JSON.stringify(out);
  }

  it("publish → update → stop → re-publish on the same URL", async () => {
    const { publisher } = services();
    const { pageId, slug } = await readyPage();

    const first = await publisher.publish(input(pageId, EXP, SETTINGS.exp));
    expect(first).toMatchObject({ ok: true, status: "published", version: 1, url: `https://exp.example.com/guides/${slug}` });
    if (!first.ok) throw new Error(first.reason);
    expect(await getPublication(pool, pageId)).toMatchObject({ dest: "exp", handle: "exp", slug, version: 1, stoppedAt: null });
    expect((await listLivePublished(pool, "exp")).items.map((item) => item.publication.pageId)).toContain(pageId);
    const v1 = (await getPublicationVersion(pool, pageId, 1))!.snapshot as { fingerprint: string; title: string };
    // 公開したばかりの下書きの fingerprint は公開版と同じ（DraftFingerprints の Postgres の実装）
    expect(await pgDraftFingerprints(pool).read(pageId)).toBe(v1.fingerprint);

    // 下書きを直すと「更新あり」。公開版は直した内容に追従しない
    await pool.query("UPDATE pages SET title = $2 WHERE id = $1", [pageId, "A morning walk, revised"]);
    expect(deriveStatus({ range: "live", stoppedAt: null, fingerprint: v1.fingerprint }, (await pgDraftFingerprints(pool).read(pageId))!)).toBe("updated");
    const live = await readPublishedForHandle(pool, "exp", pageId);
    expect(live?.status === "live" && (live.snapshot as { title: string }).title).toBe(v1.title);

    const updated = await publisher.update(input(pageId, EXP, SETTINGS.exp));
    expect(updated).toMatchObject({ ok: true, status: "published", version: 2, url: first.url });
    if (!updated.ok) throw new Error(updated.reason);
    expect(updated.publication.publishedAt).toBe(first.publication.publishedAt);
    expect(updated.publication.updatedAt > first.publication.updatedAt).toBe(true);
    expect((await versionsOf(pageId)).map((version) => version.title)).toEqual([v1.title, "A morning walk, revised"]);

    const stopped = await publisher.stop({ actorId: ACTOR, pageId });
    expect(stopped).toMatchObject({ ok: true, status: "stopped" });
    expect(await publisher.stop({ actorId: ACTOR, pageId })).toEqual(stopped);
    expect(await redirectsOf(pageId)).toEqual([{ from_handle: "exp", from_slug: slug, to_handle: null, to_slug: null }]);
    expect((await listLivePublished(pool, "exp")).items.map((item) => item.publication.pageId)).not.toContain(pageId);
    expect(await readPublishedForHandle(pool, "exp", pageId)).toMatchObject({ status: "left", slug, version: 2, movedTo: null });
    // 公開をやめたページはゴミ箱へ入れられる。戻してから再公開する
    const editor = new EditorStore(pool);
    expect(await editor.deletePage(ACTOR, pageId)).toBe("deleted");
    expect(await publisher.publish(input(pageId, EXP, SETTINGS.exp))).toEqual({ ok: false, reason: "not_found" });
    expect(await editor.restoreFromTrash(ACTOR, pageId)).toBe(true);

    const again = await publisher.publish(input(pageId, EXP, SETTINGS.exp));
    expect(again).toMatchObject({ ok: true, version: 3, url: first.url });
    expect(await redirectsOf(pageId)).toEqual([]);
    expect(await readPublishedForHandle(pool, "exp", pageId)).toMatchObject({ status: "live", publication: { version: 3, stoppedAt: null } });
    expect(await editor.deletePage(ACTOR, pageId)).toBe("published");
    // 公開版は追記だけ（番号は使い回さない）
    expect((await versionsOf(pageId)).map((version) => version.version)).toEqual([1, 2, 3]);
  });

  it("moves Experience ↔ a connected site, preserving URL and slug invariants", async () => {
    const { publisher, connections } = services();
    const moving = await readyPage();
    const holder = await readyPage();
    const handle = `move-${randomUUID().slice(0, 8)}`;
    const connected = await connections.createConnection({ actorId: ACTOR, handle, mode: "api", siteUrl: "https://move.example.net" });
    if (!connected.ok) throw new Error(connected.reason);
    const site: Target = { dest: "site", handle };
    expect((await publisher.publish(input(moving.pageId, EXP, SETTINGS.exp))).ok).toBe(true);
    // 移し先の本人siteで、別のページが同じ slug を持っている
    expect((await publisher.publish(input(holder.pageId, site, SETTINGS.site, { slug: moving.slug }))).ok).toBe(true);

    const taken = await publisher.changeDestination(input(moving.pageId, site, SETTINGS.site, { slug: moving.slug }));
    expect(taken).toEqual({ ok: false, reason: "slug_taken", suggestion: `${moving.slug}-2` });
    expect(await getPublication(pool, moving.pageId)).toMatchObject({ handle: "exp", stoppedAt: null });

    const moved = await publisher.changeDestination(input(moving.pageId, site, SETTINGS.site));
    expect(moved).toMatchObject({ ok: true, version: 2, url: `https://move.example.net/${moving.slug}-2` });
    expect(await redirectsOf(moving.pageId)).toEqual([{ from_handle: "exp", from_slug: moving.slug, to_handle: null, to_slug: null }]);
    expect(await readPublishedForHandle(pool, "exp", moving.pageId)).toEqual({
      status: "left",
      pageId: moving.pageId,
      handle: "exp",
      dest: "exp",
      slug: moving.slug,
      range: "live",
      version: 1,
      stoppedAt: moved.ok ? moved.publication.updatedAt : "",
      movedTo: null,
    });

    // Experience の元 URL へ戻すと、一覧への転送は消える。site の旧 URL には転送を作らない。
    const back = await publisher.changeDestination(input(moving.pageId, EXP, SETTINGS.exp, { slug: moving.slug }));
    expect(back).toMatchObject({ ok: true, version: 3, url: `https://exp.example.com/guides/${moving.slug}` });
    expect(await redirectsOf(moving.pageId)).toEqual([]);
    // 公開中の Experience slug は、ほかのページは取れない
    const other = await readyPage();
    expect(await publisher.publish(input(other.pageId, EXP, SETTINGS.exp, { slug: moving.slug }))).toMatchObject({ ok: false, reason: "slug_taken" });
    // 公開後の slug は固定
    expect(await publisher.publish(input(holder.pageId, site, SETTINGS.site, { slug: "another-slug" }))).toEqual({ ok: false, reason: "slug_locked", slug: moving.slug });
  });

  it.each([["writer"], ["kamakura"]])("refuses new NIHO publications and updates for the %s role", async (role) => {
    const { publisher } = services(store, [role]);
    const { pageId } = await readyPage();
    expect(await publisher.publish(input(pageId, NIHO, SETTINGS.niho))).toEqual({ ok: false, reason: "forbidden_destination", detail: "role" });
    expect(await publisher.update(input(pageId, NIHO, SETTINGS.niho))).toEqual({ ok: false, reason: "forbidden_destination", detail: "role" });
  });

  it("disconnecting stops every live page on the site; the old keys and the handle stop working", async () => {
    const { publisher, connections } = services();
    const handle = `notes-${randomUUID().slice(0, 8)}`;
    const created = await connections.createConnection({ actorId: ACTOR, handle, mode: "api", siteUrl: "https://notes.example.net" });
    if (!created.ok) throw new Error(created.reason);
    const site: Target = { dest: "site", handle };
    const first = await readyPage();
    const second = await readyPage();
    expect(await publisher.publish(input(first.pageId, site, SETTINGS.site))).toMatchObject({ ok: true, url: `https://notes.example.net/${first.slug}` });
    expect((await publisher.publish(input(second.pageId, site, SETTINGS.site))).ok).toBe(true);
    expect((await listLivePublished(pool, handle)).items).toHaveLength(2);
    expect(await connections.authenticateKey(created.key.plaintext)).toEqual({ connectionId: created.connection.id, handle });
    expect(await connectionByKeySha256(pool, sha256(created.key.plaintext))).toEqual({ connectionId: created.connection.id, handle });
    // 平文の鍵はどこにも保存されない
    expect(await dump()).not.toContain(created.key.plaintext.slice(3, 20));

    // 下書きを直すと、接続の一覧で「更新あり」
    await pool.query("UPDATE pages SET lead = 'A revised lead.' WHERE id = $1", [first.pageId]);
    const listed = await connections.listPublished({ actorId: ACTOR, connectionId: created.connection.id });
    expect(listed.ok && Object.fromEntries(listed.items.map((item) => [item.pageId, item.status]))).toEqual({ [first.pageId]: "updated", [second.pageId]: "published" });

    const disconnected = await connections.disconnect({ actorId: ACTOR, connectionId: created.connection.id });
    expect(disconnected).toMatchObject({ ok: true, revokedKeys: 1, stopped: 2 });
    expect((await getPublication(pool, first.pageId))?.stoppedAt).not.toBeNull();
    expect((await listLivePublished(pool, handle)).items).toEqual([]);
    expect(await connections.authenticateKey(created.key.plaintext)).toBeNull();
    expect(await connectionByKeySha256(pool, sha256(created.key.plaintext))).toBeNull();
    expect(await readPublishedForHandle(pool, handle, first.pageId)).toMatchObject({ status: "left", movedTo: null });
    // 解除した接続へは公開できず、handle は他の人の接続にも渡らない
    expect(await publisher.publish(input(first.pageId, site, SETTINGS.site))).toEqual({ ok: false, reason: "forbidden_destination", detail: "connection" });
    expect(await connections.createConnection({ actorId: OTHER_ACTOR, handle, mode: "api", siteUrl: "https://other.example.net" })).toEqual({ ok: false, reason: "handle_taken" });
    expect(await connections.disconnect({ actorId: ACTOR, connectionId: created.connection.id })).toMatchObject({ ok: true, revokedKeys: 0, stopped: 0 });
  });

  it("after rotateKey the old key no longer authenticates", async () => {
    const { connections } = services();
    const handle = `rotate-${randomUUID().slice(0, 8)}`;
    const created = await connections.createConnection({ actorId: ACTOR, handle, mode: "api", siteUrl: "https://rotate.example.net" });
    if (!created.ok) throw new Error(created.reason);
    const rotated = await connections.rotateKey({ actorId: ACTOR, connectionId: created.connection.id });
    if (!rotated.ok) throw new Error(rotated.reason);
    expect(rotated.revoked).toBe(1);
    expect(await connections.authenticateKey(created.key.plaintext)).toBeNull();
    expect(await connections.authenticateKey(rotated.key.plaintext)).toEqual({ connectionId: created.connection.id, handle });
    const view = await connections.getConnectionView({ actorId: ACTOR, connectionId: created.connection.id });
    expect(view.ok && view.connection.keys.map((key) => key.active)).toEqual([true, false]);
    expect(await connections.rotateKey({ actorId: OTHER_ACTOR, connectionId: created.connection.id })).toEqual({ ok: false, reason: "not_found" });
  });

  describe("rollback", () => {
    /** adapter を包み、`fail(名前, 何番目の呼び出しか)` が true の呼び出しで例外を投げる。 */
    function faulty(fail: (name: string, index: number) => boolean): ConnectionStore & { readonly calls: string[] } {
      const calls: string[] = [];
      return {
        calls,
        transaction: (work) =>
          store.transaction((tx) =>
            work(
              new Proxy(tx, {
                get(target, property, receiver) {
                  const value: unknown = Reflect.get(target, property, receiver);
                  if (typeof value !== "function") return value;
                  return async (...args: unknown[]) => {
                    calls.push(String(property));
                    if (fail(String(property), calls.length)) throw new Error("injected store fault");
                    return (value as (...rest: unknown[]) => Promise<unknown>).apply(target, args);
                  };
                },
              }) as ConnectionTx,
            ),
          ),
      };
    }

    it("a failure in putPublication after addVersion leaves nothing behind", async () => {
      const { pageId } = await readyPage();
      const before = await dump();
      const broken = faulty((name) => name === "putPublication");
      expect(await services(broken).publisher.publish(input(pageId, EXP, SETTINGS.exp))).toEqual({ ok: false, reason: "failed", retryable: true });
      expect(broken.calls.indexOf("addVersion")).toBeGreaterThan(-1);
      expect(broken.calls.indexOf("addVersion")).toBeLessThan(broken.calls.indexOf("putPublication"));
      expect(await dump()).toBe(before);
      expect(await latestPublicationVersion(pool, pageId)).toBe(0);

      // 公開中のページの更新でも、前の公開版・公開・下書きが残る
      expect((await services().publisher.publish(input(pageId, EXP, SETTINGS.exp))).ok).toBe(true);
      await pool.query("UPDATE pages SET title = 'A revised title' WHERE id = $1", [pageId]);
      const published = await dump();
      expect(await services(broken).publisher.update(input(pageId, EXP, SETTINGS.exp))).toEqual({ ok: false, reason: "failed", retryable: true });
      expect(await dump()).toBe(published);
      expect(await services().publisher.update(input(pageId, EXP, SETTINGS.exp))).toMatchObject({ ok: true, version: 2 });
    });

    type Operation = { name: string; prepare: () => Promise<(store: ConnectionStore) => Promise<{ ok: boolean }>> };

    const operations: Operation[] = [
      {
        name: "publish",
        prepare: async () => {
          const { pageId } = await readyPage();
          return (over) => services(over).publisher.publish(input(pageId, EXP, SETTINGS.exp));
        },
      },
      {
        name: "update",
        prepare: async () => {
          const { pageId } = await readyPage();
          await services().publisher.publish(input(pageId, EXP, SETTINGS.exp));
          await pool.query("UPDATE pages SET title = 'Updated in place' WHERE id = $1", [pageId]);
          return (over) => services(over).publisher.update(input(pageId, EXP, SETTINGS.exp));
        },
      },
      {
        name: "stop",
        prepare: async () => {
          const { pageId } = await readyPage();
          await services().publisher.publish(input(pageId, EXP, SETTINGS.exp));
          return (over) => services(over).publisher.stop({ actorId: ACTOR, pageId });
        },
      },
      {
        name: "changeDestination",
        prepare: async () => {
          const handle = `atomic-move-${randomUUID().slice(0, 8)}`;
          const created = await services().connections.createConnection({ actorId: ACTOR, handle, mode: "api", siteUrl: "https://atomic-move.example.net" });
          if (!created.ok) throw new Error(created.reason);
          const { pageId } = await readyPage();
          await services().publisher.publish(input(pageId, EXP, SETTINGS.exp));
          return (over) => services(over).publisher.changeDestination(input(pageId, { dest: "site", handle }, SETTINGS.site));
        },
      },
      {
        name: "disconnect",
        prepare: async () => {
          const handle = `atomic-${randomUUID().slice(0, 8)}`;
          const created = await services().connections.createConnection({ actorId: ACTOR, handle, mode: "api", siteUrl: "https://atomic.example.net" });
          if (!created.ok) throw new Error(created.reason);
          const { pageId } = await readyPage();
          await services().publisher.publish(input(pageId, { dest: "site", handle }, SETTINGS.site));
          return (over) => services(over).connections.disconnect({ actorId: ACTOR, connectionId: created.connection.id });
        },
      },
      {
        name: "rotateKey",
        prepare: async () => {
          const handle = `atomic-${randomUUID().slice(0, 8)}`;
          const created = await services().connections.createConnection({ actorId: ACTOR, handle, mode: "api", siteUrl: "https://atomic.example.net" });
          if (!created.ok) throw new Error(created.reason);
          return (over) => services(over).connections.rotateKey({ actorId: ACTOR, connectionId: created.connection.id });
        },
      },
    ];

    it.each(operations.map((operation) => [operation.name, operation] as const))("%s: a failure at any store call changes nothing", async (_name, operation) => {
      const run = await operation.prepare();
      // k 番目の呼び出しで落とす。落とす前に操作が終わったら（呼び出しが k より少ない）、それが失敗なしの成功
      for (let k = 1; ; k += 1) {
        expect(k, "the operation must finish").toBeLessThan(60);
        const before = await dump();
        const broken = faulty((_name, index) => index === k);
        const result = await run(broken);
        if (broken.calls.length < k) {
          expect(result.ok, `success after ${k - 1} faults`).toBe(true);
          expect(k).toBeGreaterThan(3);
          break;
        }
        expect(result, `call ${k} (${broken.calls[k - 1]})`).toEqual({ ok: false, reason: "failed", retryable: true });
        expect(await dump(), `call ${k} (${broken.calls[k - 1]})`).toBe(before);
      }
    });
  });

  describe("concurrency", () => {
    /** n 本がそろうまで待つ（そろわなければ 2 秒で先へ進む）。 */
    function barrier(n: number): () => Promise<void> {
      let arrived = 0;
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return async () => {
        arrived += 1;
        if (arrived >= n) open();
        await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      };
    }

    /** takenSlugs を読んだあとで、もう一方の transaction も読み終わるまで待たせる。 */
    function racing(wait: () => Promise<void>): ConnectionStore {
      return {
        transaction: (work) =>
          store.transaction((tx) =>
            work({
              ...tx,
              takenSlugs: async (...args: Parameters<ConnectionTx["takenSlugs"]>) => {
                const taken = await tx.takenSlugs(...args);
                await wait();
                return taken;
              },
            }),
          ),
      };
    }

    it("two pages publishing the same slug at once: one wins, the other fails and is never doubled", async () => {
      const a = await readyPage();
      const b = await readyPage();
      const slug = `race-x${randomUUID().slice(0, 8)}`;
      const wait = barrier(2);
      const results: PublishResult[] = await Promise.all([
        services(racing(wait)).publisher.publish(input(a.pageId, EXP, SETTINGS.exp, { slug })),
        services(racing(wait)).publisher.publish(input(b.pageId, EXP, SETTINGS.exp, { slug })),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "failed", retryable: true }]);
      const rows = await pool.query<{ page_id: string }>("SELECT page_id FROM publications WHERE handle = 'exp' AND slug = $1", [slug]);
      expect(rows.rows).toHaveLength(1);
      const loser = rows.rows[0]!.page_id === a.pageId ? b.pageId : a.pageId;
      expect(await latestPublicationVersion(pool, loser)).toBe(0);
      // やり直すと、使われている slug として断られる
      expect(await services().publisher.publish(input(loser, EXP, SETTINGS.exp, { slug }))).toEqual({ ok: false, reason: "slug_taken", suggestion: `${slug}-2` });
    });

    it("two key rotations of one connection at once are serialized: the second revokes the first's new key, one key stays active", async () => {
      const handle = `rotate-race-${randomUUID().slice(0, 8)}`;
      const created = await services().connections.createConnection({ actorId: ACTOR, handle, mode: "api", siteUrl: "https://rotate-race.example.net" });
      if (!created.ok) throw new Error(created.reason);
      const connectionId = created.connection.id;
      // 鍵の一覧を読んだあとで、もう一方の transaction も読み終わるまで待たせる（行を押さえていなければ、同じ一覧を読んで両方が通る）
      const wait = barrier(2);
      const waiting: ConnectionStore = {
        transaction: (work) =>
          store.transaction((tx) =>
            work({
              ...tx,
              listKeys: async (id: string) => {
                const keys = await tx.listKeys(id);
                await wait();
                return keys;
              },
            }),
          ),
      };
      const results = await Promise.all([
        services(waiting).connections.rotateKey({ actorId: ACTOR, connectionId }),
        services(waiting).connections.rotateKey({ actorId: ACTOR, connectionId }),
      ]);
      const rotated = results.flatMap((result) => (result.ok ? [result] : []));
      expect(rotated).toHaveLength(2);
      // 先の 1 回が元の鍵を、あとの 1 回が先の 1 回の新しい鍵を失効させる
      expect(rotated.map((result) => result.revoked)).toEqual([1, 1]);
      const view = await services().connections.getConnectionView({ actorId: ACTOR, connectionId });
      expect(view.ok && view.connection.keys.filter((key) => key.active)).toHaveLength(1);
      const { connections } = services();
      const authenticated = await Promise.all(rotated.map((result) => connections.authenticateKey(result.key.plaintext)));
      expect(authenticated.filter((found) => found !== null)).toEqual([{ connectionId, handle }]);
      expect(await connections.authenticateKey(created.key.plaintext)).toBeNull();
    });

    it("two publishes of the same page at once are serialized: both succeed with consecutive versions", async () => {
      const { pageId, slug } = await readyPage();
      const results = await Promise.all([
        services().publisher.publish(input(pageId, EXP, SETTINGS.exp)),
        services().publisher.publish(input(pageId, EXP, SETTINGS.exp)),
      ]);
      expect(results.map((result) => result.ok)).toEqual([true, true]);
      expect((await versionsOf(pageId)).map((version) => version.version)).toEqual([1, 2]);
      expect(await getPublication(pool, pageId)).toMatchObject({ slug, version: 2, stoppedAt: null });
    });
  });
});
