import { isConnectionHandle, type FaceDest } from "@niho/editor-publish-contract";
import {
  CONNECTION_MODES,
  ConnectionService,
  FACE_LABELS,
  isConnectionMode,
  isSiteUrl,
  isUrlShape,
  parseDestinationDeclaration,
  roleAllows,
  PUBLISHABLE_FACE_DESTS,
  type ConnectionMode,
  type ConnectionView,
  type ExportArchive,
  type KeyView,
  type PublishedOnConnection,
  type UrlShape,
} from "@niho/editor-publish";
import type { AuthProvider, Session, SessionRequest } from "../auth/types";
import { DESTINATION_MESSAGES } from "../publish/messages";
import type { PublishWiring } from "../publish/ports";
import type { ExportAssetReader } from "../publish/export-assets";
import { errorResponse, guarded, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";

/**
 * 発信先の設定の API（Issue #41。設計 §8・§9、docs/architecture/editor-publish-core.md「#41 発信先の設定」）。
 *
 * 本人のものだけ。未認証は 401、DB が使えないときは 503、別の人の接続・存在しない id・不正な id はどれも同じ 404。
 * 更新系は同じ origin の画面からだけ（違えば 403）。実処理は `@niho/editor-publish` の `ConnectionService`。
 *
 * 鍵の扱い（publication-gates.md の方針）:
 * - 平文の鍵は、作ったときと再発行したときの応答に**その 1 回だけ**入る。保存するのはハッシュと末尾 4 文字だけで、
 *   画面に出るのは `ek_••••••••` ＋末尾 4 文字（`KeyView.masked`）。
 * - 鍵・平文・object の場所をログ・エラーの本文・URL に入れない。失敗は短い code と画面に出す一言だけを返す。
 * - 再発行は旧鍵の失効と同じトランザクションで、次の request から効く（公開 API 側の検証は
 *   `site_connection_keys.revoked_at IS NULL` を見るので、同じ条件で読めなくなる）。
 * - 接続の解除は、鍵の失効・接続の解除・その接続に公開中のページを「公開をやめた」にすることを同じトランザクションで行う。
 *
 * WordPress・Ghost は v1 では入口だけ（`mode` を保存できるが送信は動かない。`pushEnabled` は常に false）。
 */

/**
 * 本人の公開中のページを handle ごとに数える（`countLivePublishedByHandle`）。
 * `publications` の行は handle だけでは本人のものに絞れない（NIHO の面の handle は全員で共有する）ので、
 * **数える側に認証した本人を渡し**、その人のページの公開版だけを数える。
 */
export type LivePublishedCounter = (owner: string, handles: readonly string[]) => Promise<Map<string, number>>;

export type ConnectionsApiDeps = {
  auth: () => AuthProvider;
  /** 本人ごとの公開のポート（src/publish/ports.ts）。DB が使えないときは null（503）。 */
  ports: (session: Session, request: SessionRequest) => PublishWiring | null;
  /** 本人の公開中のページの数。DB が使えないときは null（503）。 */
  counts: () => LivePublishedCounter | null;
  /** 書き出しの写真の読み出し（保存先）。使えないときは null（書き出しは 503）。要求ごとに 1 つ作る（予算を数えるため）。 */
  exportAssets: () => ExportAssetReader | null;
  env?: Readonly<Record<string, string | undefined>>;
};

/** NIHO が運営する面（役割で自動に出る）。`reason` は出せない理由。 */
export type FaceDestinationDto = {
  handle: FaceDest;
  label: string;
  /** 宣言から読んだ URL の形。読めなければ null。 */
  host: string | null;
  path: string | null;
  /** 役割があり、宣言も読めている。 */
  available: boolean;
  /** role＝役割が無い、unavailable＝宣言が無い・読めない。 */
  reason: "role" | "unavailable" | null;
  /** その面に公開中のページの数。 */
  published: number;
};

/** 本人のサイトの接続（鍵は伏せ字だけ）。 */
export type SiteDestinationDto = {
  id: string;
  handle: string;
  mode: ConnectionMode;
  siteUrl: string;
  urlShape: UrlShape;
  /** `https://{host}/{path}/{slug}`（`{slug}` はそのまま）。 */
  articleUrl: string;
  /** 公開 API の一覧の URL。 */
  apiUrl: string;
  assetPolicy: "copy-on-import";
  pushEnabled: false;
  createdAt: string;
  /** 解除した接続は時刻が入る（画面には出さないが、解除の直後の応答に入る）。 */
  removedAt: string | null;
  keys: KeyView[];
  published: number;
};

export type DestinationsDto = { faces: FaceDestinationDto[]; sites: SiteDestinationDto[]; modes: ConnectionMode[] };

export type SiteDetailDto = { site: SiteDestinationDto; published: PublishedOnConnection[] };

/** 新しく作った鍵。平文はこの応答にだけ入る（保存も記録もしない）。 */
export type IssuedKeyDto = { id: string; plaintext: string; masked: string; createdAt: string };

type ConnectionErrorCode =
  | "invalid_handle"
  | "handle_taken"
  | "handle_locked"
  | "invalid_mode"
  | "invalid_site_url"
  | "invalid_url_shape"
  | "disconnected"
  | "export_failed"
  | "export_too_large"
  | "storage_unavailable";

const CONNECTION_STATUS: Record<ConnectionErrorCode, number> = {
  invalid_handle: 400,
  // 他の人が使っている handle（handle は一度決めたら誰にも渡らない）
  handle_taken: 409,
  handle_locked: 409,
  invalid_mode: 400,
  invalid_site_url: 400,
  invalid_url_shape: 400,
  // 解除した接続は設定を変えられない・鍵を出せない
  disconnected: 409,
  // 公開版の写真が読めない・Markdown が契約の形に収まらない（書き出しだけが失敗し、公開版は変わらない）
  export_failed: 502,
  export_too_large: 413,
  storage_unavailable: 503,
};

/** 画面に出す一言（message）を添えて返す。値（鍵・URL・本文）は入れない。 */
function connectionError(code: ConnectionErrorCode): Response {
  return jsonResponse(CONNECTION_STATUS[code], { error: code, message: DESTINATION_MESSAGES[code] });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function siteDto(connection: ConnectionView, published: number): SiteDestinationDto {
  return {
    id: connection.id,
    handle: connection.handle,
    mode: connection.mode,
    siteUrl: connection.siteUrl,
    urlShape: connection.urlShape,
    articleUrl: connection.articleUrl,
    apiUrl: connection.apiUrl,
    assetPolicy: connection.assetPolicy,
    pushEnabled: connection.pushEnabled,
    createdAt: connection.createdAt,
    removedAt: connection.removedAt,
    keys: [...connection.keys],
    published,
  };
}

function issuedKeyDto(key: { id: string; plaintext: string; masked: string; createdAt: string }): IssuedKeyDto {
  return { id: key.id, plaintext: key.plaintext, masked: key.masked, createdAt: key.createdAt };
}

/** 役割と宣言から、NIHO の面の行を作る。役割の無い面の宣言は読まない。 */
async function faceRows(wiring: PublishWiring, actorId: string, counts: Map<string, number>): Promise<FaceDestinationDto[]> {
  let roles: readonly string[];
  try {
    roles = await wiring.publish.roles.read(actorId);
  } catch {
    // 現在の役割を確認できないことは「役割なし」ではない。本人のサイト一覧はこの失敗と独立して返す。
    return PUBLISHABLE_FACE_DESTS.map((handle) => ({
      handle,
      label: FACE_LABELS[handle],
      host: null,
      path: null,
      available: false,
      reason: "unavailable",
      published: counts.get(handle) ?? 0,
    }));
  }
  const rows: FaceDestinationDto[] = [];
  for (const handle of PUBLISHABLE_FACE_DESTS) {
    const allowed = roleAllows(roles, handle);
    const parsed = allowed ? parseDestinationDeclaration(await wiring.publish.declarations.get(handle)) : null;
    const declaration = parsed?.ok ? parsed.value : null;
    rows.push({
      handle,
      label: declaration?.label ?? FACE_LABELS[handle],
      host: declaration?.host ?? null,
      path: declaration?.path ?? null,
      available: declaration !== null,
      reason: !allowed ? "role" : declaration === null ? "unavailable" : null,
      published: counts.get(handle) ?? 0,
    });
  }
  return rows;
}

type CreateInput = { handle: string; mode: ConnectionMode; siteUrl: string; urlShape?: UrlShape };

/** POST の本文（`{ handle, mode, siteUrl, urlShape? }` だけ）。細かい断りは ConnectionService が決める。 */
function parseCreateBody(body: unknown): { ok: true; value: CreateInput } | { ok: false } {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["handle", "mode", "siteUrl", "urlShape"])) return { ok: false };
  if (!isConnectionHandle(body.handle) || !isConnectionMode(body.mode) || !isSiteUrl(body.siteUrl)) return { ok: false };
  if (body.urlShape !== undefined && !isUrlShape(body.urlShape)) return { ok: false };
  const value: CreateInput = { handle: body.handle, mode: body.mode, siteUrl: body.siteUrl };
  if (body.urlShape !== undefined) value.urlShape = { host: body.urlShape.host, path: body.urlShape.path };
  return { ok: true, value };
}

type UpdateInput = { siteUrl?: string; urlShape?: UrlShape; mode?: ConnectionMode };

/** PATCH の本文（`{ siteUrl?, urlShape?, mode? }` だけ。handle は変えられないので受け取らない）。 */
function parseUpdateBody(body: unknown): { ok: true; value: UpdateInput } | { ok: false } {
  if (!isPlainObject(body) || !hasOnlyKeys(body, ["siteUrl", "urlShape", "mode"])) return { ok: false };
  if (Object.keys(body).length === 0) return { ok: false };
  const value: UpdateInput = {};
  if (body.siteUrl !== undefined) {
    if (!isSiteUrl(body.siteUrl)) return { ok: false };
    value.siteUrl = body.siteUrl;
  }
  if (body.urlShape !== undefined) {
    if (!isUrlShape(body.urlShape)) return { ok: false };
    value.urlShape = { host: body.urlShape.host, path: body.urlShape.path };
  }
  if (body.mode !== undefined) {
    if (!isConnectionMode(body.mode)) return { ok: false };
    value.mode = body.mode;
  }
  return { ok: true, value };
}

type Ready = { ok: true; wiring: PublishWiring; actorId: string; counts: LivePublishedCounter } | { ok: false; response: Response };

/** 本人・origin・DB の検査（本文を読む前）。 */
async function ready(request: Request, deps: ConnectionsApiDeps, mutating: boolean): Promise<Ready> {
  const session = await deps.auth().getSession(request);
  if (!session) return { ok: false, response: errorResponse("unauthorized") };
  if (mutating && !isSameOriginRequest(request, deps.env)) return { ok: false, response: errorResponse("forbidden") };
  const wiring = deps.ports(session, request);
  const counts = deps.counts();
  if (!wiring || !counts) return { ok: false, response: errorResponse("unavailable") };
  return { ok: true, wiring, actorId: session.userId, counts };
}

/** `ConnectionService` の断りを応答にする。`not_found` と `failed` は共通の応答。 */
function refusal(reason: string): Response {
  if (reason === "not_found") return notFoundResponse();
  if (reason in CONNECTION_STATUS) return connectionError(reason as ConnectionErrorCode);
  return jsonResponse(500, { error: "failed", message: DESTINATION_MESSAGES.failed });
}

/**
 * 役割で出せる面と、本人のサイトの接続（解除したものは出さない）。
 * route（GET /api/destinations）と、画面の最初の値を読む server component（app/(editor)/destinations/page.tsx）の両方が使う。
 */
export async function destinationsFor(wiring: PublishWiring, actorId: string, countLive: LivePublishedCounter): Promise<DestinationsDto> {
  const listed = await new ConnectionService(wiring.connections).listConnections({ actorId });
  if (!listed.ok) throw new Error(`connections are not available: ${listed.reason}`);
  const live = listed.connections.filter((connection) => connection.removedAt === null);
  // 数えるのは本人のページの公開版だけ（面の handle は全員で共有するので、owner を必ず渡す）
  const counts = await countLive(actorId, [...PUBLISHABLE_FACE_DESTS, ...live.map((connection) => connection.handle)]);
  return {
    faces: await faceRows(wiring, actorId, counts),
    sites: live.map((connection) => siteDto(connection, counts.get(connection.handle) ?? 0)),
    modes: [...CONNECTION_MODES],
  };
}

/** 接続の設定と、この発信先に公開した（やめたものを含む）ページ。別の人の接続・存在しない id・不正な id は null。 */
export async function siteDetailFor(wiring: PublishWiring, actorId: string, connectionId: string): Promise<SiteDetailDto | null> {
  const service = new ConnectionService(wiring.connections);
  const view = await service.getConnectionView({ actorId, connectionId });
  if (!view.ok) {
    if (view.reason === "not_found") return null;
    throw new Error(`the connection could not be read: ${view.reason}`);
  }
  const published = await service.listPublished({ actorId, connectionId });
  if (!published.ok) throw new Error(`the published pages could not be read: ${published.reason}`);
  const live = published.items.filter((item) => item.status !== "stopped").length;
  return { site: siteDto(view.connection, live), published: [...published.items] };
}

/** GET /api/destinations — 役割で出せる面と、本人のサイトの接続（解除したものは出さない）。 */
export function listDestinations(request: Request, deps: ConnectionsApiDeps): Promise<Response> {
  return guarded("GET /api/destinations", async () => {
    const checked = await ready(request, deps, false);
    if (!checked.ok) return checked.response;
    return jsonResponse(200, { destinations: await destinationsFor(checked.wiring, checked.actorId, checked.counts) });
  });
}

/** POST /api/destinations — 接続を作り、最初の鍵を返す（平文はこの応答だけ）。 */
export function createDestination(request: Request, deps: ConnectionsApiDeps): Promise<Response> {
  return guarded("POST /api/destinations", async () => {
    const checked = await ready(request, deps, true);
    if (!checked.ok) return checked.response;
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = parseCreateBody(body.value);
    if (!input.ok) return errorResponse("bad_request");
    const { wiring, actorId } = checked;
    // actorId は認証の層の本人だけ（要求の値からは決めない）
    const result = await new ConnectionService(wiring.connections).createConnection({ actorId, ...input.value });
    if (!result.ok) return refusal(result.reason);
    return jsonResponse(201, { site: siteDto(result.connection, 0), key: issuedKeyDto(result.key) });
  });
}

/** GET /api/destinations/{id} — 接続の設定と、この発信先に公開した（やめたものを含む）ページ。 */
export function readDestination(request: Request, id: string, deps: ConnectionsApiDeps): Promise<Response> {
  return guarded("GET /api/destinations/[id]", async () => {
    const checked = await ready(request, deps, false);
    if (!checked.ok) return checked.response;
    const detail = await siteDetailFor(checked.wiring, checked.actorId, id);
    return detail === null ? notFoundResponse() : jsonResponse(200, detail);
  });
}

/** PATCH /api/destinations/{id} — サイトの URL・URL の形・受け取り方（mode）を変える。handle は変えられない。 */
export function updateDestination(request: Request, id: string, deps: ConnectionsApiDeps): Promise<Response> {
  return guarded("PATCH /api/destinations/[id]", async () => {
    const checked = await ready(request, deps, true);
    if (!checked.ok) return checked.response;
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = parseUpdateBody(body.value);
    if (!input.ok) return errorResponse("bad_request");
    const { wiring, actorId } = checked;
    const service = new ConnectionService(wiring.connections);
    const result = await service.updateConnection({ actorId, connectionId: id, ...input.value });
    if (!result.ok) return refusal(result.reason);
    const published = await service.listPublished({ actorId, connectionId: id });
    const live = published.ok ? published.items.filter((item) => item.status !== "stopped").length : 0;
    return jsonResponse(200, { site: siteDto(result.connection, live) });
  });
}

/** POST /api/destinations/{id}/key — 鍵を再発行する（旧鍵は同じトランザクションで失効し、次の request から効く）。 */
export function rotateDestinationKey(request: Request, id: string, deps: ConnectionsApiDeps): Promise<Response> {
  return guarded("POST /api/destinations/[id]/key", async () => {
    const checked = await ready(request, deps, true);
    if (!checked.ok) return checked.response;
    const { wiring, actorId } = checked;
    const service = new ConnectionService(wiring.connections);
    const result = await service.rotateKey({ actorId, connectionId: id });
    if (!result.ok) return refusal(result.reason);
    const view = await service.getConnectionView({ actorId, connectionId: id });
    if (!view.ok) return refusal(view.reason);
    return jsonResponse(200, { key: issuedKeyDto(result.key), revoked: result.revoked, site: siteDto(view.connection, 0) });
  });
}

/** POST /api/destinations/{id}/disconnect — 接続を解除する（鍵を失効し、公開中のページを「公開をやめた」にする）。 */
export function disconnectDestination(request: Request, id: string, deps: ConnectionsApiDeps): Promise<Response> {
  return guarded("POST /api/destinations/[id]/disconnect", async () => {
    const checked = await ready(request, deps, true);
    if (!checked.ok) return checked.response;
    const { wiring, actorId } = checked;
    const result = await new ConnectionService(wiring.connections).disconnect({ actorId, connectionId: id });
    if (!result.ok) return refusal(result.reason);
    return jsonResponse(200, { site: siteDto(result.connection, 0), revokedKeys: result.revokedKeys, stopped: result.stopped });
  });
}

/** 書き出しの zip の応答（名前は handle と日付から。中身はメモリの中で組んだ 1 つの zip）。 */
function archiveResponse(handle: string, archive: ExportArchive): Response {
  const name = `${handle}-${new Date().toISOString().slice(0, 10)}.zip`;
  return new Response(archive.bytes as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(archive.bytes.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}

/**
 * GET /api/destinations/{id}/export — Markdown ＋写真の zip。解除したあとでも呼べる（その接続に公開したページの最後の公開版）。
 * 写真が読めない・大きすぎるときは断り、公開版も下書きも変えない。
 */
export function exportDestination(request: Request, id: string, deps: ConnectionsApiDeps): Promise<Response> {
  return guarded("GET /api/destinations/[id]/export", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const wiring = deps.ports(session, request);
    if (!wiring) return errorResponse("unavailable");
    const assets = deps.exportAssets();
    if (!assets) return connectionError("storage_unavailable");
    const service = new ConnectionService({ ...wiring.connections, assetBytes: assets.port });
    const view = await service.getConnectionView({ actorId: session.userId, connectionId: id });
    if (!view.ok) return refusal(view.reason);
    const result = await service.exportConnection({ actorId: session.userId, connectionId: id });
    if (!result.ok) {
      if (assets.exceeded()) return connectionError("export_too_large");
      if (result.reason === "not_found") return notFoundResponse();
      // 写真が足りない・Markdown が契約に収まらない（理由の code だけをログに書く）
      console.warn("editor-web: export refused", { route: "GET /api/destinations/[id]/export", reason: result.reason });
      return connectionError("export_failed");
    }
    return archiveResponse(view.connection.handle, result);
  });
}
