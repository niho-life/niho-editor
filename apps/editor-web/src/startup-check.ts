import { resolveAuthMode } from "./auth/config";
import { resolveStorageConfig } from "./storage/config";
import { resolveGoogleDocsConfig } from "./google-docs/config";
import { resolveGoogleDocsBatchConfig } from "./google-docs/batch-config";
import { resolveTranscriptionConfig } from "./transcription/config";
import { parseRateLimit, RATE_LIMIT_ENV } from "./public-api/rate-limit";

/** 起動時の設定の検査（Node のサーバーでだけ読む。src/instrumentation.ts）。誤りなら値を出さずに終了する。 */
export function checkStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  try {
    resolveAuthMode(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid auth configuration";
    console.error(`editor-web: refusing to start: ${message}`);
    process.exit(1);
  }
  // 資産の保存先（#36 段 2a）: 本番の fake・gcs で bucket 名が無い／不正・未知の値は起動しない（メッセージに値を出さない）
  try {
    resolveStorageConfig(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid storage configuration";
    console.error(`editor-web: refusing to start: ${message}`);
    process.exit(1);
  }
  // 文字起こし（#36 段 2b）: 本番の fake・deepgram で鍵が無い／不正・未知の値・時間切れの範囲の外は起動しない（メッセージに値を出さない）
  try {
    resolveTranscriptionConfig(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid transcription configuration";
    console.error(`editor-web: refusing to start: ${message}`);
    process.exit(1);
  }
  // Google ドキュメントの書き出し: 未知の方式・API の起点や returnTo の形が不正なら起動しない（メッセージに値を出さない）
  try {
    resolveGoogleDocsConfig(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid Google Docs configuration";
    console.error(`editor-web: refusing to start: ${message}`);
    process.exit(1);
  }
  try {
    resolveGoogleDocsBatchConfig(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid Google Docs batch configuration";
    console.error(`editor-web: refusing to start: ${message}`);
    process.exit(1);
  }
  // 公開 API（#40）の rate limit は不正なら既定。値は出さずに不正とだけ書く
  if (parseRateLimit(env[RATE_LIMIT_ENV]) === "invalid") {
    console.error(`editor-web: ${RATE_LIMIT_ENV} is invalid; using the default`);
  }
}
