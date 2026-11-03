import { getPool } from "@/server/db";
import { pgPublicAssetStore, readPublicAssetRoute } from "@/server/public-asset-api";
import { getStorage } from "@/storage/runtime";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ file: string }> };

export async function GET(_request: Request, context: Context): Promise<Response> {
  const { file } = await context.params;
  return readPublicAssetRoute(file, {
    store: () => { const pool = getPool(); return pool ? pgPublicAssetStore(pool) : null; },
    storage: () => getStorage(),
  });
}
