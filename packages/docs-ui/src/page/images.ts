/*
 * 本文の画像の口（port）。実体の置き場（Web は private bucket、Mac は保管庫）は呼ぶ側が持ち、
 * エディタ（image-node.ts・ImageNodeView.tsx）はこの口だけを使う。通信はここに置かない。
 */

export type ImageMeta = { alt: string | null; credit: string | null; consent: boolean };

/** 断る理由（画面に出す文は image-node.ts が持つ）。 */
export type ImageProblem = "no_page" | "content_type" | "too_large" | "too_many" | "page_full" | "failed";

export type PageImageUploadResult = { ok: true; assetId: string; meta: ImageMeta } | { ok: false; problem: ImageProblem };

/** エディタ（image-node.ts）が使う口。テストでは差し替える。 */
export type PageImages = {
  /** ファイルを保存先に入れ、資産の id を返す。上限を超えるものは送らずに断る。 */
  upload: (file: File, pageId: string, signal?: AbortSignal) => Promise<PageImageUploadResult>;
  /** alt・クレジット・掲載許諾を保存する（資産の行が正本。本文の attrs は別に自動保存される）。 */
  saveMeta: (assetId: string, patch: Partial<ImageMeta>) => Promise<boolean>;
};

/** 資産の id から、画像を描く src を組む（Web はサーバーの中継の path、Mac は asset protocol の URL）。 */
export type ImageSrcOf = (assetId: string) => string;
