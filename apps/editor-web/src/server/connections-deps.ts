import "server-only";
import { countLivePublishedByHandle } from "@niho/editor-store";
import { getStorage } from "../storage/runtime";
import { storageAssetBytes } from "../publish/export-assets";
import { pgDraftFingerprints, pgPublishStore } from "../publish/pg-store";
import { roleReaderOf, wirePublishPorts } from "../publish/ports";
import type { ConnectionsApiDeps } from "./connections-api";
import { getAuthProvider } from "../auth";
import { NihoExperienceApiClient } from "../auth/niho-experience-api";
import { publishConfig } from "../publish/config";
import { getPool } from "./db";

/**
 * 発信先の設定の route（`/api/destinations/**`。#41）の実行時の依存（DB・保存先は要求のたびに遅延して決める。
 * Pool は getStore と共有）。deps.ts と並行して触らないよう、ここに置いている（ai-deps.ts・steps-deps.ts と同じ作り）。
 * 書き出しの写真の読み出しは**要求ごとに 1 つ**作る（1 回の書き出しで読む合計を数えるため）。
 */
export const connectionsDeps: ConnectionsApiDeps = {
  auth: () => getAuthProvider(),
  ports: (session, request) => {
    const pool = getPool();
    const auth = getAuthProvider();
    return pool ? wirePublishPorts(pgPublishStore(pool), session, {
      drafts: pgDraftFingerprints(pool),
      roles: roleReaderOf(publishConfig(process.env), session, async () => {
        const result = await new NihoExperienceApiClient(auth).roles(session, request);
        return result.destinations.includes("exp") && result.roles.includes("writer") ? ["writer"] : [];
      }),
    }) : null;
  },
  counts: () => {
    const pool = getPool();
    return pool ? (owner, handles) => countLivePublishedByHandle(pool, owner, handles) : null;
  },
  exportAssets: () => {
    const storage = getStorage(process.env);
    return storage ? storageAssetBytes(storage) : null;
  },
};
