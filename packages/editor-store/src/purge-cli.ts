// Private-payload mode never deletes pages or objects; arguments and failures never print private data.
import pg from "pg";
import { EditorStore } from "./store.ts";
import { purgeExpiredTranslationProposals } from "./translations.ts";
import { executePurge, parsePurgeMode } from "./purge-command.ts";

let mode;
try { mode = parsePurgeMode(process.argv.slice(2)); }
catch { process.stderr.write("purge: invalid arguments\n"); process.exit(2); }
const connectionString = process.env.DATABASE_URL;
if (!connectionString) { process.stderr.write("purge: DATABASE_URL is not set\n"); process.exit(2); }
const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
try {
  const result = await executePurge(mode, {
    trash: () => new EditorStore(pool).purgeTrash(),
    privateJobs: () => purgeExpiredTranslationProposals(pool),
  });
  process.stdout.write(`purge: ${result.pages} pages, ${result.assets} asset rows, ${result.pendingObjects} pending object rows (objects are not deleted)\n`);
} catch {
  process.stderr.write("purge: failed\n"); process.exitCode = 1;
} finally { await pool.end().catch(() => undefined); }
