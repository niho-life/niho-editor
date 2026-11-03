import { assertOwner } from "./recordings.ts";
import type { OwnerId, Queryable } from "./types.ts";

export const EDITOR_AUTH_MODES = ["niho", "google", "stub"] as const;
export type EditorAuthMode = (typeof EDITOR_AUTH_MODES)[number];

/**
 * owner id から推測できない、認証方式別の端末内音声 cache namespace を原子的に取得する。
 * 競合した初回 INSERT は先行 transaction の確定を待ち、その直後の SELECT で同じ UUID を読む。
 */
export async function getOrCreateNativeAudioCacheNamespace(
  db: Queryable,
  owner: OwnerId,
  authMode: EditorAuthMode,
): Promise<string> {
  assertOwner(owner);
  if (!(EDITOR_AUTH_MODES as readonly string[]).includes(authMode)) {
    throw new TypeError("editor-store: unknown auth mode");
  }
  const inserted = await db.query<{ namespace: string }>(
    `INSERT INTO native_audio_cache_namespaces (owner, auth_mode)
     VALUES ($1, $2)
     ON CONFLICT (owner, auth_mode) DO NOTHING
     RETURNING namespace::text AS namespace`,
    [owner, authMode],
  );
  if (inserted.rows[0]) return inserted.rows[0].namespace;
  const existing = await db.query<{ namespace: string }>(
    `SELECT namespace::text AS namespace
       FROM native_audio_cache_namespaces
      WHERE owner = $1 AND auth_mode = $2`,
    [owner, authMode],
  );
  const namespace = existing.rows[0]?.namespace;
  if (!namespace) throw new Error("editor-store: native audio cache namespace disappeared");
  return namespace;
}
