import { randomUUID } from "node:crypto";
import { PublishService, connectionSource, siteDeclarationSource } from "@niho/editor-publish";
import { ManualClock, MemoryAuthors, MemoryDeclarations, MemoryFacts, MemoryRoles, memoryAssetUrls } from "@niho/editor-publish/test-support";
import { countLivePublishedByHandle } from "@niho/editor-store";
import { applyMigrations } from "@niho/editor-store/migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthProvider } from "../auth/types";
import { pgDraftFingerprints, pgPublishStore } from "../publish/pg-store";
import { pgPublicApiSource } from "../public-api/pg-source";
import { servePublicApi } from "../public-api/http";
import { createFixedWindowLimiter } from "../public-api/rate-limit";
import { NO_FACE_CREDENTIALS } from "../public-api/source";
import { createDestination, disconnectDestination, listDestinations, readDestination, rotateDestinationKey, type ConnectionsApiDeps, type IssuedKeyDto, type SiteDestinationDto, type SiteDetailDto } from "./connections-api";

/**
 * 受入（#41）を、実 PostgreSQL と**公開 API v1 の本物の handler**まで通して確かめる。
 * 「鍵を再発行すると旧鍵で読めない」「接続を解除すると公開中のページは『公開をやめた』になる」は、
 * 発信先の設定の route で操作し、公開 API の側（`pgPublicApiSource` → `site_connection_keys`）で結果を見る。
 * `TEST_DATABASE_URL` が無ければ skip。値はすべて合成（鍵は実行時にサービスが作る）。
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

const ORIGIN = "http://editor.test";
const ACTOR = "synthetic-owner-a";
const OTHER = "synthetic-owner-b";

/** 全員で共有する面の宣言（条件なし。面の handle が owner をまたぐことを確かめるために要る）。 */
const FACE_EXP = {
  schemaVersion: 1,
  id: "exp",
  label: "NIHO Experience",
  host: "exp.example.com",
  path: "guides",
  ranges: ["live", "unlisted"],
  extras: [],
  accepts: { blocks: ["paragraph", "heading"], marks: ["bold"] },
  requires: [],
};
/** handle は誰にも渡らない（解除したあとも使えない）ので、テストごとに別の handle を使う。 */
const site = (handle: string) => ({ handle, mode: "api" as const, siteUrl: "https://mika-sato.example", urlShape: { host: "mika-sato.example", path: "posts" } });

const notUsed = async (): Promise<Response> => {
  throw new Error("the destinations API never calls the login routes");
};

function authAs(userId: string): AuthProvider {
  return {
    mode: "stub",
    getSession: async () => ({ userId, mode: "stub", profile: { name: "Example Writer" } }),
    beginLogin: notUsed,
    completeLogin: notUsed,
    logout: notUsed,
  };
}

function request(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method, headers: { host: "editor.test", ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }) } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

describe.skipIf(databaseUrl === undefined)("発信先の設定の route を PostgreSQL と公開 API v1 で通す", () => {
  const schema = `editor_destinations_pg_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;
  let deps: ConnectionsApiDeps;
  let publisher: PublishService;
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
    const store = pgPublishStore(pool);
    const roles = new MemoryRoles();
    roles.set(ACTOR, ["writer"]);
    roles.set(OTHER, ["writer"]);
    const authors = new MemoryAuthors();
    authors.set(ACTOR, { name: "Example Writer", handle: null, url: null });
    authors.set(OTHER, { name: "Another Writer", handle: null, url: null });
    const faces = new MemoryDeclarations();
    faces.set("exp", FACE_EXP);
    const ports = {
      store,
      roles,
      storage: { read: async () => "CLOUD" as const },
      connections: connectionSource(store),
      declarations: siteDeclarationSource(store, faces),
      authors,
      facts: new MemoryFacts(),
      assetUrls: memoryAssetUrls(),
      clock,
    };
    publisher = new PublishService(ports);
    deps = {
      auth: () => authAs(ACTOR),
      ports: () => ({ publish: ports, connections: { store, clock, drafts: pgDraftFingerprints(pool), assetBytes: { read: async () => null } }, photosReady: false }),
      // 本物の数え方（owner で絞る SQL）をそのまま使う
      counts: () => (owner, handles) => countLivePublishedByHandle(pool, owner, handles),
      exportAssets: () => null,
    };
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  /** 公開 API v1 を本物の handler で読む（データは Postgres。面の資格は無し＝本人のサイトの鍵だけが通る）。 */
  const limiter = createFixedWindowLimiter({ limit: 1000, windowMs: 60_000 });
  function publicApi(path: string, key: string): Promise<Response> {
    return servePublicApi(new Request(`https://api.editor.niho.life${path}`, { headers: { authorization: `Bearer ${key}` } }), {
      source: () => pgPublicApiSource(pool, { assetUrls: memoryAssetUrls(), declarations: { get: async () => null } }),
      faces: () => NO_FACE_CREDENTIALS,
      limiter: () => limiter,
    });
  }

  /** 公開できる下書き（題名ごとに slug が変わる）。 */
  async function readyPage(owner: string = ACTOR): Promise<string> {
    const title = `Coastal walk ${randomUUID().slice(0, 8)}`;
    const created = await pool.query<{ id: string }>(
      "INSERT INTO pages (owner, title, lang, lead, blocks) VALUES ($1, $2, 'en', $3, $4::jsonb) RETURNING id",
      [owner, title, "Start early and follow the shoreline.", JSON.stringify([{ type: "paragraph", content: [{ type: "text", text: "Meet at the station at 7:00." }] }])],
    );
    return created.rows[0]!.id;
  }

  async function connect(handle: string): Promise<{ site: SiteDestinationDto; key: IssuedKeyDto }> {
    const response = await createDestination(request("POST", "/api/destinations", site(handle)), deps);
    expect(response.status).toBe(201);
    return (await response.json()) as { site: SiteDestinationDto; key: IssuedKeyDto };
  }

  async function publish(pageId: string, handle: string, actorId: string = ACTOR): Promise<void> {
    const result = await publisher.publish({
      actorId,
      pageId,
      target: { dest: "site", handle },
      settings: { range: "live", extras: { app: false, news: false, xp: false }, category: null, related: [] },
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
  }

  it("公開中の件数は本人のページだけを数える（全員で共有する面に別のアカウントが公開していても足されない）", async () => {
    // 別のアカウントが exp（全員で共有する面）へ 2 ページ公開する
    for (let i = 0; i < 2; i += 1) {
      const result = await publisher.publish({
        actorId: OTHER,
        pageId: await readyPage(OTHER),
        target: { dest: "exp" },
        settings: { range: "live", extras: { app: false, news: false, xp: false }, category: null, related: [] },
      });
      if (!result.ok) throw new Error(JSON.stringify(result));
    }

    // DB には exp の公開が 2 件ある（handle だけで数えると 2 件に見える）
    const all = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM publications WHERE handle = 'exp' AND stopped_at IS NULL");
    expect(Number(all.rows[0]?.n)).toBe(2);

    // 1 件も公開していない本人には 0 件しか見えない
    const mine = (await (await listDestinations(request("GET", "/api/destinations"), deps)).json()) as { destinations: { faces: { handle: string; published: number }[] } };
    expect(mine.destinations.faces.map((face) => [face.handle, face.published])).toEqual([["exp", 0]]);

    // 本人が 1 件公開すると、自分の 1 件だけが数に入る
    const own = await publisher.publish({
      actorId: ACTOR,
      pageId: await readyPage(),
      target: { dest: "exp" },
      settings: { range: "live", extras: { app: false, news: false, xp: false }, category: null, related: [] },
    });
    if (!own.ok) throw new Error(JSON.stringify(own));
    const after = (await (await listDestinations(request("GET", "/api/destinations"), deps)).json()) as { destinations: { faces: { handle: string; published: number }[] } };
    expect(after.destinations.faces.find((face) => face.handle === "exp")?.published).toBe(1);

    // 別のアカウントから見ても自分の 2 件だけ
    const theirs = (await (await listDestinations(request("GET", "/api/destinations"), { ...deps, auth: () => authAs(OTHER) }).then((response) => response.json())) as { destinations: { faces: { handle: string; published: number }[] } });
    expect(theirs.destinations.faces.find((face) => face.handle === "exp")?.published).toBe(2);

    // 数える SQL そのものも owner ごとに分かれている
    expect((await countLivePublishedByHandle(pool, ACTOR, ["exp", "niho"])).get("exp")).toBe(1);
    expect((await countLivePublishedByHandle(pool, OTHER, ["exp", "niho"])).get("exp")).toBe(2);
    expect((await countLivePublishedByHandle(pool, "synthetic-owner-c", ["exp"])).get("exp")).toBe(0);
  });

  it("鍵を再発行すると、公開 API は旧鍵を 401 にし、新しい鍵だけを通す", async () => {
    const handle = "mika-rotate";
    const { site, key } = await connect(handle);
    const pageId = await readyPage();
    await publish(pageId, handle);

    const list = `/v1/${handle}/published.json`;
    const doc = `/v1/${handle}/published/${pageId}.json`;
    expect((await publicApi(list, key.plaintext)).status).toBe(200);
    expect((await publicApi(doc, key.plaintext)).status).toBe(200);

    const rotated = await rotateDestinationKey(request("POST", `/api/destinations/${site.id}/key`), site.id, deps);
    expect(rotated.status).toBe(200);
    const body = (await rotated.json()) as { key: IssuedKeyDto; revoked: number };
    expect(body.revoked).toBe(1);

    // 失効は次の request から効く（キャッシュしない）
    expect((await publicApi(list, key.plaintext)).status).toBe(401);
    expect((await publicApi(doc, key.plaintext)).status).toBe(401);
    expect((await publicApi(list, body.key.plaintext)).status).toBe(200);
    expect((await publicApi(doc, body.key.plaintext)).status).toBe(200);

    // 画面に残るのは伏せ字だけ
    const detail = (await (await readDestination(request("GET", `/api/destinations/${site.id}`), site.id, deps)).json()) as SiteDetailDto;
    expect(JSON.stringify(detail)).not.toContain(key.plaintext);
    expect(JSON.stringify(detail)).not.toContain(body.key.plaintext);
    expect(detail.site.keys.map((entry) => entry.active)).toEqual([true, false]);
  });

  it("接続を解除すると、公開中のページは公開をやめた状態になり、鍵はどれも 401 になる", async () => {
    const handle = "mika-disconnect";
    const { site, key } = await connect(handle);
    const pageId = await readyPage();
    await publish(pageId, handle);
    const list = `/v1/${handle}/published.json`;
    const doc = `/v1/${handle}/published/${pageId}.json`;
    expect((await publicApi(list, key.plaintext)).status).toBe(200);

    const response = await disconnectDestination(request("POST", `/api/destinations/${site.id}/disconnect`), site.id, deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revokedKeys: 1, stopped: 1 });

    // 鍵はどれも通らない（接続が解除されているので、handle ごと読めない）
    expect((await publicApi(list, key.plaintext)).status).toBe(401);
    expect((await publicApi(doc, key.plaintext)).status).toBe(401);

    // 公開をやめた記録は残り、ページも公開版も残る
    const publication = await pool.query<{ stopped_at: string | null }>("SELECT stopped_at FROM publications WHERE page_id = $1", [pageId]);
    expect(publication.rows[0]?.stopped_at).not.toBeNull();
    const page = await pool.query<{ id: string }>("SELECT id FROM pages WHERE id = $1 AND deleted_at IS NULL", [pageId]);
    expect(page.rows).toHaveLength(1);
    const versions = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM publication_versions WHERE page_id = $1", [pageId]);
    expect(Number(versions.rows[0]?.count)).toBeGreaterThan(0);

    // 設定の画面では「公開をやめた」として出る（公開中は 0）
    const detail = (await (await readDestination(request("GET", `/api/destinations/${site.id}`), site.id, deps)).json()) as SiteDetailDto;
    expect(detail.site.published).toBe(0);
    expect(detail.published.map((item) => item.status)).toEqual(["stopped"]);
  });
});
