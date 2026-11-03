import "server-only";
import type { CategoryDisplay } from "@niho/editor-publish-contract";
import type { FactsSource } from "@niho/editor-publish";
import { readBoundedUtf8 } from "./bounded-response";

const METADATA_IDENTITY_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_RESPONSE = 64 * 1024;
const MAX_IDENTITY_TOKEN_RESPONSE = 16 * 1024;

export interface ExperienceCategory extends CategoryDisplay { readonly slug: string }
export interface ExperienceCandidate { readonly slug: string; readonly title: string; readonly providerName: string }

function configured(): { origin: string; audience: string } {
  if (process.env.EDITOR_EXPERIENCE_ARTICLE_AUTHORITY_ENABLED !== "true") throw new Error("Experience article authority is disabled");
  const origin = process.env.EDITOR_EXPERIENCE_ORIGIN ?? "";
  const audience = process.env.EDITOR_EXPERIENCE_ARTICLE_AUTHORITY_AUDIENCE ?? "";
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || !audience) throw new Error("Experience article authority is not configured");
  return { origin, audience };
}

async function identityToken(audience: string, fetchImpl: typeof fetch): Promise<string> {
  const url = new URL(METADATA_IDENTITY_URL);
  url.searchParams.set("audience", audience);
  url.searchParams.set("format", "full");
  const response = await fetchImpl(url, { headers: { "metadata-flavor": "Google" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("service identity unavailable");
  const token = (await readBoundedUtf8(response, MAX_IDENTITY_TOKEN_RESPONSE)).trim();
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 16_384) throw new Error("service identity unavailable");
  return token;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Experience article authority unavailable");
  }
  return JSON.parse(await readBoundedUtf8(response, MAX_RESPONSE)) as unknown;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid authority response");
  return value as Record<string, unknown>;
}

function category(value: unknown): ExperienceCategory {
  const item = object(value);
  if (Object.keys(item).sort().join(",") !== "displayOrder,labelEn,labelJa,revision,slug" || typeof item.slug !== "string" || !SLUG.test(item.slug)
    || typeof item.labelEn !== "string" || !item.labelEn.trim() || typeof item.labelJa !== "string" || !item.labelJa.trim()
    || !Number.isSafeInteger(item.displayOrder) || (item.displayOrder as number) < 0 || !Number.isSafeInteger(item.revision) || (item.revision as number) < 1) throw new Error("invalid authority response");
  return { slug: item.slug, labelEn: item.labelEn, labelJa: item.labelJa, displayOrder: item.displayOrder as number, revision: item.revision as number };
}

export class ExperienceArticleAuthorityClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly getToken = identityToken,
    private readonly settings = configured,
  ) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const config = this.settings();
    const token = await this.getToken(config.audience, this.fetchImpl);
    return boundedJson(await this.fetchImpl(new URL(path, config.origin), {
      method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body),
      cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(8_000),
    }));
  }

  async categories(): Promise<readonly ExperienceCategory[]> {
    const config = this.settings();
    const response = object(await boundedJson(await this.fetchImpl(new URL("/api/public/guides/categories", config.origin), { cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(8_000) })));
    if (response.version !== 1 || !Array.isArray(response.items) || Object.keys(response).sort().join(",") !== "items,version") throw new Error("invalid categories response");
    return response.items.map(category);
  }

  async candidates(writerNihoUserId: string, query?: string, cursor?: string): Promise<{ items: readonly ExperienceCandidate[]; nextCursor: string | null }> {
    const response = object(await this.post("/internal/article-authority/v1/candidates", { writerNihoUserId, ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) }));
    if (Object.keys(response).sort().join(",") !== "items,nextCursor,version" || response.version !== 1 || !Array.isArray(response.items) || response.items.length > 20
      || (response.nextCursor !== null && (typeof response.nextCursor !== "string" || response.nextCursor.length > 160 || !SLUG.test(response.nextCursor)))) throw new Error("invalid candidates response");
    const items = response.items.map((raw) => {
      const item = object(raw);
      if (Object.keys(item).sort().join(",") !== "providerName,slug,title" || typeof item.slug !== "string" || !SLUG.test(item.slug) || typeof item.title !== "string" || typeof item.providerName !== "string") throw new Error("invalid candidates response");
      return { slug: item.slug, title: item.title, providerName: item.providerName };
    });
    return { items, nextCursor: response.nextCursor as string | null };
  }

  async checkRelated(writerNihoUserId: string, slugs: readonly string[]): Promise<readonly string[]> {
    const response = object(await this.post("/internal/article-authority/v1/check-related", { writerNihoUserId, slugs }));
    if (response.version !== 1 || !Array.isArray(response.allowedSlugs) || response.allowedSlugs.some((slug) => typeof slug !== "string" || !SLUG.test(slug))) throw new Error("invalid related response");
    return response.allowedSlugs as string[];
  }
}

export function experienceFactsSource(writerNihoUserId: string, client = new ExperienceArticleAuthorityClient()): FactsSource {
  return {
    async read(query) {
      if (query.dest !== "exp") return { relatedLive: query.related.length === 0 };
      const [categories, allowed] = await Promise.all([client.categories(), client.checkRelated(writerNihoUserId, query.related)]);
      const selected = query.category === null ? undefined : categories.find((item) => item.slug === query.category);
      return {
        relatedLive: allowed.length === query.related.length && allowed.every((slug, index) => slug === query.related[index]),
        categoryCurrent: selected !== undefined,
        ...(selected === undefined ? {} : { categoryDisplay: { labelEn: selected.labelEn, labelJa: selected.labelJa, displayOrder: selected.displayOrder, revision: selected.revision } }),
      };
    },
  };
}
