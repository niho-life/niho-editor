import { MASKED_KEY_PREFIX, isConnectionKey } from "@niho/editor-publish-contract";
import { ConnectionService, PublishService, connectionSource, deriveStatus, siteDeclarationSource, type DraftPage } from "@niho/editor-publish";
import {
  ManualClock,
  MemoryAssetBytes,
  MemoryAuthors,
  MemoryDeclarations,
  MemoryFacts,
  MemoryPublishStore,
  MemoryRoles,
  MemoryStorageMode,
  memoryAssetUrls,
  memoryDraftFingerprints,
} from "@niho/editor-publish/test-support";
import { describe, expect, it } from "vitest";
import type { AuthProvider } from "../auth/types";
import { DESTINATION_MESSAGES } from "../publish/messages";
import type { PublishWiring } from "../publish/ports";
import {
  createDestination,
  disconnectDestination,
  exportDestination,
  listDestinations,
  readDestination,
  rotateDestinationKey,
  updateDestination,
  type ConnectionsApiDeps,
  type DestinationsDto,
  type LivePublishedCounter,
  type IssuedKeyDto,
  type SiteDestinationDto,
  type SiteDetailDto,
} from "./connections-api";

/**
 * 発信先の設定の route（#41）。受入の 2 つ（鍵を再発行すると旧鍵で読めない／接続を解除すると公開中のページは
 * 「公開をやめた」になる）を、**route を通して**確かめる。公開 API 側の検証との突き合わせは、
 * `authenticateKey`（公開 API の `siteHandleByKeyHash` と同じ条件＝失効していない鍵・解除されていない接続）で見る。
 * 実 PostgreSQL と公開 API v1 の handler まで通した確認は `connections-api.pg.test.ts`。
 */

const ORIGIN = "http://editor.test";
// 合成の値だけを使う（鍵はサービスが実行時に作る）
const ACTOR = "synthetic-owner-a";
const OTHER = "synthetic-owner-b";
const PAGE_ID = "11111111-2222-4333-8444-555555555555";
const HANDLE = "mika-sato";

const FACE_EXP = {
  schemaVersion: 1,
  id: "exp",
  label: "NIHO Experience",
  host: "exp.example.com",
  path: "guides",
  ranges: ["live", "unlisted"],
  extras: ["app", "news", "xp"],
  accepts: { blocks: ["paragraph", "heading"], marks: ["bold"] },
  requires: [],
};

const notUsed = async (): Promise<Response> => {
  throw new Error("the destinations API never calls the login routes");
};

function authAs(userId: string | null): AuthProvider {
  return {
    mode: "stub",
    getSession: async () => (userId ? { userId, mode: "stub", profile: { name: "Example Writer" } } : null),
    beginLogin: notUsed,
    completeLogin: notUsed,
    logout: notUsed,
  };
}

const PHOTO_ID = "22222222-3333-4444-8555-666666666666";
const PHOTO_SHA = "a".repeat(64);

function page(id: string, owner: string, photo = false): DraftPage {
  const body: unknown[] = [{ type: "paragraph", content: [{ type: "text", text: "Meet at the station at 7:00." }] }];
  if (photo) body.push({ type: "image", attrs: { assetId: PHOTO_ID, alt: "Fishing boats in the harbor", caption: "The harbor at 7:30" } });
  return {
    id,
    ownerId: owner,
    title: "Coastal walk",
    lang: "en",
    lead: "Start early and follow the shoreline.",
    coverAssetId: null,
    content: { type: "doc", content: body },
  };
}

const OTHER_PAGE_ID = "33333333-4444-4555-8666-777777777777";

function world({ photo = false }: { photo?: boolean } = {}) {
  const store = new MemoryPublishStore();
  store.putPage(page(PAGE_ID, ACTOR, photo));
  store.putPage(page(OTHER_PAGE_ID, OTHER));
  if (photo) {
    store.putAsset(PAGE_ID, { id: PHOTO_ID, kind: "image", bytes: 12, sha256: PHOTO_SHA, contentType: "image/jpeg", alt: "Fishing boats in the harbor", credit: null, consent: true });
  }
  const clock = new ManualClock("2026-10-01T09:00:00.000Z", 60);
  const roles = new MemoryRoles();
  roles.set(ACTOR, ["writer"]);
  roles.set(OTHER, ["writer"]);
  const faces = new MemoryDeclarations();
  faces.set("exp", FACE_EXP);
  const authors = new MemoryAuthors();
  authors.set(ACTOR, { name: "Example Writer", handle: null, url: null });
  authors.set(OTHER, { name: "Another Writer", handle: null, url: null });
  const storage = new MemoryStorageMode();
  const wiring: PublishWiring = {
    publish: {
      store,
      roles,
      storage,
      connections: connectionSource(store),
      declarations: siteDeclarationSource(store, faces),
      authors,
      facts: new MemoryFacts(),
      assetUrls: memoryAssetUrls(),
      clock,
    },
    connections: { store, clock, drafts: memoryDraftFingerprints(store), assetBytes: new MemoryAssetBytes() },
    photosReady: true,
  };
  const service = new ConnectionService(wiring.connections);
  const publisher = new PublishService(wiring.publish);
  /**
   * 本物の `countLivePublishedByHandle` と同じ決まり: handle だけでなく**ページの owner でも絞る**
   * （面の handle は全員で共有するので、handle だけで数えると他の人の公開が見える）。
   */
  const counts: LivePublishedCounter = async (owner, handles) => {
    const state = store.snapshotState();
    const wanted = [...new Set(handles)];
    const result = new Map<string, number>(wanted.map((handle) => [handle, 0]));
    for (const [pageId, publication] of Object.entries(state.publications)) {
      if (publication.stoppedAt !== null || !result.has(publication.handle)) continue;
      if (state.pages[pageId]?.ownerId !== owner) continue;
      result.set(publication.handle, (result.get(publication.handle) ?? 0) + 1);
    }
    return result;
  };
  const deps: ConnectionsApiDeps = {
    auth: () => authAs(ACTOR),
    ports: () => wiring,
    counts: () => counts,
    exportAssets: () => ({ port: new MemoryAssetBytes(), exceeded: () => false }),
  };
  return { store, wiring, service, publisher, deps, faces, roles };
}

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = {
    method,
    headers: { host: "editor.test", ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }), ...headers },
  };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, init);
}

const list = (deps: ConnectionsApiDeps) => listDestinations(request("GET", "/api/destinations"), deps);
const create = (body: unknown, deps: ConnectionsApiDeps, headers?: Record<string, string>) =>
  createDestination(request("POST", "/api/destinations", body, headers), deps);
const read = (id: string, deps: ConnectionsApiDeps) => readDestination(request("GET", `/api/destinations/${id}`), id, deps);
const patch = (id: string, body: unknown, deps: ConnectionsApiDeps, headers?: Record<string, string>) =>
  updateDestination(request("PATCH", `/api/destinations/${id}`, body, headers), id, deps);
const rotate = (id: string, deps: ConnectionsApiDeps, headers?: Record<string, string>) =>
  rotateDestinationKey(request("POST", `/api/destinations/${id}/key`, undefined, headers), id, deps);
const disconnect = (id: string, deps: ConnectionsApiDeps, headers?: Record<string, string>) =>
  disconnectDestination(request("POST", `/api/destinations/${id}/disconnect`, undefined, headers), id, deps);
const exportZip = (id: string, deps: ConnectionsApiDeps) => exportDestination(request("GET", `/api/destinations/${id}/export`), id, deps);

const SITE = { handle: HANDLE, mode: "api" as const, siteUrl: "https://mika-sato.example", urlShape: { host: "mika-sato.example", path: "posts" } };

async function connect(deps: ConnectionsApiDeps, body: unknown = SITE): Promise<{ site: SiteDestinationDto; key: IssuedKeyDto }> {
  const response = await create(body, deps);
  expect(response.status).toBe(201);
  return (await response.json()) as { site: SiteDestinationDto; key: IssuedKeyDto };
}

/** 本人のサイトへ 1 ページ公開する（route ではなく PublishService で。ここで確かめるのは発信先の設定の側）。 */
async function publish(publisher: PublishService): Promise<void> {
  const result = await publisher.publish({
    actorId: ACTOR,
    pageId: PAGE_ID,
    target: { dest: "site", handle: HANDLE },
    settings: { range: "live", extras: { app: false, news: false, xp: false }, category: null, related: [] },
    slug: "coastal-walk",
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

describe("GET /api/destinations", () => {
  it("answers 401 without a session and 503 without a database", async () => {
    const { deps } = world();
    expect((await list({ ...deps, auth: () => authAs(null) })).status).toBe(401);
    expect((await list({ ...deps, ports: () => null })).status).toBe(503);
  });

  it("passes the current request headers to the publish wiring", async () => {
    const { deps, wiring } = world();
    let seen: string | null = null;
    const current = request("GET", "/api/destinations", undefined, { "x-synthetic-request": "current" });
    const response = await listDestinations(current, {
      ...deps,
      ports: (_session, sessionRequest) => {
        seen = sessionRequest.headers.get("x-synthetic-request");
        return wiring;
      },
    });
    expect(response.status).toBe(200);
    expect(seen).toBe("current");
  });

  it("never lists legacy operated faces, while keeping personal-site modes", async () => {
    const { deps } = world();
    const body = (await (await list(deps)).json()) as { destinations: DestinationsDto };
    expect(body.destinations.faces).toEqual([]);
    expect(body.destinations.sites).toEqual([]);
    expect(body.destinations.modes).toEqual(["api", "wordpress", "ghost"]);
  });

  it("keeps personal sites available without reading legacy roles or declarations", async () => {
    const { deps, wiring } = world();
    await connect(deps);
    const closedFaces: PublishWiring = {
      ...wiring,
      publish: { ...wiring.publish, roles: { read: async () => { throw new Error("synthetic upstream failure"); } } },
    };
    const response = await list({ ...deps, ports: () => closedFaces });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { destinations: DestinationsDto };
    expect(body.destinations.faces).toEqual([]);
    expect(body.destinations.sites.map((site) => site.handle)).toEqual([HANDLE]);
  });

  it("counts the pages published on each destination, and never lists a removed connection", async () => {
    const { deps, publisher } = world();
    const { site } = await connect(deps);
    await publish(publisher);
    const withPage = (await (await list(deps)).json()) as { destinations: DestinationsDto };
    expect(withPage.destinations.sites.map((entry) => [entry.handle, entry.published])).toEqual([[HANDLE, 1]]);

    expect((await disconnect(site.id, deps)).status).toBe(200);
    const after = (await (await list(deps)).json()) as { destinations: DestinationsDto };
    expect(after.destinations.sites).toEqual([]);
  });

  it("refuses new Experience publication even when legacy role and declaration data remain", async () => {
    const { deps, publisher } = world();
    const result = await publisher.publish({
      actorId: ACTOR,
      pageId: PAGE_ID,
      target: { dest: "exp" },
      settings: { range: "live", extras: { app: false, news: false, xp: false }, category: null, related: [] },
      slug: "coastal-walk",
    });
    expect(result).toMatchObject({ ok: false, reason: "forbidden_destination" });
    const body = (await (await list(deps)).json()) as { destinations: DestinationsDto };
    expect(body.destinations.faces).toEqual([]);
  });

  it("answers 503 when the counts cannot be read", async () => {
    const { deps } = world();
    expect((await list({ ...deps, counts: () => null })).status).toBe(503);
  });

  it("never lists another person's connection", async () => {
    const { deps } = world();
    await connect(deps);
    const other = (await (await list({ ...deps, auth: () => authAs(OTHER) })).json()) as { destinations: DestinationsDto };
    expect(other.destinations.sites).toEqual([]);
  });
});

describe("POST /api/destinations", () => {
  it("creates the connection and hands back the plaintext key exactly once", async () => {
    const { deps } = world();
    const { site, key } = await connect(deps);
    expect(isConnectionKey(key.plaintext)).toBe(true);
    expect(key.masked.startsWith(MASKED_KEY_PREFIX)).toBe(true);
    expect(key.masked.endsWith(key.plaintext.slice(-4))).toBe(true);
    expect(site).toMatchObject({
      handle: HANDLE,
      mode: "api",
      articleUrl: "https://mika-sato.example/posts/{slug}",
      apiUrl: `https://api.editor.niho.life/v1/${HANDLE}/published.json`,
      assetPolicy: "copy-on-import",
      pushEnabled: false,
    });
    // 伏せ字だけ（平文もハッシュも入らない）
    expect(site.keys.map((entry) => entry.masked)).toEqual([key.masked]);
    const later = await read(site.id, deps);
    const detail = (await later.json()) as SiteDetailDto;
    expect(JSON.stringify(detail)).not.toContain(key.plaintext);
    expect(JSON.stringify(detail)).not.toContain("sha256");
  });

  it("refuses the reserved handles, a used handle, a bad mode and a non-https site URL", async () => {
    const { deps } = world();
    await connect(deps);
    for (const body of [
      { ...SITE, handle: "exp" },
      { ...SITE, handle: "API" },
      { ...SITE, handle: "a" },
      { ...SITE, mode: "atom" },
      { ...SITE, siteUrl: "http://mika-sato.example" },
      { ...SITE, urlShape: { host: "mika-sato.example", path: "/posts" } },
      { ...SITE, nope: 1 },
    ]) {
      const response = await create(body, deps);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const taken = await create(SITE, deps);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "handle_taken", message: DESTINATION_MESSAGES.handle_taken });
  });

  it("refuses a request from another origin before reading the body", async () => {
    const { deps } = world();
    expect((await create(SITE, deps, { origin: "http://evil.test" })).status).toBe(403);
    expect((await create(SITE, deps, { origin: "null" })).status).toBe(403);
    expect((await (await list(deps)).json() as { destinations: DestinationsDto }).destinations.sites).toEqual([]);
  });

  it("defaults the URL shape to the site's host with no path", async () => {
    const { deps } = world();
    const { site } = await connect(deps, { handle: HANDLE, mode: "api", siteUrl: "https://mika-sato.example/blog" });
    expect(site.urlShape).toEqual({ host: "mika-sato.example", path: "" });
    expect(site.articleUrl).toBe("https://mika-sato.example/{slug}");
  });

  it("keeps WordPress and Ghost as an entry only (送信は動かない)", async () => {
    const { deps } = world();
    const { site } = await connect(deps, { ...SITE, mode: "wordpress" });
    expect(site.mode).toBe("wordpress");
    expect(site.pushEnabled).toBe(false);
  });
});

describe("GET /api/destinations/{id}", () => {
  it("answers the same 404 for another person's connection, an unknown id and a malformed id", async () => {
    const { deps } = world();
    const { site } = await connect(deps);
    const mine = await read(site.id, deps);
    expect(mine.status).toBe(200);
    const bodies: string[] = [];
    for (const [id, d] of [
      [site.id, { ...deps, auth: () => authAs(OTHER) }],
      ["11111111-2222-4333-8444-999999999999", deps],
      ["not-a-uuid", deps],
      ["", deps],
    ] as const) {
      const response = await read(id, d as ConnectionsApiDeps);
      expect(response.status, id).toBe(404);
      bodies.push(await response.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it("lists the pages published on the connection, with their URL and state", async () => {
    const { deps, publisher } = world();
    const { site } = await connect(deps);
    await publish(publisher);
    const detail = (await (await read(site.id, deps)).json()) as SiteDetailDto;
    expect(detail.site.published).toBe(1);
    expect(detail.published.map((item) => [item.pageId, item.slug, item.url, item.status])).toEqual([
      [PAGE_ID, "coastal-walk", "https://mika-sato.example/posts/coastal-walk", "published"],
    ]);
  });
});

describe("PATCH /api/destinations/{id}", () => {
  it("changes the URL shape, which the next 更新を公開 uses", async () => {
    const { deps } = world();
    const { site } = await connect(deps);
    const response = await patch(site.id, { urlShape: { host: "mika-sato.example", path: "journal" } }, deps);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { site: SiteDestinationDto };
    expect(body.site.articleUrl).toBe("https://mika-sato.example/journal/{slug}");
  });

  it("refuses an empty change, an unknown key, a bad URL and a different handle", async () => {
    const { deps } = world();
    const { site } = await connect(deps);
    for (const body of [{}, { handle: "other-site" }, { siteUrl: "ftp://mika-sato.example" }, { mode: "atom" }, { urlShape: { host: "", path: "" } }]) {
      expect((await patch(site.id, body, deps)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await patch(site.id, { mode: "ghost" }, deps, { origin: "http://evil.test" })).status).toBe(403);
  });

  it("refuses to change a connection that was disconnected", async () => {
    const { deps } = world();
    const { site } = await connect(deps);
    await disconnect(site.id, deps);
    const response = await patch(site.id, { mode: "ghost" }, deps);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "disconnected", message: DESTINATION_MESSAGES.disconnected });
  });
});

describe("受入: 鍵を再発行すると旧鍵で読めない", () => {
  it("rotate のあと、旧鍵は公開 API の検証に通らず、新しい鍵だけが通る", async () => {
    const { deps, service } = world();
    const { site, key } = await connect(deps);
    // 公開 API の検証と同じ条件（失効していない鍵・解除されていない接続）
    expect(await service.authenticateKey(key.plaintext)).toEqual({ connectionId: site.id, handle: HANDLE });

    const response = await rotate(site.id, deps);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { key: IssuedKeyDto; revoked: number; site: SiteDestinationDto };
    expect(body.revoked).toBe(1);
    expect(isConnectionKey(body.key.plaintext)).toBe(true);
    expect(body.key.plaintext).not.toBe(key.plaintext);

    expect(await service.authenticateKey(key.plaintext)).toBeNull();
    expect(await service.authenticateKey(body.key.plaintext)).toEqual({ connectionId: site.id, handle: HANDLE });

    // 画面に残るのは伏せ字だけ。旧鍵の行は失効した印つきで残る
    const detail = (await (await read(site.id, deps)).json()) as SiteDetailDto;
    expect(detail.site.keys.map((entry) => entry.active)).toEqual([true, false]);
    expect(JSON.stringify(detail)).not.toContain(key.plaintext);
  });

  it("rotate は本人・同じ origin・解除されていない接続のときだけ", async () => {
    const { deps } = world();
    const { site } = await connect(deps);
    expect((await rotate(site.id, deps, { origin: "http://evil.test" })).status).toBe(403);
    expect((await rotate(site.id, { ...deps, auth: () => authAs(OTHER) })).status).toBe(404);
    expect((await rotate("not-a-uuid", deps)).status).toBe(404);
    await disconnect(site.id, deps);
    expect((await rotate(site.id, deps)).status).toBe(409);
  });
});

describe("受入: 接続を解除すると公開中のページは「公開をやめた」になる", () => {
  it("解除のあと、ページは stopped・一覧は空・鍵はどれも通らない。ページ自体は残る", async () => {
    const { deps, service, store, publisher } = world();
    const { site, key } = await connect(deps);
    await publish(publisher);
    const rotated = (await (await rotate(site.id, deps)).json()) as { key: IssuedKeyDto };

    const response = await disconnect(site.id, deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revokedKeys: 1, stopped: 1 });

    const publication = store.publication(PAGE_ID);
    expect(publication).not.toBeNull();
    // 公開をやめた記録は残る（deriveStatus は fingerprint も見るので、公開版のものを渡す）
    expect(publication?.stoppedAt).not.toBeNull();
    expect(deriveStatus({ ...publication!, fingerprint: "" }, "different-fingerprint")).toBe("stopped");
    // 下書きも公開版も残る
    expect(store.page(PAGE_ID)).not.toBeNull();
    expect(store.versions(PAGE_ID).length).toBeGreaterThan(0);

    // 公開中の一覧は空（やめたものとしては残る）
    const detail = (await (await read(site.id, deps)).json()) as SiteDetailDto;
    expect(detail.site.published).toBe(0);
    expect(detail.published.map((item) => item.status)).toEqual(["stopped"]);

    for (const plaintext of [key.plaintext, rotated.key.plaintext]) expect(await service.authenticateKey(plaintext)).toBeNull();
  });

  it("もう一度呼んでも同じ結果（0 / 0）で、何も変わらない", async () => {
    const { deps, store } = world();
    const { site } = await connect(deps);
    await disconnect(site.id, deps);
    const dump = store.dump();
    const again = await disconnect(site.id, deps);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ revokedKeys: 0, stopped: 0 });
    expect(store.dump()).toBe(dump);
  });

  it("本人・同じ origin のときだけ", async () => {
    const { deps } = world();
    const { site } = await connect(deps);
    expect((await disconnect(site.id, deps, { origin: "http://evil.test" })).status).toBe(403);
    expect((await disconnect(site.id, { ...deps, auth: () => authAs(OTHER) })).status).toBe(404);
  });
});

describe("GET /api/destinations/{id}/export", () => {
  it("answers a zip of the pages published on the connection, and works after disconnecting", async () => {
    const { deps, publisher } = world();
    const { site } = await connect(deps);
    await publish(publisher);
    const response = await exportZip(site.id, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain(`filename="${HANDLE}-`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    // zip の signature（PK\x03\x04）
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(new TextDecoder().decode(bytes)).toContain("coastal-walk.md");

    await disconnect(site.id, deps);
    expect((await exportZip(site.id, deps)).status).toBe(200);
  });

  it("answers 503 when the photo store is not set up, and 404 for another person's connection", async () => {
    const { deps } = world();
    const { site } = await connect(deps);
    const without = await exportDestination(request("GET", `/api/destinations/${site.id}/export`), site.id, { ...deps, exportAssets: () => null });
    expect(without.status).toBe(503);
    expect(await without.json()).toEqual({ error: "storage_unavailable", message: DESTINATION_MESSAGES.storage_unavailable });
    expect((await exportZip(site.id, { ...deps, auth: () => authAs(OTHER) })).status).toBe(404);
  });

  it("says 大きすぎます instead of a generic failure when the photo budget runs out", async () => {
    const { deps, publisher } = world({ photo: true });
    const { site } = await connect(deps);
    await publish(publisher);
    const exceeded = { ...deps, exportAssets: () => ({ port: { read: async () => null }, exceeded: () => true }) };
    const response = await exportZip(site.id, exceeded);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "export_too_large", message: DESTINATION_MESSAGES.export_too_large });
  });
});

describe("発信先の設定の応答の決まり", () => {
  it("どの応答も鍵・ハッシュを持たず、header は他の API と同じ", async () => {
    const { deps } = world();
    const { site, key } = await connect(deps);
    for (const response of [await list(deps), await read(site.id, deps), await patch(site.id, { mode: "ghost" }, deps)]) {
      const text = await response.text();
      expect(text).not.toContain(key.plaintext);
      expect(text).not.toContain("sha256");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
  });
});
