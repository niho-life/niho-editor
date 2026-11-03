import { createHash, randomBytes } from "node:crypto";
import {
  API_ORIGIN,
  PREVIEW_TOKEN_MAX_TTL_SECONDS,
  PREVIEW_TOKEN_PREFIX,
  UUID_PATTERN,
  isConnectionHandle,
  isFaceDest,
  isHttpsUrl,
  type Author,
} from "@niho/editor-publish-contract";
import { roleAllows, type AuthorSource, type Clock, type ConnectionSource, type RoleReader } from "@niho/editor-publish";
import type { OwnerId } from "@niho/editor-store";
import type { AuthProvider, Session } from "../auth/types";
import { errorResponse, guarded, isSameOriginRequest, jsonResponse, notFoundResponse, readJsonBody } from "./http";

/**
 * 本人がプレビュー token を発行する（#40）。`POST /api/pages/{id}/preview-token`、本文は `{ handle }`。
 * 201 `{ token, expiresAt, url }`（url は公開 API の `/v1/preview/{token}.json`）。token の平文はこの応答にだけ出し、保存はハッシュだけ。
 *
 * - 本人だけ（未認証 401）。更新系なので同じ origin の画面からだけ（違えば 403）。DB が無いと 503。
 * - ページは本人の・ゴミ箱でないもの。handle は、本人が役割で出せる面（`exp` / `niho`）か、本人の解除していない接続。
 *   どちらかが満たされなければ同じ 404（別の人のページ・接続の有無を推測させない）。handle の形が違えば 400。
 * - 有効期限は発行から 15 分（契約の上限）。token は page と handle（と下の著者）に拘束し、下書きの版には拘束しない（自動保存のあとも読める）。
 * - 発行したときの本人の著者を token に結ぶ（公開 API の要求には session が無いため。migration 0009）。読めない・形が合わない
 *   （名前が無い・長すぎる・url が https でない）ときは著者なしで発行し、プレビューはいまの公開版の著者で組む（無ければ 404）。
 */

export interface PreviewTokenRecord {
  readonly pageId: string;
  /** 面は `exp` / `niho`、本人のサイトは接続の handle。 */
  readonly handle: string;
  /** token の SHA-256（小文字の hex）。平文は渡さない。 */
  readonly sha256: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** 発行したときの本人の著者。無ければ null。 */
  readonly author: Author | null;
}

export interface PreviewTokenStore {
  /** 本人（owner）の・ゴミ箱でないページなら 1 行保存して true。そうでなければ何も書かずに false。 */
  issue(owner: OwnerId, record: PreviewTokenRecord): Promise<boolean>;
}

export type PreviewTokenApiDeps = {
  auth: () => AuthProvider;
  /** DB が使えないときは null（503）。 */
  store: () => PreviewTokenStore | null;
  /** 本人の NIHO の役割（要求のたびに読む。保存しない）。 */
  roles: (session: Session, request: Request) => RoleReader;
  /** 本人の著者（公開と同じ。発行のときに読み、token に結ぶ）。 */
  authors: (session: Session) => AuthorSource;
  /** 本人の解除していない接続（DB が使えないときは null で 503）。 */
  connections: () => ConnectionSource | null;
  /** Experience categories are checked from the destination for every token issuance. */
  categoryActive?: (session: Session, category: string) => Promise<boolean>;
  clock?: Clock;
  /** 乱数（既定は node:crypto の randomBytes）。 */
  random?: (size: number) => Uint8Array;
  env?: Readonly<Record<string, string | undefined>>;
};

export const PREVIEW_TOKEN_TTL_MS = PREVIEW_TOKEN_MAX_TTL_SECONDS * 1000;

/** 本文の上限（`{ handle }` だけ）。 */
const MAX_PREVIEW_TOKEN_BODY_BYTES = 4096;

/** token に結べる著者の長さの上限（表の CHECK と同じ。0009）。 */
const AUTHOR_TEXT_MAX = 256;
const AUTHOR_URL_MAX = 2048;
/** 契約が文字列に許さない文字（validate.ts の CONTROL と同じ）。 */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}/u;

const systemClock: Clock = { now: () => new Date().toISOString() };

/** `{ handle }`（他の field は不可）。handle は面か、接続に使える形。 */
function parseHandle(value: unknown): { handle: string; category: string | null } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.handle !== "string" || !(isFaceDest(record.handle) || isConnectionHandle(record.handle))) return null;
  if (record.handle === "exp") {
    if (Object.keys(record).sort().join(",") !== "category,handle" || typeof record.category !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.category) || record.category.length > 160) return null;
    return { handle: record.handle, category: record.category };
  }
  return Object.keys(record).length === 1 ? { handle: record.handle, category: null } : null;
}

function isBindableText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= AUTHOR_TEXT_MAX && !CONTROL_CHARACTER.test(value);
}

/** 本人の著者を読み、token に結べる形（契約の Author で、表の CHECK に収まる）なら返す。読めない・合わないなら null。 */
async function bindableAuthor(source: AuthorSource, actorId: string): Promise<Author | null> {
  let author: Author;
  try {
    author = await source.read(actorId);
  } catch {
    return null;
  }
  const { name, handle, url } = author;
  if (!isBindableText(name)) return null;
  if (handle !== null && !isBindableText(handle)) return null;
  if (url !== null && !(isHttpsUrl(url) && url.length <= AUTHOR_URL_MAX)) return null;
  return { name, handle, url };
}

/** POST /api/pages/{id}/preview-token */
export function issuePreviewTokenRoute(request: Request, id: string, deps: PreviewTokenApiDeps): Promise<Response> {
  return guarded("POST /api/pages/[id]/preview-token", async () => {
    const session = await deps.auth().getSession(request);
    if (!session) return errorResponse("unauthorized");
    if (!isSameOriginRequest(request, deps.env)) return errorResponse("forbidden");
    const store = deps.store();
    const connections = deps.connections();
    if (!store || !connections) return errorResponse("unavailable");
    const body = await readJsonBody(request, MAX_PREVIEW_TOKEN_BODY_BYTES);
    if (!body.ok) return body.response;
    const parsed = parseHandle(body.value);
    if (parsed === null) return errorResponse("bad_request");
    const { handle, category } = parsed;
    if (!UUID_PATTERN.test(id)) return notFoundResponse();
    // owner は認証の層の本人だけ（要求の値からは決めない）
    let allowed: boolean;
    try {
      allowed = isFaceDest(handle)
        ? roleAllows(await deps.roles(session, request).read(session.userId), handle)
        : await connections.has(session.userId, handle);
    } catch {
      return errorResponse("unavailable");
    }
    if (!allowed) return notFoundResponse();
    if (handle === "exp") {
      if (!deps.categoryActive) return errorResponse("unavailable");
      try {
        if (!(await deps.categoryActive(session, category!))) return notFoundResponse();
      } catch {
        return errorResponse("unavailable");
      }
    }
    // 256 bit の乱数（base64url の 43 文字。契約の `pv_` の形）
    const token = `${PREVIEW_TOKEN_PREFIX}${Buffer.from((deps.random ?? randomBytes)(32)).toString("base64url")}`;
    const issuedAt = new Date((deps.clock ?? systemClock).now()).toISOString();
    const expiresAt = new Date(Date.parse(issuedAt) + PREVIEW_TOKEN_TTL_MS).toISOString();
    const sha256 = createHash("sha256").update(token, "utf8").digest("hex");
    const author = await bindableAuthor(deps.authors(session), session.userId);
    if (!(await store.issue(session.userId, { pageId: id, handle, sha256, issuedAt, expiresAt, author }))) return notFoundResponse();
    return jsonResponse(201, { token, expiresAt, url: `${API_ORIGIN}/v1/preview/${token}.json` });
  });
}
