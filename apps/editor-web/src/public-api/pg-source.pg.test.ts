// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import {
  buildSnapshot,
  ConnectionService,
  PublishService,
  connectionSource,
  siteDeclarationSource,
  type ConnectionStore,
  type DraftFingerprints,
  type PlaceInput,
  type PublishResult,
  type PublishSettings,
  type Target,
} from "@niho/editor-publish";
import {
  ManualClock,
  MemoryAssetBytes,
  MemoryAuthors,
  MemoryDeclarations,
  MemoryPublishStore,
  MemoryRoles,
  memoryAssetUrls,
  memoryDraftFingerprints,
} from "@niho/editor-publish/test-support";
import { toReferenceWorld } from "@niho/editor-publish/test-support/reference-world";
import { createReferenceServer, type ReferenceResponse, type ReferenceWorld } from "@niho/editor-publish-contract/test-support";
import { EditorStore } from "@niho/editor-store";
import { applyMigrations } from "@niho/editor-store/migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgDraftFingerprints, pgPublishStore } from "../publish/pg-store";
import { createPublicApi, type PublicApi, type PublicApiRequest } from "./handler";
import { pgPreviewTokenStore, pgPublicApiSource } from "./pg-source";
import { faceCredentialSource, type FaceCredentialEntry } from "./source";
import { worldFaces, worldSource } from "./testing/world-source";

/**
 * 同じ操作（ConnectionService で接続と鍵、PublishService で公開・更新・やめる・発信先の変更・再公開、接続の解除・鍵の再発行）を
 * メモリの store と Postgres の store の両方で行い、公開 API の handler の応答（status・header・本文）が同じことを確かめる。
 * メモリの側は toReferenceWorld → world-source（参照モデルと突き合わせ済みの実装）、Postgres の側は pg-source。
 * 時計は同じ値を両方に渡す。TEST_DATABASE_URL が無ければ skip。値はすべて合成。
 */
const databaseUrl = process.env.TEST_DATABASE_URL;

const ACTOR = "synthetic-api-actor-a";
const OTHER_ACTOR = "synthetic-api-actor-b";
const START = "2026-10-01T09:00:00.000Z";
const LEAD = "Start early, follow the shoreline, and stop for tea.";
const EXP_TOKEN = "st_synthetic-exp-face-token-for-pg-test";
const NIHO_TOKEN = "st_synthetic-niho-face-token-for-pg-test";
const CATEGORY_DISPLAY = { labelEn: "Walks", labelJa: "散策", displayOrder: 2, revision: 5 } as const;

/** packages/editor-publish/fixtures/destinations の exp・niho の写し（src/publish/pg-store.pg.test.ts と同じ）。 */
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

const EXP: Target = { dest: "exp" };
const NIHO: Target = { dest: "niho" };
const ALPHA: Target = { dest: "site", handle: "site-alpha" };
const BETA: Target = { dest: "site", handle: "site-beta" };

const sha256 = (data: string): string => createHash("sha256").update(data).digest("hex");

interface SeedAsset {
  readonly id: string;
  readonly kind: "image" | "audio";
  readonly contentType: string;
  readonly alt: string | null;
  readonly credit: string | null;
  readonly bytes: string;
}

interface SeedPage {
  readonly id: string;
  readonly owner: string;
  readonly title: string;
  readonly cover: SeedAsset;
  readonly figure: SeedAsset;
  readonly audio: SeedAsset;
}

function blocksOf(page: SeedPage, heading = "Getting there"): unknown[] {
  return [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Meet at the " },
        { type: "text", text: "station", marks: [{ type: "bold" }] },
        { type: "text", text: " at 7:00." },
      ],
    },
    { type: "image", attrs: { assetId: page.figure.id, alt: "Fishing boats in the harbor", caption: "The harbor at 7:30" } },
    { type: "recording", attrs: { assetId: page.audio.id } },
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

function seedPage(label: string, owner = ACTOR): SeedPage {
  const asset = (name: string, kind: SeedAsset["kind"], contentType: string, alt: string | null, credit: string | null): SeedAsset => ({
    id: randomUUID(),
    kind,
    contentType,
    alt,
    credit,
    bytes: `synthetic ${name} of ${label}`,
  });
  return {
    id: randomUUID(),
    owner,
    title: `Coastal walk ${label}`,
    cover: asset("cover", "image", "image/jpeg", "Shoreline at sunrise", "Example Photo Studio"),
    figure: asset("figure", "image", "image/webp", "Boats", null),
    audio: asset("audio", "audio", "audio/mp4", null, null),
  };
}

/** 一方の store（メモリか Postgres）とその上のサービス。 */
interface Side {
  readonly name: "memory" | "pg";
  readonly store: ConnectionStore;
  readonly clock: ManualClock;
  readonly publisher: PublishService;
  readonly connections: ConnectionService;
  /** ラベル → その側で発行した鍵の平文。 */
  readonly keys: Map<string, string>;
  readonly connectionIds: Map<string, string>;
  addPage(page: SeedPage): Promise<void>;
  editDraft(page: SeedPage, title: string, heading: string): Promise<void>;
}

function ports(store: ConnectionStore, clock: ManualClock, drafts: DraftFingerprints) {
  const roles = new MemoryRoles();
  roles.set(ACTOR, ["writer"]);
  roles.set(OTHER_ACTOR, ["writer"]);
  const faces = new MemoryDeclarations();
  faces.set("exp", FACE_DECLARATIONS.exp);
  faces.set("niho", FACE_DECLARATIONS.niho);
  const authors = new MemoryAuthors();
  authors.set(ACTOR, { name: "Example Writer", handle: "example-writer", url: "https://writer.example.com/" });
  authors.set(OTHER_ACTOR, { name: "Another Writer", handle: null, url: null });
  const facts = {
    read: async (query: { dest: string }) => query.dest === "exp"
      ? { relatedLive: true, categoryCurrent: true, categoryDisplay: CATEGORY_DISPLAY }
      : { relatedLive: true },
  };
  const publisher = new PublishService({
    store,
    roles,
    storage: { read: async () => "CLOUD" },
    connections: connectionSource(store),
    declarations: siteDeclarationSource(store, faces),
    authors,
    facts,
    assetUrls: memoryAssetUrls(),
    clock,
  });
  const connections = new ConnectionService({ store, clock, drafts, assetBytes: new MemoryAssetBytes() });
  return { publisher, connections };
}

describe.skipIf(databaseUrl === undefined)("public API on PostgreSQL answers like the reference world of the memory store", () => {
  const schema = `editor_public_api_pg_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  function memorySide(): Side & { readonly memory: MemoryPublishStore } {
    const memory = new MemoryPublishStore();
    const clock = new ManualClock(START, 0);
    return {
      name: "memory",
      memory,
      store: memory,
      clock,
      ...ports(memory, clock, memoryDraftFingerprints(memory)),
      keys: new Map(),
      connectionIds: new Map(),
      async addPage(page) {
        memory.putPage({ id: page.id, ownerId: page.owner, title: page.title, lang: "en", lead: LEAD, coverAssetId: page.cover.id, content: blocksOf(page) });
        for (const asset of [page.cover, page.figure, page.audio]) {
          memory.putAsset(page.id, {
            id: asset.id,
            kind: asset.kind,
            bytes: Buffer.byteLength(asset.bytes),
            sha256: sha256(asset.bytes),
            contentType: asset.contentType,
            alt: asset.alt,
            credit: asset.credit,
            consent: true,
          });
        }
      },
      async editDraft(page, title, heading) {
        const current = memory.page(page.id);
        if (!current) throw new Error("no page");
        memory.putPage({ ...current, title, content: blocksOf(page, heading) });
      },
    };
  }

  function pgSide(): Side {
    const store = pgPublishStore(pool);
    const clock = new ManualClock(START, 0);
    const pages = new EditorStore(pool);
    return {
      name: "pg",
      store,
      clock,
      ...ports(store, clock, pgDraftFingerprints(pool)),
      keys: new Map(),
      connectionIds: new Map(),
      async addPage(page) {
        await pool.query("INSERT INTO pages (id, owner, title, lang, lead) VALUES ($1, $2, $3, 'en', $4)", [page.id, page.owner, page.title, LEAD]);
        for (const asset of [page.cover, page.figure, page.audio]) {
          await pool.query(
            `INSERT INTO assets (id, owner, page_id, kind, bucket_path, bytes, sha256, content_type, alt, credit, consent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)`,
            [asset.id, page.owner, page.id, asset.kind, `synthetic/${page.id}/${asset.id}`, Buffer.byteLength(asset.bytes), sha256(asset.bytes), asset.contentType, asset.alt, asset.credit],
          );
        }
        await pool.query("UPDATE pages SET cover = $2, blocks = $3::jsonb WHERE id = $1", [page.id, page.cover.id, JSON.stringify(blocksOf(page))]);
      },
      async editDraft(page, title, heading) {
        const current = await pages.getPage(page.owner, page.id);
        if (!current) throw new Error("no page");
        const saved = await pages.savePage(page.owner, page.id, { title, blocks: blocksOf(page, heading) as never }, { baseRevision: current.revision });
        expect(saved?.status).toBe("saved");
      },
    };
  }

  it("serves the same lists, documents, 410s, credentials and previews after the same operations", async () => {
    const memorySideOf = memorySide();
    const sides: readonly Side[] = [memorySideOf, pgSide()];

    /** 同じ操作を両方で行い、両方の結果が同じ形であることを確かめる。 */
    async function both<T>(label: string, step: (side: Side) => Promise<T>, check: (result: T) => void = () => undefined): Promise<void> {
      for (const side of sides) {
        const result = await step(side);
        try {
          check(result);
        } catch (error) {
          throw new Error(`${label} on ${side.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    const tick = () => sides.forEach((side) => side.clock.advance(60));
    const published = (result: PublishResult) => expect(result.ok, JSON.stringify(result)).toBe(true);
    const place = (pageId: string, target: Target, settings: PublishSettings, actorId = ACTOR): PlaceInput => ({ actorId, pageId, target, settings });

    /**
     * NIHO 面が廃止される前に公開済みだった版のみを明示seedする。新規公開の権限は迂回せず、
     * 正規transactionと buildSnapshot で読み取り／停止の互換性に必要な旧wireだけを作る。
     */
    async function seedLegacyFace(side: Side, page: SeedPage, dest: "exp" | "niho", slug: string, range: "live" | "unlisted" = "live"): Promise<void> {
      const now = side.clock.now();
      const settings = SETTINGS[dest];
      const canonicalUrl = dest === "exp" ? `https://exp.example.com/guides/${slug}` : `https://niho.example.com/article/${slug}`;
      await side.store.transaction(async (tx) => {
        const draft = await tx.getPage(page.id);
        if (!draft) throw new Error("legacy seed page missing");
        const built = await buildSnapshot({
          page: draft,
          assets: await tx.listAssets(page.id),
          dest,
          slug,
          canonicalUrl,
          range,
          extras: settings.extras,
          category: settings.category,
          related: settings.related,
          author: { name: "Example Writer", handle: "example-writer", url: "https://writer.example.com/" },
          version: 1,
          publishedAt: now,
          updatedAt: now,
          assetUrls: memoryAssetUrls(),
        });
        if (!built.ok) throw new Error(`legacy snapshot invalid: ${JSON.stringify(built.issues)}`);
        await tx.addVersion({ pageId: page.id, version: 1, handle: dest, snapshot: built.snapshot });
        await tx.putPublication({
          pageId: page.id,
          dest,
          handle: dest,
          slug,
          range,
          extras: settings.extras,
          category: settings.category,
          related: settings.related,
          version: 1,
          publishedAt: now,
          updatedAt: now,
          stoppedAt: null,
        });
      });
    }

    // 接続と鍵
    await both("connect alpha", async (side) => {
      const created = await side.connections.createConnection({ actorId: ACTOR, handle: "site-alpha", mode: "api", siteUrl: "https://alpha.example.net" });
      if (created.ok) {
        side.keys.set("alpha1", created.key.plaintext);
        side.connectionIds.set("alpha", created.connection.id);
      }
      return created.ok;
    }, (ok) => expect(ok).toBe(true));
    tick();
    await both("connect beta", async (side) => {
      const created = await side.connections.createConnection({ actorId: OTHER_ACTOR, handle: "site-beta", mode: "api", siteUrl: "https://beta.example.net" });
      if (created.ok) {
        side.keys.set("beta1", created.key.plaintext);
        side.connectionIds.set("beta", created.connection.id);
      }
      return created.ok;
    }, (ok) => expect(ok).toBe(true));

    const pages = {
      live1: seedPage("live one"),
      live2: seedPage("live two"),
      live3: seedPage("live three"),
      legacyNihoLive: seedPage("legacy NIHO live"),
      legacyNihoStopped: seedPage("legacy NIHO stopped"),
      unlisted: seedPage("unlisted"),
      stopped: seedPage("stopped"),
      expToSite: seedPage("Experience to site"),
      republished: seedPage("republished"),
      beta: seedPage("beta", OTHER_ACTOR),
      siteToFace: seedPage("site to face"),
      draftOnly: seedPage("draft only"),
    };
    for (const page of Object.values(pages)) await both(`seed ${page.title}`, (side) => side.addPage(page));

    // 公開・更新・やめる・発信先の変更・再公開
    tick();
    await both("publish live1", (side) => side.publisher.publish(place(pages.live1.id, ALPHA, SETTINGS.site)), published);
    tick();
    // 同じ時刻の 2 件（一覧の同時刻は id の昇順）
    await both("publish live2", (side) => side.publisher.publish(place(pages.live2.id, ALPHA, SETTINGS.site)), published);
    await both("publish live3", (side) => side.publisher.publish(place(pages.live3.id, ALPHA, SETTINGS.site)), published);
    tick();
    await both("reject new NIHO publish", (side) => side.publisher.publish(place(pages.legacyNihoLive.id, NIHO, SETTINGS.niho)), (result) => {
      expect(result).toEqual({ ok: false, reason: "forbidden_destination", detail: "role" });
    });
    tick();
    await both("seed legacy NIHO live", (side) => seedLegacyFace(side, pages.legacyNihoLive, "niho", "legacy-niho-live"));
    await both("seed legacy NIHO stopped", (side) => seedLegacyFace(side, pages.legacyNihoStopped, "niho", "legacy-niho-stopped"));
    await both("reject legacy NIHO update", (side) => side.publisher.update(place(pages.legacyNihoLive.id, NIHO, SETTINGS.niho)), (result) => {
      expect(result).toEqual({ ok: false, reason: "forbidden_destination", detail: "role" });
    });
    tick();
    await both("stop legacy NIHO", (side) => side.publisher.stop({ actorId: ACTOR, pageId: pages.legacyNihoStopped.id }), (result) => expect(result.ok).toBe(true));
    tick();
    await both("seed legacy Experience unlisted", (side) => seedLegacyFace(side, pages.unlisted, "exp", "unlisted", "unlisted"));
    tick();
    await both("publish stopped", (side) => side.publisher.publish(place(pages.stopped.id, ALPHA, SETTINGS.site)), published);
    tick();
    await both("stop stopped", (side) => side.publisher.stop({ actorId: ACTOR, pageId: pages.stopped.id }), (result) => expect(result.ok).toBe(true));
    tick();
    await both("seed legacy Experience to site", (side) => seedLegacyFace(side, pages.expToSite, "exp", "experience-to-site"));
    tick();
    await both("move expToSite", (side) => side.publisher.changeDestination(place(pages.expToSite.id, ALPHA, SETTINGS.site)), published);
    tick();
    await both("seed legacy Experience republished", (side) => seedLegacyFace(side, pages.republished, "exp", "republished"));
    tick();
    await both("stop republished", (side) => side.publisher.stop({ actorId: ACTOR, pageId: pages.republished.id }), (result) => expect(result.ok).toBe(true));
    tick();
    await both("reject republish to Experience", (side) => side.publisher.publish(place(pages.republished.id, EXP, SETTINGS.exp)), (result) => {
      expect(result).toEqual({ ok: false, reason: "forbidden_destination", detail: "role" });
    });
    tick();
    await both("publish siteToFace", (side) => side.publisher.publish(place(pages.siteToFace.id, ALPHA, SETTINGS.site)), published);
    tick();
    await both("reject move from site to Experience", (side) => side.publisher.changeDestination(place(pages.siteToFace.id, EXP, SETTINGS.exp)), (result) => {
      expect(result).toEqual({ ok: false, reason: "forbidden_destination", detail: "role" });
    });
    tick();
    // 公開したあとで下書きを直し、更新を公開し、もう一度直す（公開版は追従せず、プレビューは今の下書き）
    await both("edit live1", (side) => side.editDraft(pages.live1, "Coastal walk live one, revised", "How to get there"));
    tick();
    await both("update live1", (side) => side.publisher.update(place(pages.live1.id, ALPHA, SETTINGS.site)), published);
    tick();
    await both("edit live1 again", (side) => side.editDraft(pages.live1, "DRAFT-ONLY unpublished title", "DRAFT-ONLY heading"));
    tick();
    await both("publish beta", (side) => side.publisher.publish(place(pages.beta.id, BETA, SETTINGS.site, OTHER_ACTOR)), published);
    tick();
    // 鍵の再発行（旧鍵は失効）と、接続の解除（鍵の失効と公開の停止）
    await both("rotate alpha", async (side) => {
      const rotated = await side.connections.rotateKey({ actorId: ACTOR, connectionId: side.connectionIds.get("alpha") ?? "" });
      if (rotated.ok) side.keys.set("alpha2", rotated.key.plaintext);
      return rotated.ok;
    }, (ok) => expect(ok).toBe(true));
    tick();
    await both("disconnect beta", (side) => side.connections.disconnect({ actorId: OTHER_ACTOR, connectionId: side.connectionIds.get("beta") ?? "" }), (result) => expect(result.ok).toBe(true));
    tick();

    const now = sides[1]!.clock.now();
    expect(sides[0]!.clock.now()).toBe(now);

    // プレビュー token（Postgres には発行の保存先で、参照の world には同じ行で）
    const previews = {
      live1: { token: `pv_${"L".repeat(42)}A`, pageId: pages.live1.id, handle: "site-alpha", issuedAt: now, expiresAt: new Date(Date.parse(now) + 10 * 60_000).toISOString() },
      unlisted: { token: `pv_${"U".repeat(42)}A`, pageId: pages.unlisted.id, handle: "exp", issuedAt: now, expiresAt: new Date(Date.parse(now) + 15 * 60_000).toISOString() },
      expired: {
        token: `pv_${"E".repeat(42)}A`,
        pageId: pages.live1.id,
        handle: "site-alpha",
        issuedAt: new Date(Date.parse(now) - 20 * 60_000).toISOString(),
        expiresAt: new Date(Date.parse(now) - 5 * 60_000).toISOString(),
      },
    };
    const tokenStore = pgPreviewTokenStore(pool);
    for (const preview of Object.values(previews)) {
      // 参照の world の token は著者を持たないので、ここも著者なし（いまの公開版の著者で組む）
      expect(await tokenStore.issue(ACTOR, { pageId: preview.pageId, handle: preview.handle, sha256: sha256(preview.token), issuedAt: preview.issuedAt, expiresAt: preview.expiresAt, author: null })).toBe(true);
    }
    // 別の人のページ・ゴミ箱のページには発行しない
    expect(await tokenStore.issue(OTHER_ACTOR, { pageId: pages.live1.id, handle: "site-alpha", sha256: sha256("pv_other"), issuedAt: now, expiresAt: previews.live1.expiresAt, author: null })).toBe(false);

    const faceEntries: FaceCredentialEntry[] = [
      { audience: "exp", sha256: sha256(EXP_TOKEN), expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString() },
      { audience: "niho", sha256: sha256(NIHO_TOKEN), expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString() },
    ];

    // メモリの側：参照の world（メモリの store は下書きの版を持たないので、版と保存時刻は Postgres のページの値を写す）
    const base = await toReferenceWorld(memorySideOf.memory, {
      now,
      assetUrls: memoryAssetUrls(),
      faceCredentials: faceEntries.map((entry) => ({ ...entry, revokedAt: null })),
      previewTokens: Object.values(previews).map(({ token, ...row }) => ({ ...row, sha256: sha256(token) })),
    });
    const saved = new Map(
      (await pool.query<{ id: string; revision: number; updated_at: Date }>("SELECT id, revision, updated_at FROM pages")).rows
        .map((row) => [row.id, { revision: row.revision, savedAt: row.updated_at.toISOString() }] as const),
    );
    const world: ReferenceWorld = {
      ...base,
      pages: base.pages.map((page) => {
        const row = saved.get(page.id);
        if (!row) throw new Error("page missing in PostgreSQL");
        return { ...page, draft: { ...page.draft, ...row } };
      }),
    };
    const clock = { now: () => now };
    const memoryApi: PublicApi = createPublicApi({ source: worldSource(world), faces: worldFaces(world), clock });
    const pgApi: PublicApi = createPublicApi({
      source: pgPublicApiSource(pool, { assetUrls: memoryAssetUrls() }),
      faces: faceCredentialSource(faceEntries),
      clock,
    });
    const reference = createReferenceServer(world);

    let compared = 0;
    /** 同じ要求を両方へ（本人のサイトの鍵はその側で発行したもの）。cursor を含まない要求は参照モデルとも突き合わせる。 */
    async function ask(label: string, request: { method?: string; url: string; key?: string; face?: string; headers?: Record<string, string> }) {
      const answers: ReferenceResponse[] = [];
      for (const side of sides) {
        const credential = request.face ?? (request.key ? side.keys.get(request.key) : undefined);
        const message: PublicApiRequest = {
          method: request.method ?? "GET",
          url: request.url,
          headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...request.headers },
          requestId: "req_pg_compare",
        };
        answers.push(await (side.name === "memory" ? memoryApi : pgApi).handle(message));
        // 参照モデルは旧face資格を読めるが、本番handlerは意図的に閉鎖済み。本人サイトだけ契約参照と比較する。
        if (side.name === "memory" && request.face === undefined && !request.url.includes("cursor=") && !(answers[0]?.body ?? "").includes("\"nextCursor\":\"")) {
          const credentialForReference = request.face ?? (request.key ? side.keys.get(request.key) : undefined);
          expect(answers[0], `${label} (reference)`).toEqual(
            await reference.handle({ ...message, headers: { ...(credentialForReference ? { authorization: `Bearer ${credentialForReference}` } : {}), ...request.headers } }),
          );
        }
      }
      expect(answers[1], label).toEqual(answers[0]);
      compared += 1;
      return answers[1]!;
    }
    const body = (response: ReferenceResponse) => JSON.parse(response.body ?? "null") as Record<string, unknown>;

    // 一覧（本人のサイト・面・限定公開の include・cursor の全走査）
    const alphaList = await ask("list alpha", { url: "/v1/site-alpha/published.json", key: "alpha2" });
    expect(alphaList.status).toBe(200);
    const alphaItems = (body(alphaList).items as { id: string; title: string }[]);
    expect(alphaItems.map((item) => item.id).sort()).toEqual([pages.live1.id, pages.live2.id, pages.live3.id, pages.expToSite.id, pages.siteToFace.id].sort());
    expect(alphaList.body).not.toContain("DRAFT-ONLY");
    const walks = [
      ["site-alpha", { key: "alpha2" }, "", 5],
    ] as const;
    for (const [handle, auth, include, expected] of walks) {
      let cursor: string | null = null;
      let pagesWalked = 0;
      do {
        const query: string = `?limit=1${include}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const response = await ask(`walk ${handle}${include} #${pagesWalked}`, { url: `/v1/${handle}/published.json${query}`, ...auth });
        expect(response.status).toBe(200);
        cursor = body(response).nextCursor as string | null;
        pagesWalked += 1;
      } while (cursor !== null && pagesWalked < 20);
      expect(pagesWalked, `${handle}${include}`).toBe(expected);
    }
    expect((await ask("closed Experience list", { url: "/v1/exp/published.json?include=unlisted", face: EXP_TOKEN })).status).toBe(401);
    expect((await ask("closed NIHO list", { url: "/v1/niho/published.json", face: NIHO_TOKEN })).status).toBe(401);
    expect((await ask("site include", { url: "/v1/site-alpha/published.json?include=unlisted", key: "alpha2" })).status).toBe(400);

    // 単体（全ページ × 全 handle）・ETag と 304・HEAD
    const readers = [["site-alpha", { key: "alpha2" }], ["site-beta", { key: "alpha2" }], ["exp", { face: EXP_TOKEN }], ["niho", { face: NIHO_TOKEN }]] as const;
    for (const page of Object.values(pages)) {
      for (const [handle, auth] of readers) {
        const response = await ask(`get ${page.title} on ${handle}`, { url: `/v1/${handle}/published/${page.id}.json`, ...auth });
        if (response.status === 200) {
          await ask(`304 ${page.title} on ${handle}`, { url: `/v1/${handle}/published/${page.id}.json`, ...auth, headers: { "if-none-match": response.headers.etag ?? "" } });
          await ask(`HEAD ${page.title} on ${handle}`, { method: "HEAD", url: `/v1/${handle}/published/${page.id}.json`, ...auth });
        }
      }
    }
    const statusOf = async (handle: string, pageId: string, auth: { key?: string; face?: string }) =>
      (await ask(`status ${handle} ${pageId}`, { url: `/v1/${handle}/published/${pageId}.json`, ...auth }));
    const updated = await statusOf("site-alpha", pages.live1.id, { key: "alpha2" });
    expect(body(updated)).toMatchObject({ title: "Coastal walk live one, revised", version: 2 });
    expect((await statusOf("site-alpha", pages.stopped.id, { key: "alpha2" })).status).toBe(410);
    expect((await statusOf("exp", pages.expToSite.id, { face: EXP_TOKEN })).status).toBe(401);
    expect((await statusOf("niho", pages.legacyNihoLive.id, { face: NIHO_TOKEN })).status).toBe(401);
    const legacyStopped = await statusOf("niho", pages.legacyNihoStopped.id, { face: NIHO_TOKEN });
    expect(legacyStopped.status).toBe(401);
    expect((await statusOf("site-alpha", pages.siteToFace.id, { key: "alpha2" })).status).toBe(200);
    expect((await statusOf("exp", pages.republished.id, { face: EXP_TOKEN })).status).toBe(401);
    expect((await statusOf("exp", pages.draftOnly.id, { face: EXP_TOKEN })).status).toBe(401);

    // 失効・旧鍵・解除した接続の鍵・別の handle
    expect((await ask("old key", { url: "/v1/site-alpha/published.json", key: "alpha1" })).status).toBe(401);
    expect((await ask("disconnected key", { url: "/v1/site-beta/published.json", key: "beta1" })).status).toBe(401);
    expect((await ask("other handle", { url: "/v1/site-beta/published.json", key: "alpha2" })).status).toBe(404);

    // プレビュー（今の下書き。公開版は追従しない）・別の dest の資格・期限切れ
    const preview = await ask("preview live1", { url: `/v1/preview/${previews.live1.token}.json`, key: "alpha2" });
    expect(preview.status).toBe(200);
    expect(body(preview)).toMatchObject({ title: "DRAFT-ONLY unpublished title", preview: { dest: "site", noindex: true }, version: saved.get(pages.live1.id)?.revision });
    expect((await ask("closed Experience preview", { url: `/v1/preview/${previews.unlisted.token}.json`, face: EXP_TOKEN })).status).toBe(401);
    expect((await ask("closed other-face preview", { url: `/v1/preview/${previews.unlisted.token}.json`, face: NIHO_TOKEN })).status).toBe(401);
    expect((await ask("preview expired", { url: `/v1/preview/${previews.expired.token}.json`, key: "alpha2" })).status).toBe(404);

    // token に結んだ著者は、いまの公開版の著者より先に使う（公開・更新が本人のいまの名前で組むのと同じ）。Postgres の側だけ
    const renamed = `pv_${"R".repeat(42)}A`;
    const bound = { name: "Renamed Writer", handle: null, url: null };
    expect(await tokenStore.issue(ACTOR, { pageId: pages.live1.id, handle: "site-alpha", sha256: sha256(renamed), issuedAt: now, expiresAt: previews.live1.expiresAt, author: bound })).toBe(true);
    const renamedPreview = await pgApi.handle({
      method: "GET",
      url: `/v1/preview/${renamed}.json`,
      headers: { authorization: `Bearer ${sides[1]!.keys.get("alpha2")}` },
      requestId: "req_pg_bound_author",
    });
    expect(renamedPreview.status).toBe(200);
    expect(body(renamedPreview)).toMatchObject({ author: bound, canonicalUrl: body(preview).canonicalUrl, title: "DRAFT-ONLY unpublished title" });
    expect(body(preview).author).toMatchObject({ name: "Example Writer" });

    expect(compared).toBeGreaterThan(40);
  }, 60_000);

  it("builds a preview for a handle the page was never published to from the connection or the face's declaration and the token's author", async () => {
    const page = seedPage("never published");
    const side = pgSide();
    await side.addPage(page);
    const created = await side.connections.createConnection({ actorId: ACTOR, handle: "site-gamma", mode: "api", siteUrl: "https://gamma.example.net" });
    if (!created.ok) throw new Error(created.reason);
    const now = "2026-10-01T12:00:00.000Z";
    const clock = { now: () => "2026-10-01T12:01:00.000Z" };
    const writer = { name: "Example Writer", handle: null, url: null };
    const tokens = { site: `pv_${"N".repeat(42)}A`, anonymous: `pv_${"M".repeat(42)}A`, face: `pv_${"F".repeat(42)}A` };
    const issue = (token: string, handle: string, author: typeof writer | null) =>
      pgPreviewTokenStore(pool).issue(ACTOR, { pageId: page.id, handle, sha256: sha256(token), issuedAt: now, expiresAt: "2026-10-01T12:15:00.000Z", author });
    expect(await issue(tokens.site, "site-gamma", writer)).toBe(true);
    expect(await issue(tokens.anonymous, "site-gamma", null)).toBe(true);
    expect(await issue(tokens.face, "exp", writer)).toBe(true);
    const request = (token: string, credential: string) =>
      ({ method: "GET", url: `/v1/preview/${token}.json`, headers: { authorization: `Bearer ${credential}` }, requestId: "req_preview" });
    const faces = new MemoryDeclarations();
    faces.set("exp", FACE_DECLARATIONS.exp);
    const expFace: FaceCredentialEntry = { audience: "exp", sha256: sha256(EXP_TOKEN), expiresAt: "2026-10-01T13:00:00.000Z" };
    const api = createPublicApi({ source: pgPublicApiSource(pool, { assetUrls: memoryAssetUrls(), declarations: faces }), faces: faceCredentialSource([expFace]), clock });

    const response = await api.handle(request(tokens.site, created.key.plaintext));
    expect(response.status).toBe(200);
    const doc = JSON.parse(response.body ?? "null") as Record<string, unknown>;
    expect(doc).toMatchObject({
      id: page.id,
      dest: "site",
      slug: "coastal-walk-never-published",
      canonicalUrl: "https://gamma.example.net/coastal-walk-never-published",
      range: "live",
      author: writer,
      version: 1,
      preview: { expiresAt: "2026-10-01T12:15:00.000Z", dest: "site", noindex: true },
    });
    // 旧面token・資格・宣言が全部残っていても面プレビューは閉じる。
    const face = await api.handle(request(tokens.face, EXP_TOKEN));
    expect(face.status).toBe(401);
    const undeclared = createPublicApi({ source: pgPublicApiSource(pool, { assetUrls: memoryAssetUrls() }), faces: faceCredentialSource([expFace]), clock });
    expect((await undeclared.handle(request(tokens.face, EXP_TOKEN))).status).toBe(401);
    // 著者を結んでいない token は、公開したことも無ければ組めない
    expect((await api.handle(request(tokens.anonymous, created.key.plaintext))).status).toBe(404);
    // 資産の URL が作れないとき（置き場の未設定）は 503（理由は出さない）
    const unwired = createPublicApi({
      source: pgPublicApiSource(pool, { assetUrls: { urlFor: () => { throw new Error("not wired"); } } }),
      faces: faceCredentialSource([]),
      clock,
      onUnexpected: () => undefined,
    });
    expect((await unwired.handle(request(tokens.site, created.key.plaintext))).status).toBe(503);
  });
});
