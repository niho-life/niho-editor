import {
  buildSnapshot,
  destinationUrl,
  parseDestinationDeclaration,
  siteDeclarationSource,
  slugFromTitle,
  type AssetRecord,
  type AssetUrls,
  type DeclarationSource,
  type DraftPage,
} from "@niho/editor-publish";
import { isFaceDest, parsePublishedDoc, type Author, type CategoryDisplay, type Extras, type PublicationRange } from "@niho/editor-publish-contract";
import {
  connectionByKeySha256,
  createPreviewToken,
  findPreviewToken,
  getDraftPage,
  getPublication,
  getPublicationVersion,
  listDraftAssets,
  listLivePublished,
  publishDestOfHandle,
  readPublishedForHandle,
  withTransaction,
  type Database,
  type DraftAssetRow,
  type DraftPageRow,
  type PublicationRow,
} from "@niho/editor-store";
import { pgPublishStore } from "../publish/pg-store";
import type { PreviewTokenStore } from "../server/preview-token-api";
import type { DraftContent, PublicApiSource, PublishedListRow, PublishedLookup, PublishedSnapshot } from "./source";

/**
 * 公開 API v1（#40）の PublicApiSource の Postgres の実装。SQL は packages/editor-store の publications.ts。
 * 答えの意味は testing/world-source.ts（参照モデルの world）と同じで、pg-source.pg.test.ts が同じ操作のあとの応答を突き合わせる。
 *
 * - 失効・解除・公開をやめた・移動は、記録されていれば `now` によらず効いている（source.ts の約束の、読めない側の実装）。
 *   期限（プレビュー token）は `now` と比べる。
 * - 一覧の位置の時刻は、公開の updated_at（PublishService の時計のミリ秒の値）をマイクロ秒の文字列にして渡す。
 * - プレビューは、ページ・資産・公開・公開版を 1 つの読み取りの transaction（REPEATABLE READ）で読み、現在の下書きから
 *   buildSnapshot で組む。version と時刻はページの保存の版（revision）と時刻（updated_at）。
 *   著者は token に結んだもの（発行したときの本人。0009）で、無ければいまの公開版の著者。どちらも無ければ組めない（404）。
 *   公開用の著者紹介（authorProfile）はプレビューには入れない（token に結んでいない。公開版だけが持つ）。
 *   共有画像の許諾（coverShareable）はいまの下書きの資産から組む（公開と同じ）。
 */

export interface PgPublicApiOptions {
  /**
   * プレビューの写真の URL（公開と同じ資産の置き場。実行時は src/publish/ports.ts の assetUrlsOf と `EDITOR_ASSET_ORIGIN`）。
   * 作れない（置き場の未設定）ときは、写真のある下書きのプレビューは 503（公開版の URL は公開版の中にある）。
   */
  readonly assetUrls: AssetUrls;
  /**
   * この handle に公開していないページのプレビューの URL に使う、面の宣言（本人のサイトは接続の設定から作る。実行時は
   * src/publish/ports.ts の faceDeclarations）。無ければ、面へのそのプレビューは組めない（404）。
   */
  readonly declarations?: DeclarationSource;
}

/** この handle での URL と、シートの設定（公開の前の既定か、この handle の公開の設定）。 */
interface Placement {
  readonly slug: string;
  readonly canonicalUrl: string;
  readonly range: PublicationRange;
  readonly extras: Extras;
  readonly category: string | null;
  readonly categoryDisplay?: CategoryDisplay;
  readonly related: readonly string[];
  readonly author: Author;
}

/** この handle に公開したことが無いページの、公開の前の既定の設定。 */
const DEFAULT_SETTINGS = { range: "live", extras: { app: false, news: false, xp: false }, category: null, related: [] } as const;

function toDraftPage(row: DraftPageRow): DraftPage {
  return { id: row.id, ownerId: row.ownerId, title: row.title, lang: row.lang, lead: row.lead, coverAssetId: row.coverAssetId, content: row.content };
}

function toAssetRecord(row: DraftAssetRow): AssetRecord {
  return {
    id: row.id,
    kind: row.kind,
    bytes: row.bytes,
    sha256: row.sha256,
    contentType: row.contentType,
    alt: row.alt,
    credit: row.credit,
    consent: row.consent,
    share: row.share,
  };
}

function authorOf(snapshot: unknown): Author | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const author = (snapshot as { author?: unknown }).author;
  if (typeof author !== "object" || author === null) return null;
  const { name, handle, url } = author as Record<string, unknown>;
  if (typeof name !== "string" || (handle !== null && typeof handle !== "string") || (url !== null && typeof url !== "string")) return null;
  return { name, handle, url };
}

function canonicalUrlOf(snapshot: unknown): string | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const url = (snapshot as { canonicalUrl?: unknown }).canonicalUrl;
  return typeof url === "string" ? url : null;
}

/** Preview may preserve only metadata already fixed into a validated published snapshot. */
function categoryDisplayOf(snapshot: unknown): CategoryDisplay | undefined {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return undefined;
  const document = { ...snapshot as Record<string, unknown> };
  delete document.fingerprint;
  const parsed = parsePublishedDoc(document, { requireProjection: true });
  return parsed.ok ? parsed.value.categoryDisplay : undefined;
}

/** 一覧の位置の時刻（ミリ秒の ISO）→ editor-store の cursor の時刻（マイクロ秒の文字列）。 */
function microseconds(iso: string): string {
  return `${new Date(Date.parse(iso)).toISOString().slice(0, -1)}000Z`;
}

export function pgPublicApiSource(db: Database, options: PgPublicApiOptions): PublicApiSource {
  const declarations = siteDeclarationSource(pgPublishStore(db), options.declarations);

  /** この handle に公開したことが無い（または離れた）ページの URL（著者は呼び出し側が決める）。組めなければ null。 */
  async function placeElsewhere(page: DraftPageRow, handle: string, author: Author): Promise<Placement | null> {
    const parsed = parseDestinationDeclaration(await declarations.get(handle));
    if (!parsed.ok) return null;
    const slug = slugFromTitle(page.title, page.id);
    return { ...DEFAULT_SETTINGS, slug, canonicalUrl: destinationUrl(parsed.value, slug), author };
  }

  return {
    async siteHandleByKeyHash(sha256) {
      return (await connectionByKeySha256(db, sha256))?.handle ?? null;
    },

    async listPublished({ handle, includeUnlisted, after, limit }) {
      const items: Awaited<ReturnType<typeof listLivePublished>>["items"] = [];
      let cursor = after ? { updatedAt: microseconds(after.updatedAt), pageId: after.id } : null;
      // store は 1 回に返す件数に上限があり、続きは `next` で返す。呼び出し側は「limit 件より多く返れば続きがある」で次のページを決める
      // （最大の件数を頼むと limit + 1 件になる）ので、上限で切れたときは続きを読んで、先読みの行まで返す
      while (items.length < limit) {
        const chunk = await listLivePublished(db, handle, { includeUnlisted, limit: limit - items.length, after: cursor });
        items.push(...chunk.items);
        if (chunk.next === null) break;
        cursor = chunk.next;
      }
      return items.map((item): PublishedListRow => ({
        range: item.publication.range,
        snapshot: item.listing as PublishedListRow["snapshot"],
      }));
    },

    async getPublished(handle, pageId): Promise<PublishedLookup> {
      const found = await readPublishedForHandle(db, handle, pageId);
      if (found === null) return { state: "none" };
      if (found.status === "live") {
        return { state: "published", row: { range: found.publication.range, snapshot: found.snapshot as PublishedSnapshot } };
      }
      const movedTo = found.movedTo && isFaceDest(found.movedTo.dest) ? { dest: found.movedTo.dest, canonicalUrl: found.movedTo.canonicalUrl } : null;
      return { state: "left", range: found.range, movedTo };
    },

    async previewTokenByHash(sha256, now) {
      const token = await findPreviewToken(db, sha256, now);
      return token
        ? { pageId: token.pageId, handle: token.handle, issuedAt: token.issuedAt, expiresAt: token.expiresAt, author: token.author }
        : null;
    },

    async previewDraft({ pageId, handle, author: bound }) {
      const dest = publishDestOfHandle(handle);
      if (dest === null) return null;
      // ページ・資産・公開・公開版を同じ時点で読む（保存の版と本文が食い違わない）
      const read = await withTransaction(db, async (client) => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        const page = await getDraftPage(client, pageId);
        if (!page) return null;
        const assets = await listDraftAssets(client, pageId);
        const publication: PublicationRow | null = await getPublication(client, pageId);
        const current = publication ? (await getPublicationVersion(client, pageId, publication.version))?.snapshot ?? null : null;
        return { page, assets, publication, current };
      });
      if (!read) return null;
      const { page, assets, publication, current } = read;
      // 著者は token に結んだもの（発行したときの本人。公開・更新が本人の名前で組むのと同じ）。無ければいまの公開版の著者
      const author = bound ?? authorOf(current);
      if (author === null) return null;
      let placement: Placement | null;
      if (publication !== null && publication.handle === handle) {
        // この handle の公開（やめたものも含む）の設定と、いまの公開版の URL（参照モデルの world と同じ）
        const canonicalUrl = canonicalUrlOf(current);
        const categoryDisplay = categoryDisplayOf(current);
        placement = canonicalUrl === null ? null : {
          slug: publication.slug,
          canonicalUrl,
          range: publication.range,
          extras: publication.extras,
          category: publication.category,
          ...(categoryDisplay === undefined ? {} : { categoryDisplay }),
          related: publication.related,
          author,
        };
      } else {
        placement = await placeElsewhere(page, handle, author);
      }
      if (placement === null) return null;
      const built = await buildSnapshot({
        page: toDraftPage(page),
        assets: assets.map(toAssetRecord),
        dest,
        ...placement,
        version: page.revision,
        publishedAt: page.savedAt,
        updatedAt: page.savedAt,
        assetUrls: options.assetUrls,
      });
      if (!built.ok) return null;
      const { snapshot } = built;
      const content: DraftContent = {
        slug: snapshot.slug,
        lang: snapshot.lang,
        title: snapshot.title,
        lead: snapshot.lead,
        cover: snapshot.cover,
        ...(snapshot.coverShareable === undefined ? {} : { coverShareable: snapshot.coverShareable }),
        category: snapshot.category,
        ...(snapshot.categoryDisplay === undefined ? {} : { categoryDisplay: snapshot.categoryDisplay }),
        author: snapshot.author,
        range: snapshot.range,
        canonicalUrl: snapshot.canonicalUrl,
        extras: snapshot.extras,
        related: snapshot.related,
        blocks: snapshot.blocks,
        assets: snapshot.assets,
      };
      return { revision: page.revision, savedAt: page.savedAt, content };
    },
  };
}

/** プレビュー token の保存先（ハッシュと、発行した本人の著者だけ。本人の・ゴミ箱でないページのときだけ書く）。 */
export function pgPreviewTokenStore(db: Database): PreviewTokenStore {
  return {
    async issue(owner, record) {
      const created = await createPreviewToken(db, {
        sha256: record.sha256,
        pageId: record.pageId,
        ownerId: owner,
        handle: record.handle,
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
        author: record.author,
      });
      return created !== null;
    },
  };
}
