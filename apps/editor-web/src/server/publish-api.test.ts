import { describe, expect, it } from "vitest";
import type { DraftPage, StorageMode } from "@niho/editor-publish";
import { ManualClock, MemoryPublishStore } from "@niho/editor-publish/test-support";
import type { AuthProvider, Session } from "../auth/types";
import { wirePublishPorts, type PublishWiring } from "../publish/ports";
import type { FetchLike } from "../publish/declarations";
import {
  getPublishSheetRoute,
  placeBodyOf,
  publishRoute,
  selectionQueryOf,
  stopPublishingRoute,
  type PublishApiDeps,
  type PublishSheetDto,
  type PublishedResultDto,
} from "./publish-api";

const ORIGIN = "http://editor.test";
const ME = "user-a";
const OTHER = "user-b";
const PAGE = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const PAGE_2 = "7a1d3b5f-2c4e-4d6f-9a81-0b2c3d4e5f60";
const THEIRS = "8b2e4c6a-3d5f-4e70-8b92-1c3d4e5f6a70";
const MISSING = "9c3f5d7b-4e60-4f81-9ca3-2d4e5f6a7b80";

/** 見出しと段落のある本文（dev の宣言の条件を満たす）。 */
const READY = [
  { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Getting there" }] },
  { type: "paragraph", content: [{ type: "text", text: "Meet at the station at 7:00." }] },
];

function page(id: string, ownerId: string, patch: Partial<DraftPage> = {}): DraftPage {
  return { id, ownerId, title: "Morning walk", lang: "ja", lead: null, coverAssetId: null, content: READY, ...patch };
}

const notUsed = async (): Promise<Response> => {
  throw new Error("the publish APIs never call the login routes");
};

function authAs(session: Session | null): AuthProvider {
  return { mode: "stub", getSession: async () => session, beginLogin: notUsed, completeLogin: notUsed, logout: notUsed };
}

const SESSION: Session = { userId: ME, mode: "stub", profile: { name: "合成の書き手" } };

type WorldOptions = { env?: Record<string, string | undefined>; fetch?: FetchLike; session?: Session | null; ports?: boolean; storage?: StorageMode };

function world(options: WorldOptions = {}) {
  const store = new MemoryPublishStore();
  store.putPage(page(PAGE, ME));
  store.putPage(page(THEIRS, OTHER));
  const clock = new ManualClock("2026-10-31T09:00:00.000Z", 60);
  const env = { EDITOR_AUTH_MODE: "stub", ...options.env };
  const wirings: PublishWiring[] = [];
  const deps: PublishApiDeps = {
    auth: () => authAs(options.session === undefined ? SESSION : options.session),
    ports: (session) => {
      if (options.ports === false) return null;
      const wired = wirePublishPorts(store, session, { env, fetch: options.fetch, clock });
      // 保存先は NIHO から読む（契約が出るまでは UNSET）。テストでは差し替える
      const mode = options.storage;
      const wiring = mode === undefined ? wired : { ...wired, publish: { ...wired.publish, storage: { read: async () => mode } } };
      wirings.push(wiring);
      return wiring;
    },
    env: {},
  };
  return { store, deps, wirings };
}

function request(method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}): Request {
  const sameOrigin: Record<string, string> = method === "GET" ? {} : { origin: ORIGIN };
  const json: Record<string, string> = init.body === undefined ? {} : { "content-type": "application/json" };
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { host: "editor.test", ...sameOrigin, ...json, ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const getSheet = (deps: PublishApiDeps, id = PAGE, query = "", headers: Record<string, string> = {}) =>
  getPublishSheetRoute(request("GET", `/api/pages/${id}/publish${query}`, { headers }), id, deps);
const post = (deps: PublishApiDeps, body: unknown, id = PAGE, headers: Record<string, string> = {}) =>
  publishRoute(request("POST", `/api/pages/${id}/publish`, { body, headers }), id, deps);
const stop = (deps: PublishApiDeps, id = PAGE, headers: Record<string, string> = {}) =>
  stopPublishingRoute(request("POST", `/api/pages/${id}/publish/stop`, { headers }), id, deps);

async function sheetOf(response: Response): Promise<PublishSheetDto> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { sheet: PublishSheetDto }).sheet;
}

async function publishedOf(response: Response): Promise<PublishedResultDto> {
  const body = (await response.json()) as { published?: PublishedResultDto };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.published!;
}

const NONE = { app: false, news: false, xp: false };
const to = (handle: string, extra: Record<string, unknown> = {}) => ({ handle, range: "live", extras: NONE, ...extra });

async function snapshot(response: Response) {
  return { status: response.status, headers: [...response.headers.entries()].sort(), body: await response.text() };
}

describe("公開のシート GET", () => {
  it("選択が無ければ状態と発信先だけ（役割で出せる面。dev の宣言）。条件も主ボタンも無い", async () => {
    const { deps } = world();
    const sheet = await sheetOf(await getSheet(deps));
    expect(sheet.status).toBe("private");
    expect(sheet.publication).toBeNull();
    expect(sheet.selection).toBeNull();
    expect(sheet.destinations.map(({ handle, available, reason, url }) => ({ handle, available, reason, url }))).toEqual([
      { handle: "exp", available: true, reason: null, url: "https://experience.niho.life/guides/morning-walk" },
      { handle: "niho", available: true, reason: null, url: "https://niho.life/article/morning-walk" },
    ]);
    expect(sheet.primary).toBeNull();
    expect(sheet.canStop).toBe(false);
  });

  it("発信先を選ぶと、その宣言で評価し、URL（提案の slug）と主ボタンを返す", async () => {
    const { deps } = world();
    const sheet = await sheetOf(await getSheet(deps, PAGE, "?handle=exp&range=unlisted&extras=app,xp"));
    expect(sheet.selection).toEqual({ handle: "exp", range: "unlisted", extras: { app: true, news: false, xp: true }, slug: null });
    expect(sheet.problems).toEqual([]);
    expect(sheet.url).toBe("https://experience.niho.life/guides/morning-walk");
    expect(sheet.slug).toEqual({ value: "morning-walk", editable: true, error: null });
    expect(sheet.slugPrefix).toBe("https://experience.niho.life/guides/");
    expect(sheet.primary).toBe("publish");
    expect(sheet.extras).toEqual([
      { key: "app", checked: true },
      { key: "news", checked: false },
      { key: "xp", checked: true },
    ]);
  });

  it("条件を満たさなければ problems（直す欄つき）を返し、主ボタンは無い", async () => {
    const { deps, store } = world();
    store.putPage(page(PAGE, ME, { content: [{ type: "paragraph", content: [{ type: "text", text: "Nothing else. [CONFIRM: opening hours]" }] }] }));
    const sheet = await sheetOf(await getSheet(deps, PAGE, "?handle=exp"));
    expect(sheet.problems.map((problem) => [problem.id, problem.fix])).toEqual([
      ["headings", "body"],
      ["no-confirm", "body"],
    ]);
    expect(sheet.primary).toBeNull();
  });

  it("選べない設定（NIHO の「体験ページに載せる」）は selectionError、使えない slug は slug.error", async () => {
    const { deps } = world();
    const extras = await sheetOf(await getSheet(deps, PAGE, "?handle=niho&extras=xp"));
    expect(extras.selectionError).toBe("extras");
    expect(extras.primary).toBeNull();
    const reserved = await sheetOf(await getSheet(deps, PAGE, "?handle=niho&slug=index"));
    expect(reserved.slug).toEqual({ value: "index", editable: true, error: "reserved" });
    expect(reserved.primary).toBeNull();
  });

  it("niho の方式は役割が無く（fail closed）、面は role で選べない", async () => {
    const { deps } = world({ env: { EDITOR_AUTH_MODE: "niho", EDITOR_NIHO_ORIGIN: "https://niho.example.invalid" } });
    const sheet = await sheetOf(await getSheet(deps, PAGE, "?handle=exp"));
    expect(sheet.destinations.map((entry) => [entry.handle, entry.reason])).toEqual([
      ["exp", "role"],
      ["niho", "role"],
    ]);
    expect(sheet.primary).toBeNull();
  });

  it("query の形が違えば 400", async () => {
    const { deps } = world();
    for (const query of ["?handle=Bad_Handle", "?range=public", "?extras=app,email", `?slug=${"a".repeat(201)}`]) {
      expect((await getSheet(deps, PAGE, query)).status, query).toBe(400);
    }
  });
});

describe("公開する・更新を公開・保存・発信先を変える・公開をやめる", () => {
  it("公開する → 公開中。GET は公開版の URL・やめられる。サーバーは公開の前の評価をもう一度する", async () => {
    const { deps } = world();
    const published = await publishedOf(await post(deps, to("niho", { extras: { app: true, news: false, xp: false } })));
    expect(published).toMatchObject({ status: "published", operation: "publish", url: "https://niho.life/article/morning-walk", version: 1 });
    const sheet = await sheetOf(await getSheet(deps));
    expect(sheet.status).toBe("published");
    expect(sheet.publication).toMatchObject({ handle: "niho", dest: "niho", label: "NIHO", slug: "morning-walk", url: "https://niho.life/article/morning-walk", stopped: false });
    expect(sheet.selection).toEqual({ handle: "niho", range: "live", extras: { app: true, news: false, xp: false }, slug: null });
    // 公開中で何も変えていなければ、することが無い
    expect(sheet.primary).toBeNull();
    expect(sheet.slug.editable).toBe(false);
    expect(sheet.canStop).toBe(true);
  });

  it("not_ready: 409 と problems・一言。何も書かない", async () => {
    const { deps, store } = world();
    store.putPage(page(PAGE, ME, { content: [{ type: "paragraph", content: [{ type: "text", text: "No headings." }] }] }));
    const before = store.dump();
    const response = await post(deps, to("exp"));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; problems: { id: string }[]; message: string };
    expect(body.error).toBe("not_ready");
    expect(body.problems.map((problem) => problem.id)).toEqual(["headings"]);
    expect(body.message).toBe("公開の前に直すところがあります");
    expect(store.dump()).toBe(before);
  });

  it("本文を直すと「更新あり」→ 更新を公開（同じ URL・版が進む）。設定だけ変えると保存（限定公開）", async () => {
    const { deps, store } = world();
    await publishedOf(await post(deps, to("niho")));
    store.putPage(page(PAGE, ME, { content: [...READY, { type: "paragraph", content: [{ type: "text", text: "Added later." }] }] }));
    const updated = await sheetOf(await getSheet(deps));
    expect(updated.status).toBe("updated");
    expect(updated.primary).toBe("update");
    const update = await publishedOf(await post(deps, to("niho")));
    expect(update).toMatchObject({ operation: "update", status: "published", version: 2, url: "https://niho.life/article/morning-walk" });
    expect((await sheetOf(await getSheet(deps))).status).toBe("published");

    expect((await sheetOf(await getSheet(deps, PAGE, "?handle=niho&range=unlisted&extras="))).primary).toBe("save");
    const save = await publishedOf(await post(deps, to("niho", { range: "unlisted" })));
    expect(save).toMatchObject({ operation: "update", status: "limited", version: 3 });
  });

  it("公開中に別の発信先を選ぶと発信先を変える（NIHO の面の間は旧 URL から転送）", async () => {
    const { deps, store } = world();
    await publishedOf(await post(deps, to("niho")));
    const plan = await sheetOf(await getSheet(deps, PAGE, "?handle=exp"));
    expect(plan.primary).toBe("publish");
    expect(plan.changesDestination).toBe(true);
    const moved = await publishedOf(await post(deps, to("exp")));
    expect(moved).toMatchObject({ operation: "move", url: "https://experience.niho.life/guides/morning-walk" });
    expect(store.redirects().map((redirect) => [redirect.from, redirect.to])).toEqual([[{ handle: "niho", slug: "morning-walk" }, { handle: "exp", slug: "morning-walk" }]]);
    expect(store.publication(PAGE)).toMatchObject({ handle: "exp", stoppedAt: null });
  });

  it("公開をやめる → 公開をやめた（URL は一覧へ転送）。もう一度呼んでも同じ。再公開は同じ URL", async () => {
    const { deps, store } = world();
    await publishedOf(await post(deps, to("niho")));
    const response = await stop(deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: { status: "stopped" } });
    expect((await stop(deps)).status).toBe(200);
    const sheet = await sheetOf(await getSheet(deps));
    expect(sheet.status).toBe("stopped");
    expect(sheet.canStop).toBe(false);
    expect(sheet.primary).toBe("publish");
    expect(store.redirects().map((redirect) => redirect.to)).toEqual(["list"]);
    const again = await publishedOf(await post(deps, to("niho")));
    expect(again).toMatchObject({ operation: "publish", url: "https://niho.life/article/morning-walk" });
  });

  it("公開していないページの「公開をやめる」は 404", async () => {
    const { deps } = world();
    expect((await stop(deps)).status).toBe(404);
  });
});

describe("失敗の応答（reason → HTTP と一言）", () => {
  it("forbidden: 役割の無い面へは 403（role）。GET ではその面が role で選べない", async () => {
    const { deps, store } = world({ env: { EDITOR_STUB_ROLES: "writer" } });
    const before = store.dump();
    const response = await post(deps, to("niho"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden_destination", detail: "role", message: "この発信先に出す役割がありません" });
    expect(store.dump()).toBe(before);
    const sheet = await sheetOf(await getSheet(deps));
    expect(sheet.destinations.find((entry) => entry.handle === "niho")).toMatchObject({ available: false, reason: "role" });
  });

  it("forbidden: 発信先が出していない「あわせて」は 400（extras）", async () => {
    const { deps } = world();
    const response = await post(deps, to("niho", { extras: { app: false, news: false, xp: true } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "forbidden_destination", detail: "extras" });
  });

  it("storage_not_cloud: 保存先がこの Mac だけ・移行中・知らない値なら 403 で何も書かない。シートは主ボタンを出さず storageBlock を返す。クラウドと未選択は公開できる", async () => {
    for (const [storage, block] of [["LOCAL", "LOCAL"], ["CLOSING", "CLOSING"], ["MARS", "unknown"]] as const) {
      const { deps } = world({ storage: storage as StorageMode });
      const sheet = await sheetOf(await getSheet(deps, PAGE, "?handle=niho"));
      expect(sheet.storageBlock, storage).toBe(block);
      expect(sheet.primary).toBeNull();
      const response = await post(deps, to("niho"));
      expect(response.status, storage).toBe(403);
      expect(await response.json()).toEqual({ error: "storage_not_cloud", detail: block, message: "保存先が NIHO クラウドではないので、公開できません（公開は保存先がクラウドのときだけです）" });
      // 何も書いていない
      expect((await sheetOf(await getSheet(deps))).publication, storage).toBeNull();
    }
    for (const storage of ["CLOUD", "UNSET"] as const) {
      const { deps } = world({ storage });
      expect((await sheetOf(await getSheet(deps, PAGE, "?handle=niho"))).storageBlock, storage).toBeNull();
      expect((await post(deps, to("niho"))).status, storage).toBe(200);
    }
  });

  it("slug_taken: 409 と提案。GET でもその slug は slug_taken", async () => {
    const { deps, store } = world();
    store.putPage(page(PAGE_2, ME));
    await publishedOf(await post(deps, to("niho")));
    const sheet = await sheetOf(await getSheet(deps, PAGE_2, "?handle=niho&slug=morning-walk"));
    expect(sheet.slug.error).toBe("slug_taken");
    // 提案は空いている slug
    expect((await sheetOf(await getSheet(deps, PAGE_2, "?handle=niho"))).slug.value).toBe("morning-walk-2");
    const response = await post(deps, to("niho", { slug: "morning-walk" }), PAGE_2);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "slug_taken", suggestion: "morning-walk-2", message: "この URL は使われています（morning-walk-2 なら使えます）" });
  });

  it("invalid_slug は 400、slug_locked（公開したあとの URL の変更）は 409", async () => {
    const { deps } = world();
    const invalid = await post(deps, to("niho", { slug: "Morning Walk" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid_slug", detail: "format", message: "URL は半角の英小文字・数字と、間のハイフンだけで書いてください" });
    await publishedOf(await post(deps, to("niho", { slug: "first-walk" })));
    const locked = await post(deps, to("niho", { slug: "second-walk" }));
    expect(locked.status).toBe(409);
    expect(await locked.json()).toEqual({ error: "slug_locked", slug: "first-walk", message: "公開したあとは URL を変えられません" });
  });

  it("destination_unavailable: 宣言が読めない面は 503「いまは公開できません」。GET では unavailable", async () => {
    const fetch: FetchLike = async () => new Response("nope", { status: 500 });
    const { deps } = world({ env: { EDITOR_DESTINATION_DECLARATIONS: JSON.stringify({ exp: "https://decl.example.com/exp.json" }) }, fetch });
    const sheet = await sheetOf(await getSheet(deps));
    expect(sheet.destinations.map((entry) => [entry.handle, entry.reason])).toEqual([
      ["exp", "unavailable"],
      ["niho", "unavailable"],
    ]);
    const response = await post(deps, to("exp"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "destination_unavailable", message: "いまは公開できません" });
  });

  it("failed: store の途中の失敗は 503（もう一度）。前の公開版と下書きはそのまま", async () => {
    const { deps, store } = world();
    await publishedOf(await post(deps, to("niho")));
    store.putPage(page(PAGE, ME, { title: "Morning walk, revised" }));
    const before = store.dump();
    store.failOnCall(4);
    const response = await post(deps, to("niho"));
    store.failOnCall(null);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "failed", retryable: true, message: "公開できませんでした。前の公開版と下書きはそのままです。もう一度お試しください" });
    expect(store.dump()).toBe(before);
  });

  it("写真のあるページは EDITOR_ASSET_ORIGIN が無いと、もう一度とは言わない失敗（422）。シートでは先に押せない。あれば その origin の URL で公開版を作る", async () => {
    const image = { type: "image", attrs: { assetId: "asset-photo-01", alt: "Boats", caption: null } };
    const photo = { id: "asset-photo-01", kind: "image", bytes: 1000, sha256: "b".repeat(64), contentType: "image/jpeg", alt: "Boats", credit: null, consent: true };
    const missing = world();
    missing.store.putPage(page(PAGE, ME, { content: [...READY, image] }));
    missing.store.putAsset(PAGE, photo);
    const before = missing.store.dump();
    const refused = await post(missing.deps, to("niho"));
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({
      error: "failed",
      retryable: false,
      detail: "photos_unavailable",
      message: "写真の置き場所がまだ設定されていないので、写真のあるページは公開できません",
    });
    expect(missing.store.dump()).toBe(before);
    const blocked = await sheetOf(await getSheet(missing.deps, PAGE, "?handle=niho"));
    expect(blocked.problems.map((problem) => problem.id)).toEqual(["photos-unavailable"]);
    expect(blocked.primary).toBeNull();
    // カバー写真だけでも同じ
    missing.store.putPage(page(PAGE, ME, { coverAssetId: "asset-photo-01" }));
    expect((await post(missing.deps, to("niho"))).status).toBe(422);
    // 写真の無いページは出せる
    missing.store.putPage(page(PAGE, ME));
    expect((await post(missing.deps, to("niho"))).status).toBe(200);

    const set = world({ env: { EDITOR_ASSET_ORIGIN: "https://assets.example.com" } });
    set.store.putPage(page(PAGE, ME, { content: [...READY, image] }));
    set.store.putAsset(PAGE, photo);
    await publishedOf(await post(set.deps, to("niho")));
    const [version] = set.store.versions(PAGE);
    expect(version!.snapshot.assets.map((asset) => asset.url)).toEqual([`https://assets.example.com/assets/${"b".repeat(64)}.jpg`]);
  });
});

describe("本人だけ・同じ origin・DB", () => {
  const ROUTES: Array<[string, (deps: PublishApiDeps, id: string, headers?: Record<string, string>) => Promise<Response>]> = [
    ["GET", (deps, id, headers) => getSheet(deps, id, "", headers)],
    ["POST publish", (deps, id, headers) => post(deps, to("niho"), id, headers)],
    ["POST stop", (deps, id, headers) => stop(deps, id, headers)],
  ];

  it("未ログインは 401。ポートを作らない", async () => {
    for (const [name, call] of ROUTES) {
      const { deps, wirings } = world({ session: null });
      const response = await call(deps, PAGE);
      expect(response.status, name).toBe(401);
      expect(wirings, name).toEqual([]);
    }
  });

  it("他人のページ・無いページ・不正な id は同じ 404（本文・header とも）。他人のページは変えない", async () => {
    for (const [name, call] of ROUTES) {
      const { deps, store } = world();
      const before = store.dump();
      const responses = [await call(deps, THEIRS), await call(deps, MISSING), await call(deps, "not-a-uuid")];
      const [theirs, missing, invalid] = await Promise.all(responses.map(snapshot));
      expect(theirs!.status, name).toBe(404);
      expect(missing, name).toEqual(theirs);
      expect(invalid, name).toEqual(theirs);
      expect(store.dump(), name).toBe(before);
    }
  });

  it("更新系は同じ origin の画面からだけ（Origin が無い・違う・null は 403）。GET は Origin を見ない", async () => {
    for (const [name, call] of ROUTES.slice(1)) {
      const { deps, store } = world();
      const before = store.dump();
      for (const origin of ["https://evil.example.com", "null"]) {
        const response = await call(deps, PAGE, { origin });
        expect(response.status, `${name} ${origin}`).toBe(403);
        expect(await response.json()).toEqual({ error: "forbidden" });
      }
      expect(store.dump(), name).toBe(before);
    }
    const { deps } = world();
    expect((await getSheet(deps, PAGE, "", { origin: "https://evil.example.com" })).status).toBe(200);
  });

  it("DB が使えないときは 503", async () => {
    for (const [name, call] of ROUTES) {
      const { deps } = world({ ports: false });
      expect((await call(deps, PAGE)).status, name).toBe(503);
    }
  });

  it("本文の形が違えば 400（知らない key・型・長すぎる slug）", async () => {
    const { deps } = world();
    for (const body of [null, [], { handle: "niho" }, { ...to("niho"), category: "x" }, to("niho", { extras: { app: "yes", news: false, xp: false } }), to("niho", { slug: "a".repeat(201) }), to("Not A Handle")]) {
      expect((await post(deps, body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("入力の読み取り", () => {
  it("selectionQueryOf: 空の extras は「なし」、空の slug は空のまま（URL を入れてくださいの評価になる）", () => {
    expect(selectionQueryOf(new URLSearchParams("handle=niho&extras=&slug="))).toEqual({ ok: true, value: { handle: "niho", extras: NONE, slug: "" } });
    expect(selectionQueryOf(new URLSearchParams(""))).toEqual({ ok: true, value: {} });
  });

  it("placeBodyOf: 接続した本人のサイトの handle も受ける。slug は省ける", () => {
    expect(placeBodyOf({ handle: "field-notes", range: "live", extras: NONE })).toEqual({ ok: true, value: { handle: "field-notes", range: "live", extras: NONE, slug: null } });
  });
});
