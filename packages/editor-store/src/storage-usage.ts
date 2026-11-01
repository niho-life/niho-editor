import type { OwnerId, Queryable } from "./types.ts";

/** NIHO editor の保存メディア使用量。JSON で bigint を安全に運ぶため、byte 数は十進文字列。 */
export type MediaStorageUsage = {
  totalBytes: string;
  imageBytes: string;
  audioBytes: string;
};

type UsageRow = { image_bytes: string; audio_bytes: string };

/**
 * owner のクラウドメディア使用量。アップロード済みの画像と、保持期限内のアップロード済み音声だけを数える。
 * ゴミ箱内のページも、完全削除まで object が残るため含める。本文・版履歴は DB 内なので対象外。
 */
export async function getMediaStorageUsage(db: Queryable, owner: OwnerId): Promise<MediaStorageUsage> {
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 256) {
    throw new TypeError("editor-store: owner must be a non-empty stable user id");
  }

  const result = await db.query<UsageRow>(
    `WITH active_audio AS (
       SELECT r.owner, r.audio_asset AS asset_id
       FROM page_recordings AS r
       WHERE r.owner = $1 AND r.audio_status = 'uploaded'
         AND (r.audio_expires_at IS NULL OR r.audio_expires_at > clock_timestamp())
       UNION
       SELECT ra.owner, ra.asset AS asset_id
       FROM page_recording_audios AS ra
       WHERE ra.owner = $1 AND ra.status = 'uploaded'
         AND (ra.expires_at IS NULL OR ra.expires_at > clock_timestamp())
     )
     SELECT
       COALESCE((
         SELECT SUM(a.bytes)::text
         FROM assets AS a
         WHERE a.owner = $1 AND a.kind = 'image' AND a.upload_status = 'ready'
       ), '0') AS image_bytes,
       COALESCE((
         SELECT SUM(a.bytes)::text
         FROM active_audio AS aa
         JOIN assets AS a ON a.owner = aa.owner AND a.id = aa.asset_id
         WHERE a.kind = 'audio' AND a.upload_status = 'ready'
       ), '0') AS audio_bytes`,
    [owner],
  );

  const imageBytes = result.rows[0]?.image_bytes ?? "0";
  const audioBytes = result.rows[0]?.audio_bytes ?? "0";
  return { imageBytes, audioBytes, totalBytes: (BigInt(imageBytes) + BigInt(audioBytes)).toString() };
}
