import "server-only";
import { isTrustedNihoOrigin } from "./config";
import type { AuthProvider, Session, SessionRequest } from "./types";
import { readBoundedUtf8 } from "../server/bounded-response";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set(["PENDING", "ACCEPTED", "DECLINED", "REVOKED", "EXPIRED"]);
const MAX_TEXT = 300;
const MAX_RESPONSE = 64 * 1024;

export type NihoEditorRoles = Readonly<{ version: 1; roles: readonly "writer"[]; destinations: readonly "exp"[] }>;
export type ArticleLinkDto = Readonly<{
  id: string;
  state: "PENDING" | "ACCEPTED" | "DECLINED" | "REVOKED" | "EXPIRED";
  providerName: string;
  inviterName: string;
  writerName: string;
  writerLabel: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid NIHO response");
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error("invalid NIHO response");
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) throw new Error("invalid NIHO response");
  return value;
}

function time(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("invalid NIHO response");
  return value;
}

export function parseArticleLink(value: unknown): ArticleLinkDto {
  const item = record(value);
  exact(item, ["id", "state", "providerName", "inviterName", "writerName", "writerLabel", "expiresAt", "acceptedAt", "createdAt"]);
  if (typeof item.id !== "string" || !UUID.test(item.id) || typeof item.state !== "string" || !STATES.has(item.state)) throw new Error("invalid NIHO response");
  return {
    id: item.id,
    state: item.state as ArticleLinkDto["state"],
    providerName: text(item.providerName),
    inviterName: text(item.inviterName),
    writerName: text(item.writerName),
    writerLabel: text(item.writerLabel),
    expiresAt: time(item.expiresAt)!,
    acceptedAt: time(item.acceptedAt, true),
    createdAt: time(item.createdAt)!,
  };
}

async function json(response: Response): Promise<unknown> {
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("NIHO account API unavailable");
  }
  return JSON.parse(await readBoundedUtf8(response, MAX_RESPONSE)) as unknown;
}

export class NihoExperienceApiClient {
  constructor(
    private readonly auth: AuthProvider,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly origin: string | undefined = process.env.EDITOR_NIHO_ORIGIN,
  ) {}

  private async request(session: Session, request: SessionRequest, purpose: "roles" | "article-links", path: string, init: RequestInit = {}): Promise<unknown> {
    if (!isTrustedNihoOrigin(this.origin) || !this.auth.articleApiToken) throw new Error("NIHO account API unavailable");
    const token = await this.auth.articleApiToken(session, request, purpose);
    if (!token) throw new Error("NIHO account API unavailable");
    return json(await this.fetchImpl(new URL(path, this.origin), {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    }));
  }

  async roles(session: Session, request: SessionRequest): Promise<NihoEditorRoles> {
    const body = record(await this.request(session, request, "roles", "/api/auth/experience-editor-connect/roles"));
    exact(body, ["version", "roles", "destinations"]);
    if (body.version !== 1 || !Array.isArray(body.roles) || !Array.isArray(body.destinations)
      || body.roles.some((item) => item !== "writer") || body.destinations.some((item) => item !== "exp")
      || new Set(body.roles).size !== body.roles.length || new Set(body.destinations).size !== body.destinations.length) throw new Error("invalid NIHO response");
    return { version: 1, roles: body.roles as "writer"[], destinations: body.destinations as "exp"[] };
  }

  async links(session: Session, request: SessionRequest): Promise<readonly ArticleLinkDto[]> {
    const body = record(await this.request(session, request, "article-links", "/api/auth/experience-editor-connect/article-links"));
    exact(body, ["items"]);
    if (!Array.isArray(body.items)) throw new Error("invalid NIHO response");
    return body.items.map(parseArticleLink);
  }

  /** Provider links are optional; their outage must not erase a verified destination connection. */
  async connectionState(session: Session, request: SessionRequest): Promise<{ roles: NihoEditorRoles; links: readonly ArticleLinkDto[]; linksUnavailable?: true }> {
    const roles = await this.roles(session, request);
    if (!roles.roles.includes("writer") || !roles.destinations.includes("exp")) return { roles, links: [] };
    try {
      return { roles, links: await this.links(session, request) };
    } catch {
      return { roles, links: [], linksUnavailable: true };
    }
  }

  async decide(session: Session, request: SessionRequest, id: string, decision: "accept" | "decline"): Promise<ArticleLinkDto> {
    if (!UUID.test(id)) throw new Error("invalid invitation id");
    return parseArticleLink(await this.request(session, request, "article-links", `/api/auth/experience-editor-connect/article-links/${id}/${decision}`, { method: "POST", body: "{}" }));
  }
}
