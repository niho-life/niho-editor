import {
  RANGES,
  UUID_PATTERN,
  isConnectionHandle,
  isFaceDest,
  type Dest,
  type Extras,
  type PublicationRange,
} from "@niho/editor-publish-contract";
import {
  ConnectionService,
  EXTRA_KEYS,
  FACE_LABELS,
  PublishService,
  collectFacts,
  destOf,
  destinationUrl,
  draftFingerprint,
  parseDestinationDeclaration,
  sheetPlan,
  slugFromTitle,
  slugStem,
  toPublishedBlocks,
  validateSlug,
  type ConnectionTx,
  type DraftPage,
  type DestinationBlock,
  type ExtraKey,
  type Notice,
  type PrimaryAction,
  type Problem,
  type PublicationRecord,
  type PublishResult,
  type SheetSelection,
  type SheetSlug,
  type StatusState,
  type StorageBlock,
  type Target,
} from "@niho/editor-publish";
import type { AuthProvider, Session } from "../auth/types";
import { PUBLISH_MESSAGES, SLUG_MESSAGES } from "../publish/messages";
import type { PublishWiring } from "../publish/ports";
import { errorResponse, folderResponse, guarded, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";

/**
 * 公開のシート（#39）: シートのデータ（GET）、公開する・更新を公開・保存・発信先を変える（POST）、公開をやめる（POST …/stop）。
 * 全て本人のページだけ。未認証 401、DB なし 503、別の人・存在しない・不正な id は同じ 404。更新系は同じ origin の画面からだけ（違えば 403）。
 * 公開の前の評価・役割・slug はサーバー（PublishService）がもう一度確かめる。シートの押せないボタンは信用しない。
 * 失敗の応答は reason の code と画面に出す一言（message）だけ。題名・本文・URL の値は入れない（slug の提案だけは本人の値として返す）。
 */

export type PublishApiDeps = {
  auth: () => AuthProvider;
  /** 本人ごとの公開のポート（src/publish/ports.ts）。DB が使えないときは null（503）。 */
  ports: (session: Session, request: Request) => PublishWiring | null;
  env?: Readonly<Record<string, string | undefined>>;
};

/** シートが選んでいるもの（GET の query、POST の本文）。 */
export type PublishSelection = {
  handle: string;
  range: PublicationRange;
  extras: Extras;
  /** null は題名から作った提案を使う。 */
  slug: string | null;
  category: string | null;
  related: readonly string[];
};

export type PublishDestinationDto = {
  handle: string;
  dest: Dest;
  label: string;
  available: boolean;
  /** role＝役割が無い、unavailable＝宣言が無い・読めない（いまは公開できません）。 */
  reason: DestinationBlock | null;
  /** その発信先に出したときの URL（https://…）。選べないときは null。 */
  url: string | null;
};

export type PublishedDto = {
  handle: string;
  dest: Dest;
  label: string;
  slug: string;
  /** 公開版の canonicalUrl。 */
  url: string;
  range: PublicationRange;
  extras: Extras;
  stopped: boolean;
  version: number;
  publishedAt: string;
  updatedAt: string;
};

export type PublishSheetDto = {
  status: StatusState;
  publication: PublishedDto | null;
  destinations: PublishDestinationDto[];
  /** 評価した選択（query が無ければ、公開している発信先とその設定）。 */
  selection: PublishSelection | null;
  ranges: PublicationRange[];
  extras: { key: ExtraKey; checked: boolean }[];
  selectionError: "range" | "extras" | null;
  /** 保存先がクラウドでないため公開できない理由（公開の主ボタンは出ない）。 */
  storageBlock: StorageBlock | null;
  problems: Problem[];
  notices: Notice[];
  url: string | null;
  slug: SheetSlug;
  /** URL の slug の前（https://{host}/{path}/）。 */
  slugPrefix: string | null;
  primary: PrimaryAction | null;
  changesDestination: boolean;
  canStop: boolean;
};

export type PublishOperation = "publish" | "update" | "move";

export type PublishedResultDto = {
  status: StatusState;
  operation: PublishOperation;
  url: string;
  version: number;
  notices: Notice[];
};

/** slug の上限（契約の 160 文字に少し余裕を持たせた、query・本文で受ける長さ）。 */
const MAX_SLUG_INPUT = 200;
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NO_EXTRAS: Extras = Object.freeze({ app: false, news: false, xp: false });

function isHandle(value: unknown): value is string {
  return isFaceDest(value) || isConnectionHandle(value);
}

function isRange(value: unknown): value is PublicationRange {
  return typeof value === "string" && (RANGES as readonly string[]).includes(value);
}

function targetOf(handle: string): Target {
  return isFaceDest(handle) ? { dest: handle } : { dest: "site", handle };
}

type Parsed<T> = { ok: true; value: T } | { ok: false };

/** GET の query。handle が無ければ選択なし（公開している発信先が既定）。extras は `app,news` のカンマ区切り（空は「なし」）。 */
export function selectionQueryOf(params: URLSearchParams): Parsed<Partial<PublishSelection>> {
  const value: Partial<PublishSelection> = {};
  const handle = params.get("handle");
  if (handle !== null) {
    if (!isHandle(handle)) return { ok: false };
    value.handle = handle;
  }
  const range = params.get("range");
  if (range !== null) {
    if (!isRange(range)) return { ok: false };
    value.range = range;
  }
  const extras = params.get("extras");
  if (extras !== null) {
    const keys = extras === "" ? [] : extras.split(",");
    if (keys.some((key) => !(EXTRA_KEYS as readonly string[]).includes(key))) return { ok: false };
    value.extras = { app: keys.includes("app"), news: keys.includes("news"), xp: keys.includes("xp") };
  }
  const slug = params.get("slug");
  if (slug !== null) {
    if (slug.length > MAX_SLUG_INPUT) return { ok: false };
    value.slug = slug;
  }
  const category = params.get("category");
  if (category !== null) {
    if (category !== "" && (category.length > 160 || !SAFE_SLUG.test(category))) return { ok: false };
    value.category = category || null;
  }
  const related = params.get("related");
  if (related !== null) {
    const values = related === "" ? [] : related.split(",");
    if (values.length > 20 || new Set(values).size !== values.length || values.some((item) => item.length > 160 || !SAFE_SLUG.test(item))) return { ok: false };
    value.related = values;
  }
  return { ok: true, value };
}

/** POST の本文 `{ handle, range, extras: { app, news, xp }, slug? }`。知らない key は 400。 */
export function placeBodyOf(body: unknown): Parsed<PublishSelection> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false };
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["handle", "range", "extras", "slug", "category", "related"].includes(key))) return { ok: false };
  const { handle, range, extras, slug, category, related } = record;
  if (!isHandle(handle) || !isRange(range)) return { ok: false };
  if (typeof extras !== "object" || extras === null || Array.isArray(extras)) return { ok: false };
  const flags = extras as Record<string, unknown>;
  if (Object.keys(flags).some((key) => !(EXTRA_KEYS as readonly string[]).includes(key))) return { ok: false };
  if (EXTRA_KEYS.some((key) => typeof flags[key] !== "boolean")) return { ok: false };
  if (slug !== undefined && (typeof slug !== "string" || slug.length > MAX_SLUG_INPUT)) return { ok: false };
  if (category !== undefined && category !== null && (typeof category !== "string" || category.length > 160 || !SAFE_SLUG.test(category))) return { ok: false };
  if (related !== undefined && (!Array.isArray(related) || related.length > 20 || new Set(related).size !== related.length || related.some((item) => typeof item !== "string" || item.length > 160 || !SAFE_SLUG.test(item)))) return { ok: false };
  return {
    ok: true,
    value: { handle, range, extras: { app: flags.app === true, news: flags.news === true, xp: flags.xp === true }, slug: slug ?? null, category: category ?? null, related: (related ?? []) as string[] },
  };
}

/** 写真の置き場所が無いときに公開できない、とする問題（どの発信先でも。本文から写真を外すと公開できる）。 */
export const PHOTOS_UNAVAILABLE: Problem = Object.freeze({ id: "photos-unavailable", message: PUBLISH_MESSAGES.photosUnavailable, fix: "body" });

/** 公開版に写真が入るページか（カバー写真か、本文の写真）。 */
export function hasPhotos(page: DraftPage): boolean {
  return page.coverAssetId !== null || toPublishedBlocks(page.content).figures.length > 0;
}

/** 他のページが持つ slug（`base` とその stem の下）。PublishService の提案と同じ範囲を見る。 */
async function takenUnder(tx: ConnectionTx, handle: string, base: string, pageId: string): Promise<readonly string[]> {
  if (!validateSlug(base).ok) return [];
  const taken = await tx.takenSlugs(handle, base, pageId);
  const stem = slugStem(base);
  return stem === base ? taken : [...taken, ...(await tx.takenSlugs(handle, stem, pageId))];
}

function labelOf(handle: string, destinations: readonly PublishDestinationDto[]): string {
  return destinations.find((entry) => entry.handle === handle)?.label ?? (isFaceDest(handle) ? FACE_LABELS[handle] : handle);
}

/**
 * シートのデータ。役割は毎回読み（保存しない）、宣言は発信先ごとに読む（役割の無い面は読まない）。
 * null はページが無い（本人のでない）。
 */
export async function loadPublishSheet(
  wiring: PublishWiring,
  actorId: string,
  pageId: string,
  query: Partial<PublishSelection>,
): Promise<PublishSheetDto | null> {
  const ports = wiring.publish;
  const storageMode = await ports.storage.read(actorId);
  const listed = await new ConnectionService(wiring.connections).listConnections({ actorId });
  if (!listed.ok) throw new Error("connections are not available");
  const sites = listed.connections.map((connection) => connection.handle);

  const read = await wiring.connections.store.transaction(async (tx) => {
    const page = await tx.getPage(pageId);
    if (!page || page.ownerId !== actorId) return null;
    const assets = await tx.listAssets(pageId);
    const publication = await tx.getPublication(pageId);
    const version = publication ? await tx.getVersion(pageId, publication.version) : null;
    // 選択の既定は、公開している（やめたものを含む）発信先
    const handle = query.handle !== undefined
      ? (isConnectionHandle(query.handle) ? query.handle : null)
      : publication?.dest === "site" ? publication.handle : null;
    const taken = handle === null || publication?.handle === handle ? [] : await takenUnder(tx, handle, query.slug ?? slugFromTitle(page.title, page.id), pageId);
    const reviewProblem = handle === null ? null : await tx.reviewGate?.(actorId, pageId, handle) ?? null;
    return { page, assets, publication, version, handle, taken, reviewProblem };
  });
  if (!read) return null;
  const { page, assets, publication, version, handle, taken, reviewProblem } = read;

  const same = publication !== null && publication.handle === handle ? publication : null;
  const selection: SheetSelection | null =
    handle === null
      ? null
      : {
          handle,
          range: query.range ?? same?.range ?? "live",
          extras: query.extras ?? same?.extras ?? NO_EXTRAS,
          // カテゴリと関連する体験は editor にまだ欄が無い。公開している発信先ではその値を引き継ぎ、それ以外は無し
          category: query.category ?? same?.category ?? null,
          related: query.related ?? same?.related ?? [],
          slug: query.slug ?? null,
        };

  const handles = [...sites];
  const declarations: Record<string, unknown> = {};
  await Promise.all(
    [...new Set(handles)].map(async (entry) => {
      declarations[entry] = await ports.declarations.get(entry);
    }),
  );

  const dest = selection === null ? null : destOf(selection.handle);
  const serverFacts =
    selection === null || dest === null
      ? { relatedLive: null }
      : await ports.facts.read({ actorId, pageId, dest, handle: selection.handle, related: selection.related, category: selection.category });
  const facts = collectFacts(page, assets, serverFacts, { category: selection?.category ?? null, related: selection?.related ?? [] });
  const fingerprint = await draftFingerprint(page, assets);
  const plan = sheetPlan({
    pageId,
    title: page.title,
    roles: [],
    storageMode,
    sites,
    declarations,
    selection,
    publication:
      publication === null
        ? null
        : {
            range: publication.range,
            stoppedAt: publication.stoppedAt,
            // 公開版が読めなければ「更新あり」にする（下書きと同じとは言えない）
            fingerprint: version?.snapshot.fingerprint ?? "",
            handle: publication.handle,
            slug: publication.slug,
            extras: publication.extras,
            category: publication.category,
            related: publication.related,
          },
    draftFingerprint: fingerprint,
    facts,
    takenSlugs: taken,
  });

  const suggested = slugFromTitle(page.title, page.id);
  const destinations: PublishDestinationDto[] = plan.destinations.filter((entry) => entry.dest === "site").map((entry) => {
    const parsed = entry.available ? parseDestinationDeclaration(declarations[entry.handle]) : null;
    const declaration = parsed?.ok ? parsed.value : null;
    // 選んでいる発信先は、いま評価した URL（slug が使えなければ null。前の URL や提案を見せない）
    const url =
      entry.handle === plan.selected?.handle
        ? plan.url
        : publication?.handle === entry.handle && version
          ? version.snapshot.canonicalUrl
          : declaration
            ? destinationUrl(declaration, suggested)
            : null;
    return { handle: entry.handle, dest: entry.dest, label: entry.label, available: entry.available, reason: entry.reason, url };
  });
  const selectedDeclaration = plan.selected?.available ? parseDestinationDeclaration(declarations[plan.selected.handle]) : null;
  // 写真の置き場所が無いのに写真のあるページは、何度押しても公開に失敗するので、先に押せなくする
  const photosBlocked = plan.selected !== null && !wiring.photosReady && hasPhotos(page);

  return {
    status: publication !== null && publication.dest !== "site" ? "private" : plan.status,
    publication:
      publication === null || publication.dest !== "site" || version === null
        ? null
        : {
            handle: publication.handle,
            dest: publication.dest,
            label: labelOf(publication.handle, destinations),
            slug: publication.slug,
            url: version.snapshot.canonicalUrl,
            range: publication.range,
            extras: { ...publication.extras },
            stopped: publication.stoppedAt !== null,
            version: publication.version,
            publishedAt: publication.publishedAt,
            updatedAt: publication.updatedAt,
          },
    destinations,
    selection: selection === null ? null : { handle: selection.handle, range: selection.range, extras: { ...selection.extras }, slug: selection.slug, category: selection.category, related: [...selection.related] },
    ranges: [...plan.ranges],
    extras: plan.extras.map((entry) => ({ ...entry })),
    selectionError: plan.selectionError,
    storageBlock: plan.storageBlock,
    problems: [...plan.problems.map((problem) => ({ ...problem })), ...(reviewProblem ? [{ ...reviewProblem }] : []), ...(photosBlocked ? [{ ...PHOTOS_UNAVAILABLE }] : [])],
    notices: plan.notices.map((notice) => ({ ...notice })),
    url: plan.url,
    slug: { ...plan.slug },
    slugPrefix: selectedDeclaration?.ok ? destinationUrl(selectedDeclaration.value, "") : null,
    primary: photosBlocked || reviewProblem !== null ? null : plan.primary,
    changesDestination: plan.changesDestination,
    canStop: publication?.dest === "site" && plan.canStop,
  };
}

/** GET /api/pages/{id}/publish[?handle=&range=&extras=&slug=] — シートのデータ。 */
export function getPublishSheetRoute(request: Request, id: string, deps: PublishApiDeps): Promise<Response> {
  return guarded("GET /api/pages/[id]/publish", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    const wiring = deps.ports(session, request);
    if (!wiring) return errorResponse("unavailable");
    if (!UUID_PATTERN.test(id)) return notFoundResponse();
    const query = selectionQueryOf(new URL(request.url).searchParams);
    if (!query.ok) return errorResponse("bad_request");
    // owner は認証の層の本人だけ（要求の値からは決めない）
    let sheet: PublishSheetDto | null;
    try {
      sheet = await loadPublishSheet(wiring, session.userId, id, query.value);
    } catch {
      return errorResponse("unavailable");
    }
    return sheet ? jsonResponse(200, { sheet }) : notFoundResponse();
  });
}

/** PublishResult の失敗を HTTP と画面の一言にする（not_found は他の 404 と同じ応答）。 */
export function publishFailureResponse(result: Exclude<PublishResult, { ok: true }>): Response {
  switch (result.reason) {
    case "not_found":
      return notFoundResponse();
    case "forbidden_destination": {
      const setting = result.detail === "target" || result.detail === "range" || result.detail === "extras";
      const message = result.detail === "role" ? PUBLISH_MESSAGES.forbiddenRole : result.detail === "connection" ? PUBLISH_MESSAGES.forbiddenConnection : PUBLISH_MESSAGES.forbiddenSetting;
      return jsonResponse(setting ? 400 : 403, { error: result.reason, detail: result.detail, message });
    }
    case "storage_not_cloud":
      return jsonResponse(403, { error: result.reason, detail: result.detail, message: PUBLISH_MESSAGES.storageNotCloud });
    case "not_ready":
      return jsonResponse(409, { error: result.reason, problems: result.problems, notices: result.notices, message: PUBLISH_MESSAGES.notReady });
    case "slug_locked":
      return jsonResponse(409, { error: result.reason, slug: result.slug, message: PUBLISH_MESSAGES.slugLocked });
    case "slug_taken":
      return jsonResponse(409, {
        error: result.reason,
        suggestion: result.suggestion,
        message: result.suggestion ? `${PUBLISH_MESSAGES.slugTaken}（${result.suggestion} なら使えます）` : PUBLISH_MESSAGES.slugTaken,
      });
    case "invalid_slug":
      return jsonResponse(400, { error: result.reason, detail: result.detail, message: SLUG_MESSAGES[result.detail] });
    case "destination_unavailable":
      return jsonResponse(503, { error: result.reason, message: PUBLISH_MESSAGES.unavailable });
    case "failed":
      return jsonResponse(result.retryable ? 503 : 422, {
        error: result.reason,
        retryable: result.retryable,
        message: result.retryable ? PUBLISH_MESSAGES.failed : PUBLISH_MESSAGES.snapshotFailed,
      });
  }
}

/** フォルダ（`kind = 'folder'`）は公開しない（§3.2 の 3）。store の下書きの行が kind を持つときだけ見る。 */
function isFolderDraft(page: object): boolean {
  return "kind" in page && (page as { kind?: unknown }).kind === "folder";
}

/** 今の公開と、写真のあるページか（本人のページのときだけ）。ページが無ければ undefined。 */
async function currentPublication(
  wiring: PublishWiring,
  actorId: string,
  pageId: string,
): Promise<{ publication: PublicationRecord | null; photos: boolean; folder: boolean } | undefined> {
  return wiring.connections.store.transaction(async (tx) => {
    const page = await tx.getPage(pageId);
    if (!page || page.ownerId !== actorId) return undefined;
    return { publication: await tx.getPublication(pageId), photos: hasPhotos(page), folder: isFolderDraft(page) };
  });
}

/**
 * POST /api/pages/{id}/publish — 本文 `{ handle, range, extras, slug? }`。
 * 公開していなければ（やめたものを含む）公開する、同じ発信先で公開中なら更新を公開（設定だけなら保存）、別の発信先なら発信先を変える。
 */
export function publishRoute(request: Request, id: string, deps: PublishApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/publish", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const wiring = deps.ports(session, request);
    if (!wiring) return errorResponse("unavailable");
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const input = placeBodyOf(body.value);
    if (!input.ok) return errorResponse("bad_request");
    if (!UUID_PATTERN.test(id)) return notFoundResponse();
    const actorId = session.userId;
    const read = await currentPublication(wiring, actorId, id);
    if (read === undefined) return notFoundResponse();
    if (read.folder) return folderResponse();
    // 写真の置き場所が無いと、写真のあるページは何度試しても失敗する。もう一度とは言わない
    if (read.photos && !wiring.photosReady) {
      return jsonResponse(422, { error: "failed", retryable: false, detail: "photos_unavailable", message: PUBLISH_MESSAGES.photosUnavailable });
    }
    const current = read.publication;
    const { handle, range, extras, slug, category, related } = input.value;
    const live = current !== null && current.stoppedAt === null;
    const same = current !== null && current.handle === handle;
    const operation: PublishOperation = live ? (same ? "update" : "move") : "publish";
    const service = new PublishService(wiring.publish);
    const place = {
      actorId,
      pageId: id,
      target: targetOf(handle),
      // カテゴリと関連する体験は editor にまだ欄が無い。同じ発信先ではその値を引き継ぐ
      settings: { range, extras, category, related },
      ...(slug !== null ? { slug } : {}),
    };
    const result = operation === "update" ? await service.update(place) : operation === "move" ? await service.changeDestination(place) : await service.publish(place);
    if (!result.ok) return publishFailureResponse(result);
    const published: PublishedResultDto = { status: result.status, operation, url: result.url, version: result.version, notices: [...result.notices] };
    return jsonResponse(200, { published });
  });
}

/** POST /api/pages/{id}/publish/stop — 公開をやめる（公開版は残す。NIHO の面は URL を一覧へ転送。もう一度呼んでも同じ）。 */
export function stopPublishingRoute(request: Request, id: string, deps: PublishApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/publish/stop", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const wiring = deps.ports(session, request);
    if (!wiring) return errorResponse("unavailable");
    if (!UUID_PATTERN.test(id)) return notFoundResponse();
    const result = await new PublishService(wiring.publish).stop({ actorId: session.userId, pageId: id });
    if (result.ok) return jsonResponse(200, { stopped: { status: result.status } });
    if (result.reason === "not_found") return notFoundResponse();
    return jsonResponse(503, { error: result.reason, retryable: result.retryable, message: PUBLISH_MESSAGES.stopFailed });
  });
}
