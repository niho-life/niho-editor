import "server-only";
import { getPageFields, imageAsset, recordPageOpen, savePageFields } from "@niho/editor-store";
import { getAuthProvider } from "../auth";
import type { FolderExportPhoto } from "../export/folder";
import { storageAssetBytes } from "../publish/export-assets";
import { getStorage } from "../storage/runtime";
import { getPool, getStore } from "./db";
import type { FolderApiDeps, FolderPhotoSource } from "./folder-api";

/**
 * フォルダまわりの route（並び・子の一覧・欄・「最近」・書き出し。#37）の実行時の依存。
 * deps.ts と並行して触らないよう、ここに置いている（ai-deps.ts・steps-deps.ts・settings-deps.ts と同じ作り）。
 */

/**
 * 書き出しの写真。資産の控え（sha256・種類）を DB から読み、中身を保存先から読む。
 * 1 回の書き出しで読む合計には上限がある（`storageAssetBytes`。超えたら以降は読まずに null）。
 */
function photoSource(): FolderPhotoSource | null {
  const pool = getPool();
  const storage = getStorage(process.env);
  if (!pool || !storage) return null;
  const reader = storageAssetBytes(storage);
  return {
    read: async (owner, assetId): Promise<FolderExportPhoto | null> => {
      const asset = await imageAsset(pool, owner, assetId);
      // 途中のアップロード・別の人の資産は読まない
      if (!asset || asset.status !== "ready") return null;
      const bytes = await reader.port.read({ id: assetId, sha256: asset.sha256, contentType: asset.contentType });
      return bytes ? { sha256: asset.sha256, contentType: asset.contentType, bytes } : null;
    },
  };
}

export const folderDeps: FolderApiDeps = {
  auth: () => getAuthProvider(),
  store: () => getStore(),
  fields: () => {
    const pool = getPool();
    if (!pool) return null;
    return {
      get: (owner, pageId) => getPageFields(pool, owner, pageId),
      save: (owner, pageId, patch) => savePageFields(pool, owner, pageId, patch),
    };
  },
  opens: () => {
    const pool = getPool();
    return pool ? (owner, pageId) => recordPageOpen(pool, owner, pageId) : null;
  },
  photos: photoSource,
};
