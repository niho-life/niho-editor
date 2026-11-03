import {
  draftFingerprint,
  type AssetRecord,
  type ConnectionRecord,
  type ConnectionStore,
  type ConnectionTx,
  type DraftFingerprints,
  type DraftPage,
  type KeyRecord,
  type PublicationRecord,
  type RedirectRecord,
  type Snapshot,
  type VersionRecord,
} from "@niho/editor-publish";
import {
  addPublicationVersion,
  connectionLive,
  deleteRedirect,
  findConnectionKeyBySha256,
  getConnection,
  getConnectionByHandle,
  getDraftPage,
  getPublication,
  getPublicationVersion,
  latestPublicationVersion,
  listConnectionKeys,
  listConnections,
  listDraftAssets,
  listPublicationsByHandle,
  managedTranslationReviewProblem,
  listRedirectsTo,
  putConnection,
  putConnectionKey,
  putPublication,
  putRedirect,
  takenSlugs,
  withTransaction,
  type ConnectionKeyRow,
  type Database,
  type DraftAssetRow,
  type DraftPageRow,
  type PublicationRow,
  type PublicationVersionRow,
  type Queryable,
  type RedirectRow,
  type SiteConnectionRow,
} from "@niho/editor-store";

/**
 * 公開（#39）と発信先の設定（#41）のポートの Postgres の実装。SQL は packages/editor-store の publications.ts、
 * 意味の正本は packages/editor-publish の test-support/memory-store.ts（「Must fail when …」の制約を含む）。
 *
 * ConnectionTx は PublishTx を含むので、この 1 つを PublishService の store と ConnectionService の store の両方に渡す。
 * transaction の中のロック:
 * - getPage はページの行を押さえる（同じページへの同時の公開を、初回も含めて直列にする。ゴミ箱ともすれ違わない）。
 * - getPublication は公開の行を FOR UPDATE で押さえる。
 * - connectionLive は接続の行を FOR SHARE で押さえる（公開が終わるまで解除を待たせる）。
 * - listPublicationsByHandle は公開の行を FOR UPDATE で押さえる（解除が読んだ公開を、同時の発信先の変更のあとに古い値で上書きしない）。
 * 失敗は例外のまま返す（サービスが `failed` にする）。ここでは何もログに出さない。
 */
export function pgPublishStore(db: Database): ConnectionStore {
  return {
    transaction: (work) =>
      withTransaction(db, async (client) => {
        let open = true;
        try {
          return await work(transactionOf(client, () => open));
        } finally {
          open = false;
        }
      }),
  };
}

/** 「更新あり」の比較に使う、いまの下書きの fingerprint（ページが無い・ゴミ箱なら null）。transaction の外で読む。 */
export function pgDraftFingerprints(db: Queryable): DraftFingerprints {
  return {
    async read(pageId) {
      const page = await getDraftPage(db, pageId);
      if (!page) return null;
      const assets = await listDraftAssets(db, pageId);
      return draftFingerprint(toDraftPage(page), assets.map(toAssetRecord));
    },
  };
}

function transactionOf(client: Queryable, isOpen: () => boolean): ConnectionTx {
  // 終わった transaction の接続（Pool に返したもの）を使わせない
  const db = (): Queryable => {
    if (!isOpen()) throw new Error("publish store: the transaction is closed");
    return client;
  };
  return {
    getPage: async (pageId) => {
      const page = await getDraftPage(db(), pageId, { lock: true });
      return page ? toDraftPage(page) : null;
    },
    reviewGate: async (actorId, pageId, handle) => {
      if (handle !== "exp") return null;
      const problem = await managedTranslationReviewProblem(db(), actorId, pageId);
      if (problem === null) return null;
      const message = problem === "source_missing"
        ? "翻訳元が見つかりません。対応を復元するか、確認して独立した英語ページにしてください"
        : problem === "source_updated"
          ? "日本語の原文が更新されています。英語との対応を確認してください"
          : problem === "target_updated"
            ? "英語版が更新されています。公開前に内容を確認してください"
            : "管理翻訳の言語設定を確認してください";
      return { id: `translation-${problem}`, message, fix: "body" };
    },
    listAssets: async (pageId) => (await listDraftAssets(db(), pageId)).map(toAssetRecord),
    getPublication: async (pageId) => {
      const row = await getPublication(db(), pageId, { lock: true });
      return row ? toPublicationRecord(row) : null;
    },
    takenSlugs: (handle, base, exceptPageId) => takenSlugs(db(), handle, base, exceptPageId),
    latestVersion: (pageId) => latestPublicationVersion(db(), pageId),
    addVersion: (record) => addPublicationVersion(db(), toVersionRow(record)),
    putPublication: (record) => putPublication(db(), toPublicationRow(record)),
    listRedirectsTo: async (to) => (await listRedirectsTo(db(), { handle: to.handle, slug: to.slug })).map(toRedirectRecord),
    putRedirect: (record) => putRedirect(db(), toRedirectRow(record)),
    deleteRedirect: (from) => deleteRedirect(db(), { handle: from.handle, slug: from.slug }),

    connectionLive: (actorId, handle) => connectionLive(db(), actorId, handle),
    getConnection: async (connectionId, options) => {
      const row = await getConnection(db(), connectionId, options);
      return row ? toConnectionRecord(row) : null;
    },
    getConnectionByHandle: async (handle) => {
      const row = await getConnectionByHandle(db(), handle);
      return row ? toConnectionRecord(row) : null;
    },
    listConnections: async (ownerId) => (await listConnections(db(), ownerId)).map(toConnectionRecord),
    putConnection: (record) => putConnection(db(), toConnectionRow(record)),
    listKeys: async (connectionId) => (await listConnectionKeys(db(), connectionId)).map(toKeyRecord),
    findKeyBySha256: async (sha256) => {
      const row = await findConnectionKeyBySha256(db(), sha256);
      return row ? toKeyRecord(row) : null;
    },
    putKey: (record) => putConnectionKey(db(), toKeyRow(record)),
    listPublicationsByHandle: async (handle) => (await listPublicationsByHandle(db(), handle, { lock: true })).map(toPublicationRecord),
    getVersion: async (pageId, version) => {
      const row = await getPublicationVersion(db(), pageId, version);
      return row ? toVersionRecord(row) : null;
    },
  };
}

// --- 行とレコードの写し ---------------------------------------------------------------

function toDraftPage(row: DraftPageRow): DraftPage {
  return {
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    lang: row.lang,
    lead: row.lead,
    coverAssetId: row.coverAssetId,
    content: row.content,
  };
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
  };
}

function toPublicationRecord(row: PublicationRow): PublicationRecord {
  return {
    pageId: row.pageId,
    dest: row.dest,
    handle: row.handle,
    slug: row.slug,
    range: row.range,
    extras: { app: row.extras.app, news: row.extras.news, xp: row.extras.xp },
    category: row.category,
    related: [...row.related],
    version: row.version,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    stoppedAt: row.stoppedAt,
  };
}

function toPublicationRow(record: PublicationRecord): PublicationRow {
  return {
    pageId: record.pageId,
    dest: record.dest,
    handle: record.handle,
    slug: record.slug,
    range: record.range,
    extras: { app: record.extras.app, news: record.extras.news, xp: record.extras.xp },
    category: record.category,
    related: [...record.related],
    version: record.version,
    publishedAt: record.publishedAt,
    updatedAt: record.updatedAt,
    stoppedAt: record.stoppedAt,
  };
}

function toVersionRow(record: VersionRecord): PublicationVersionRow {
  return { pageId: record.pageId, version: record.version, handle: record.handle, snapshot: record.snapshot };
}

/** 公開版は buildSnapshot が契約で検証してから書いたもの。読み戻した JSON をそのまま Snapshot として渡す。 */
function toVersionRecord(row: PublicationVersionRow): VersionRecord {
  return { pageId: row.pageId, version: row.version, handle: row.handle, snapshot: row.snapshot as Snapshot };
}

function toRedirectRecord(row: RedirectRow): RedirectRecord {
  return {
    from: { handle: row.from.handle, slug: row.from.slug },
    to: row.to === "list" ? "list" : { handle: row.to.handle, slug: row.to.slug },
    pageId: row.pageId,
    createdAt: row.createdAt,
  };
}

function toRedirectRow(record: RedirectRecord): RedirectRow {
  return {
    from: { handle: record.from.handle, slug: record.from.slug },
    to: record.to === "list" ? "list" : { handle: record.to.handle, slug: record.to.slug },
    pageId: record.pageId,
    createdAt: record.createdAt,
  };
}

function toConnectionRecord(row: SiteConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    handle: row.handle,
    mode: row.mode,
    siteUrl: row.siteUrl,
    urlShape: { host: row.urlShape.host, path: row.urlShape.path },
    assetPolicy: row.assetPolicy,
    pushEnabled: false,
    createdAt: row.createdAt,
    removedAt: row.removedAt,
  };
}

function toConnectionRow(record: ConnectionRecord): SiteConnectionRow {
  return {
    id: record.id,
    ownerId: record.ownerId,
    handle: record.handle,
    mode: record.mode,
    siteUrl: record.siteUrl,
    urlShape: { host: record.urlShape.host, path: record.urlShape.path },
    assetPolicy: record.assetPolicy,
    pushEnabled: record.pushEnabled,
    createdAt: record.createdAt,
    removedAt: record.removedAt,
  };
}

function toKeyRecord(row: ConnectionKeyRow): KeyRecord {
  return {
    id: row.id,
    connectionId: row.connectionId,
    sha256: row.sha256,
    last4: row.last4,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

function toKeyRow(record: KeyRecord): ConnectionKeyRow {
  return {
    id: record.id,
    connectionId: record.connectionId,
    sha256: record.sha256,
    last4: record.last4,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  };
}
