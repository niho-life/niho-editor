export type ConformanceEvidence =
  | "db-handler"
  | "handler-precondition"
  | "partial"
  | "blocked";

export type ConformanceCase = {
  readonly id: string;
  readonly evidence: ConformanceEvidence;
  readonly test: string | null;
  readonly remaining: string | null;
};

/**
 * P00 の case ID を P12 が主張できる証拠レベルへ対応させる。
 * `partial` と `blocked` は合格ではない。特に実 provider・実 route の代替にしない。
 */
export const PHOTO_CONFORMANCE_CASES = [
  { id: "unauthenticated-library", evidence: "partial", test: "unauthenticated-library", remaining: "実NIHO認証 resolver" },
  { id: "owner-in-request", evidence: "handler-precondition", test: "auth/schema guard", remaining: null },
  { id: "foreign-photo", evidence: "db-handler", test: "foreign-photo", remaining: null },
  { id: "foreign-original", evidence: "db-handler", test: "owner-scoped content", remaining: null },
  { id: "foreign-upload", evidence: "db-handler", test: "owner-scoped upload mutations", remaining: null },
  { id: "foreign-purge-job", evidence: "db-handler", test: "foreign-purge-job", remaining: null },
  { id: "foreign-hash", evidence: "db-handler", test: "foreign-hash", remaining: null },
  { id: "foreign-cursor", evidence: "db-handler", test: "foreign-cursor", remaining: null },
  { id: "cookie-origin", evidence: "db-handler", test: "cookie-origin", remaining: null },
  { id: "revoked-content", evidence: "partial", test: "owner-scoped content", remaining: "実 session revocation resolver" },
  { id: "quota-boundary", evidence: "db-handler", test: "quota serialization", remaining: null },
  { id: "quota-concurrent-loser", evidence: "db-handler", test: "quota serialization", remaining: null },
  { id: "same-owner-existing", evidence: "db-handler", test: "completion replay and dedup", remaining: null },
  { id: "duplicate-complete", evidence: "db-handler", test: "completion replay and dedup", remaining: null },
  { id: "complete-in-progress", evidence: "db-handler", test: "active verification replay", remaining: null },
  { id: "cancel-verification", evidence: "db-handler", test: "cancel versus late completion", remaining: null },
  { id: "complete-after-cancel", evidence: "db-handler", test: "cancel versus late completion", remaining: null },
  { id: "complete-after-expiry", evidence: "db-handler", test: "expiry fence", remaining: null },
  { id: "changed-idempotency-payload", evidence: "db-handler", test: "completion replay and dedup", remaining: null },
  { id: "generation-race", evidence: "partial", test: "owner-scoped content", remaining: "実 GCS の generation precondition race" },
  { id: "recipe-stale", evidence: "db-handler", test: "recipe-stale", remaining: null },
  { id: "missing-mask", evidence: "partial", test: "missing-mask", remaining: "accepted SDK validator" },
  { id: "unknown-recipe", evidence: "db-handler", test: "unknown-recipe", remaining: null },
  { id: "stale-preview", evidence: "partial", test: "stale-preview", remaining: "media.ensure HTTP routeの409契約" },
  { id: "stored-media-failed", evidence: "partial", test: "stored-media-failed", remaining: "retry_media_onlyのmedia.ensure HTTP route" },
  { id: "trash-retains-quota", evidence: "db-handler", test: "trash-retains-quota", remaining: null },
  { id: "pending-purge-retains-quota", evidence: "partial", test: "pending-purge-retains-quota", remaining: "実 object delete provider/worker の未確認境界" },
  { id: "restore-after-purge", evidence: "db-handler", test: "restore-after-purge", remaining: null },
  { id: "account-deleting", evidence: "db-handler", test: "late lifecycle fences", remaining: null },
  { id: "format-spoof", evidence: "partial", test: "verification rejection", remaining: "実 decoder 受入" },
  { id: "file-limit", evidence: "handler-precondition", test: "verification rejection", remaining: null },
  { id: "negative-size", evidence: "handler-precondition", test: "verification rejection", remaining: null },
  { id: "pixel-limit", evidence: "partial", test: "verification rejection", remaining: "実 decoder 受入" },
  { id: "start-replay-verifying", evidence: "db-handler", test: "active verification replay", remaining: null },
] as const satisfies readonly ConformanceCase[];
