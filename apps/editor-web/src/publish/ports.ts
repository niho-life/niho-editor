import "server-only";
import {
  connectionSource,
  draftFingerprint,
  siteDeclarationSource,
  type AssetBytes,
  type AssetUrls,
  type AuthorSource,
  type Clock,
  type ConnectionPorts,
  type ConnectionStore,
  type DeclarationSource,
  type DraftFingerprints,
  type FactsSource,
  type PublishPorts,
  type RoleReader,
  type ServerFacts,
  type StorageModeReader,
} from "@niho/editor-publish";
import type { Session } from "../auth/types";
import { publishConfig, type PublishEnv } from "./config";

/**
 * 公開（#39）のポートの組み立て。store（Postgres）以外を、要求の本人（session）ごとに作る。
 * store は `pgPublishStore(pool)`（src/publish/pg-store.ts。src/server/deps.ts がつなぐ）。テストは MemoryPublishStore。
 *
 * - roles: 運営面を閉鎖したため常に空。本人サイトは接続の所有で認可する。
 * - declarations: 本人のサイトは接続の設定から（editor-publish の siteDeclarationSource）。
 * - authors: session の profile の名前（handle・url は null）。名前が無ければ公開を失敗にする。公開用の著者紹介（肩書・紹介文）は
 *   設定から読み（options.authorProfile）、公開版の authorProfile に固定する。読めなければ公開を失敗にする（黙って落とさない）。
 * - facts: 本人サイト向けの追加事実は無い。
 * - assetUrls: `EDITOR_ASSET_ORIGIN` から `${origin}/assets/${sha256}.${ext}`。未設定なら例外（写真のあるページの公開は失敗する）。
 *
 * 公開 API（#40）のプレビューも同じ写真 URL を使う。著者はプレビュー token 発行時に結ぶ。
 */

export type PublishWiring = {
  /** PublishService と、シートの評価が使う。 */
  readonly publish: PublishPorts;
  /** ConnectionService が使う（シートでは本人の接続の一覧だけ）。 */
  readonly connections: ConnectionPorts;
  /** 写真の置き場所（EDITOR_ASSET_ORIGIN）があるか。無ければ写真のあるページは公開できない（何度試しても同じ）。 */
  readonly photosReady: boolean;
};

export type PublishWiringOptions = {
  readonly env?: PublishEnv;
  readonly clock?: Clock;
  /** 「更新あり」の比較（ConnectionService の公開中の一覧）。省略すると store の transaction で読む。Postgres は pgDraftFingerprints。 */
  readonly drafts?: DraftFingerprints;
  /** 書き出し（#41）の写真の読み出し。省略すると写真を読めない（写真のあるページは書き出せない）。 */
  readonly assetBytes?: AssetBytes;
  /** Historical final-stage titles for a page, used to reject an untouched generated title at publish time. */
  readonly finalStepNames?: (actorId: string, pageId: string) => Promise<readonly string[]>;
  readonly facts?: FactsSource;
  /** 公開用の著者紹介（設定 › 公開用の著者紹介）。省略すると著者紹介なしで公開する。 */
  readonly authorProfile?: AuthorProfileReader;
};

/** 本人の公開用の著者紹介（肩書・紹介文。空は null）。無ければ null。 */
export type AuthorProfileReader = (actorId: string) => Promise<{ readonly role: string | null; readonly bio: string | null } | null>;

export const systemClock: Clock = { now: () => new Date().toISOString() };

/** 本人サイトには運営面固有の追加事実を要求しない。 */
export const UNKNOWN_FACTS: FactsSource = { read: async () => ({ relatedLive: null }) };

/** 写真を読まない（公開のシートは書き出しを使わない。書き出しの route は src/publish/export-assets.ts を渡す）。 */
export const NO_ASSET_BYTES: AssetBytes = { read: async () => null };

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export class AssetOriginMissing extends Error {
  override readonly name = "AssetOriginMissing";
  constructor() {
    super("EDITOR_ASSET_ORIGIN is not set");
  }
}

export const NO_ROLES: RoleReader = Object.freeze({ read: async () => [] });

/**
 * 保存先（設計 §2.1）。アカウントの設定で、保存しない。stub と niho の方式とも、NIHO から読む契約が出るまでは「未選択」（UNSET。
 * クラウドと同じ扱い）。要求の本人でなければ、読めないものとして LOCAL（公開しない）にする。
 */
export function storageModeReaderOf(session: Session): StorageModeReader {
  return {
    async read(actorId) {
      return actorId === session.userId ? "UNSET" : "LOCAL";
    },
  };
}

export function sessionAuthors(session: Session, profile?: AuthorProfileReader): AuthorSource {
  return {
    async read(actorId) {
      const name = session.profile?.name.trim();
      if (actorId !== session.userId || !name) throw new Error("author profile is not available");
      const introduction = profile ? await profile(actorId) : null;
      return introduction ? { name, handle: null, url: null, profile: { role: introduction.role, bio: introduction.bio } } : { name, handle: null, url: null };
    },
  };
}

export function assetUrlsOf(origin: string | null): AssetUrls {
  return {
    urlFor(asset) {
      if (origin === null) throw new AssetOriginMissing();
      const extension = IMAGE_EXTENSIONS[asset.contentType];
      if (!extension || !/^[0-9a-f]{64}$/.test(asset.sha256)) throw new Error("unsupported asset");
      return `${origin}/assets/${asset.sha256}.${extension}`;
    },
  };
}

/** 今の下書きの fingerprint（「更新あり」の判定）。store の page と資産から作る。 */
export function storeDraftFingerprints(store: ConnectionStore): DraftFingerprints {
  return {
    async read(pageId) {
      const read = await store.transaction(async (tx) => {
        const page = await tx.getPage(pageId);
        return page ? { page, assets: await tx.listAssets(pageId) } : null;
      });
      return read ? draftFingerprint(read.page, read.assets) : null;
    },
  };
}

/** Operating faces are retired. This source never performs upstream I/O. */
export const NO_FACE_DECLARATIONS: DeclarationSource = Object.freeze({ get: async () => null });

/** store 以外の PublishPorts・ConnectionPorts を組み立てる（実行時の配線は src/server/deps.ts の publishDeps）。 */
export function wirePublishPorts(store: ConnectionStore, session: Session, options: PublishWiringOptions = {}): PublishWiring {
  const config = publishConfig(options.env);
  const clock = options.clock ?? systemClock;
  const baseFacts = options.facts ?? UNKNOWN_FACTS;
  const facts: FactsSource = options.finalStepNames ? {
    read: async (query) => ({
      ...await baseFacts.read(query),
      finalStepNames: await options.finalStepNames!(query.actorId, query.pageId),
    } satisfies ServerFacts),
  } : baseFacts;
  return {
    publish: {
      store,
      roles: NO_ROLES,
      storage: storageModeReaderOf(session),
      connections: connectionSource(store),
      declarations: siteDeclarationSource(store, NO_FACE_DECLARATIONS),
      authors: sessionAuthors(session, options.authorProfile),
      facts,
      assetUrls: assetUrlsOf(config.assetOrigin),
      clock,
    },
    connections: { store, clock, drafts: options.drafts ?? storeDraftFingerprints(store), assetBytes: options.assetBytes ?? NO_ASSET_BYTES },
    photosReady: config.assetOrigin !== null,
  };
}
