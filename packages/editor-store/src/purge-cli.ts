// npm run purge-trash — DATABASE_URL の DB で、ゴミ箱に 30 日より長くあるページを完全に消す。接続先の値・消した資産の位置は表示しない。
// 資産の実体（bucket の object）はここでは消さない（数だけを出す）。
import pg from "pg";
import { EditorStore } from "./store.ts";
import { purgeExpiredTranslationProposals } from "./translations.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  process.stderr.write("purge-trash: DATABASE_URL is not set\n");
  process.exit(2);
}

const pool = new pg.Pool({ connectionString, max: 1 });
try {
  const { pages, assetPaths } = await new EditorStore(pool).purgeTrash();
  const translationAssetPaths = await purgeExpiredTranslationProposals(pool);
  process.stdout.write(`purge-trash: ${pages} pages purged, ${assetPaths.length} asset rows removed, ${translationAssetPaths.length} unadopted translation object rows pending cleanup (objects are not deleted)\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`purge-trash: failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}
