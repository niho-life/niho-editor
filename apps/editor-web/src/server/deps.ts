import "server-only";
import { connectionSource } from "@niho/editor-publish";
import {
  addRecordingCandidate,
  adoptRecordingCandidate,
  audioInfo,
  deleteRecordingCandidate,
  completeAudioPart,
  discardAudioPart,
  completeAudioUpload,
  completeImageUpload,
  countPageImages,
  createRecordingPage,
  duplicatePage,
  enableShare,
  enqueueTranscription,
  failRun,
  findImageUploadByKey,
  getRecording,
  getRecordingCandidate,
  getShare,
  imageAsset,
  latestRun,
  listAudioParts,
  listRecordingCandidates,
  rotateShare,
  searchPages,
  sharedImageAsset,
  startAudioPart,
  startAudioRecording,
  startImageUpload,
  stopShare,
  transcriptionStatus,
  updateImageMeta,
  updateRecording,
} from "@niho/editor-store";
import { getAuthProvider, getPhotoAuthProvider } from "../auth";
import type { AuthRoutesDeps } from "./auth-routes";
import { getGoogleDocsCredential, getGoogleDocsGateway } from "../google-docs/runtime";
import { publishConfig } from "../publish/config";
import { pgDraftFingerprints, pgPublishStore } from "../publish/pg-store";
import { assetUrlsOf, faceDeclarations, roleReaderOf, sessionAuthors, wirePublishPorts } from "../publish/ports";
import { getStorage } from "../storage/runtime";
import { availableTranscriptionEngines, resolveTranscriptionEngines } from "../transcription/config";
import { getTranscriptionRunner } from "../transcription/runtime";
import type { AudioApiDeps } from "./audio-api";
import type { AudioStreamApiDeps } from "./audio-stream-api";
import { getPool, getStore } from "./db";
import type { GoogleDocsApiDeps } from "./google-docs-api";
import type { ImageApiDeps } from "./images-api";
import { faceCredentialsFromEnv } from "../public-api/source";
import type { PublicApiRouteDeps } from "../public-api/http";
import { pgPreviewTokenStore, pgPublicApiSource } from "../public-api/pg-source";
import { createFixedWindowLimiter, rateLimitFromEnv, type RateLimiter } from "../public-api/rate-limit";
import type { PagesApiDeps } from "./pages-api";
import type { PreviewTokenApiDeps } from "./preview-token-api";
import type { PublishApiDeps } from "./publish-api";
import type { CandidatesApiDeps } from "./recording-candidates-api";
import type { RecordingsApiDeps } from "./recordings-api";
import type { SearchApiDeps } from "./search-api";
import type { ShareApiDeps } from "./share-api";
import type { TranscriptionApiDeps } from "./transcription-api";

/** 実行時の依存（方式の選択・DB の接続は要求のたびに遅延して決める）。`/auth/*` の route も同じものを使う。 */
export const runtimeDeps: PagesApiDeps & Pick<AuthRoutesDeps, "photoAuth"> = {
  auth: () => getAuthProvider(),
  photoAuth: () => getPhotoAuthProvider(),
  store: () => getStore(),
};

/** `/api/search` の実行時の依存（DB の接続は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const searchDeps: SearchApiDeps = {
  auth: () => getAuthProvider(),
  search: () => {
    const pool = getPool();
    return pool ? (owner, query, options) => searchPages(pool, owner, query, options) : null;
  },
};

/** 共有・複製・書き出し（#34）の実行時の依存（DB の接続は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const shareDeps: ShareApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const store = getStore();
    const pool = getPool();
    if (!store || !pool) return null;
    return {
      getShare: (owner, pageId) => getShare(pool, owner, pageId),
      enableShare: (owner, pageId) => enableShare(pool, owner, pageId),
      rotateShare: (owner, pageId) => rotateShare(pool, owner, pageId),
      stopShare: (owner, pageId) => stopShare(pool, owner, pageId),
      duplicatePage: (owner, pageId) => duplicatePage(pool, owner, pageId),
      // 書き出しは本人の・ゴミ箱でないページの最新の保存版（EditorStore.getPage と同じ絞り込み）
      getPage: (owner, pageId) => store.getPage(owner, pageId),
    };
  },
};

/** 録音と文字起こし（#36）の実行時の依存（DB の接続は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const recordingDeps: RecordingsApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const pool = getPool();
    if (!pool) return null;
    return {
      createRecordingPage: (owner, input) => createRecordingPage(pool, owner, input),
      getRecording: (owner, pageId) => getRecording(pool, owner, pageId),
      updateRecording: (owner, pageId, baseRevision, mutate) => updateRecording(pool, owner, pageId, baseRevision, mutate),
      latestTranscription: (owner, pageId) => latestRun(pool, owner, pageId),
      // 音声の列と文字起こしの案（#36 段 3b-4）
      listAudioParts: (owner, pageId) => listAudioParts(pool, owner, pageId),
      listCandidates: (owner, pageId) => listRecordingCandidates(pool, owner, pageId),
    };
  },
  // いま使えるエンジン（鍵が入っているもの）。画面は 2 つ以上あるときだけ案のエンジンを選べる
  engines: () => availableTranscriptionEngines(process.env),
  // 画面に渡すのは provider 名だけで、認証鍵やモデル設定は渡さない。
  defaultEngine: () => resolveTranscriptionEngines(process.env)?.default ?? null,
};

/** 文字起こしの案（#36 段 3b-4）の実行時の依存（DB・実行の呼び出し口は要求のたびに遅延して決める）。 */
export const candidatesDeps: CandidatesApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const pool = getPool();
    if (!pool) return null;
    return {
      getRecording: (owner, pageId) => getRecording(pool, owner, pageId),
      listCandidates: (owner, pageId) => listRecordingCandidates(pool, owner, pageId),
      getCandidate: (owner, pageId, candidateId) => getRecordingCandidate(pool, owner, pageId, candidateId),
      addCandidate: (owner, pageId, input) => addRecordingCandidate(pool, owner, pageId, input),
      adoptCandidate: (owner, pageId, candidateId) => adoptRecordingCandidate(pool, owner, pageId, candidateId),
      deleteCandidate: (owner, pageId, candidateId) => deleteRecordingCandidate(pool, owner, pageId, candidateId),
      enqueue: (owner, pageId, input) => enqueueTranscription(pool, owner, pageId, input),
      failRun: (runId, generation, errorCode) => failRun(pool, runId, generation, errorCode),
    };
  },
  runner: () => {
    const pool = getPool();
    return pool ? getTranscriptionRunner(pool, process.env) : null;
  },
};

/**
 * 公開 API v1（`/v1/*`。#40）の実行時の依存。データは Postgres（src/public-api/pg-source.ts。Pool は getStore と共有、DATABASE_URL が
 * 無ければ 503 temporarily_unavailable）。面の資格は `EDITOR_FACE_CREDENTIALS`（要求のたびに読み、値が変わらなければ読み直さない）。
 * rate limit は instance に 1 つ（`EDITOR_PUBLIC_API_RATE_LIMIT_PER_MINUTE`。最初の要求のときに読む）。
 * プレビューの写真の URL と面の宣言は公開のシート（#39）と同じ配線（`EDITOR_ASSET_ORIGIN`・`EDITOR_DESTINATION_DECLARATIONS`。
 * src/publish/config.ts）。著者は発行のときに token に結んだもの（previewTokenDeps）。
 */
let publicApiLimiter: RateLimiter | null = null;
export const publicApiDeps: PublicApiRouteDeps = {
  source: () => {
    const pool = getPool();
    if (!pool) return null;
    const config = publishConfig(process.env);
    return pgPublicApiSource(pool, { assetUrls: assetUrlsOf(config.assetOrigin), declarations: faceDeclarations(config.declarations) });
  },
  faces: () => faceCredentialsFromEnv(process.env),
  limiter: () => (publicApiLimiter ??= createFixedWindowLimiter(rateLimitFromEnv(process.env))),
};

/**
 * プレビュー token の発行（`POST /api/pages/{id}/preview-token`。#40）の実行時の依存。保存先と接続は Postgres（DB が無ければ 503）。
 * NIHO の役割と著者は公開のシート（#39）と同じ（stub は `EDITOR_STUB_ROLES`、niho は役割の契約まで無し。著者は session の名前）。
 */
export const previewTokenDeps: PreviewTokenApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const pool = getPool();
    return pool ? pgPreviewTokenStore(pool) : null;
  },
  roles: (session) => roleReaderOf(publishConfig(process.env), session),
  authors: (session) => sessionAuthors(session),
  connections: () => {
    const pool = getPool();
    return pool ? connectionSource(pgPublishStore(pool)) : null;
  },
};

/** 公開のシート（#39）の実行時の依存（DB の接続は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const publishDeps: PublishApiDeps = {
  auth: () => getAuthProvider(),
  ports: (session) => {
    const pool = getPool();
    return pool ? wirePublishPorts(pgPublishStore(pool), session, { drafts: pgDraftFingerprints(pool) }) : null;
  },
};

/** 録音の音声のアップロード（#36 段 2a）の実行時の依存（DB・保存先は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const audioDeps: AudioApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const pool = getPool();
    if (!pool) return null;
    return {
      startAudioRecording: (owner, input) => startAudioRecording(pool, owner, input),
      completeAudioUpload: (owner, pageId, stored) => completeAudioUpload(pool, owner, pageId, stored),
      audioInfo: (owner, pageId) => audioInfo(pool, owner, pageId),
      getRecording: (owner, pageId) => getRecording(pool, owner, pageId),
      // 2 本目以降の音声（#36 段 3b-4）
      startAudioPart: (owner, pageId, input) => startAudioPart(pool, owner, pageId, input),
      completeAudioPart: (owner, pageId, partIndex, stored) => completeAudioPart(pool, owner, pageId, partIndex, stored),
      listAudioParts: (owner, pageId) => listAudioParts(pool, owner, pageId),
      discardAudioPart: (owner, pageId, partIndex) => discardAudioPart(pool, owner, pageId, partIndex),
    };
  },
  storage: () => getStorage(process.env),
};

/** 録音の音声の再生（#36 段 3b-2。保存先から読み出して流す）の実行時の依存（DB・保存先は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const audioStreamDeps: AudioStreamApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const pool = getPool();
    return pool ? { audioInfo: (owner, pageId) => audioInfo(pool, owner, pageId) } : null;
  },
  storage: () => getStorage(process.env),
};

/**
 * 録音の文字起こし（#36 段 2b）の実行時の依存（DB・エンジン・実行の呼び出し口は要求のたびに遅延して決める。Pool は getStore と共有）。
 * 呼び出し口が無ければ runner が null（開始は 503 transcription_unavailable）。本番の呼び出し口は Cloud Tasks（docs/ops/editor-deploy.md §12）。
 */
export const transcriptionDeps: TranscriptionApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const pool = getPool();
    if (!pool) return null;
    return {
      enqueue: (owner, pageId, input) => enqueueTranscription(pool, owner, pageId, input),
      status: (owner, pageId) => transcriptionStatus(pool, owner, pageId),
      failRun: (runId, generation, errorCode) => failRun(pool, runId, generation, errorCode),
    };
  },
  runner: () => {
    const pool = getPool();
    return pool ? getTranscriptionRunner(pool, process.env) : null;
  },
};

/** 本文の画像（#33）の実行時の依存（DB・保存先は要求のたびに遅延して決める。Pool は getStore と共有）。 */
export const imageDeps: ImageApiDeps = {
  auth: () => getAuthProvider(),
  store: () => {
    const pool = getPool();
    if (!pool) return null;
    return {
      startImageUpload: (owner, input) => startImageUpload(pool, owner, input),
      completeImageUpload: (owner, assetId, stored) => completeImageUpload(pool, owner, assetId, stored),
      imageAsset: (owner, assetId) => imageAsset(pool, owner, assetId),
      updateImageMeta: (owner, assetId, patch) => updateImageMeta(pool, owner, assetId, patch),
      countPageImages: (owner, pageId) => countPageImages(pool, owner, pageId),
      findImageUploadByKey: (owner, input) => findImageUploadByKey(pool, owner, input),
      sharedImageAsset: (token, assetId) => sharedImageAsset(pool, token, assetId),
    };
  },
  storage: () => getStorage(process.env),
};

/**
 * Google ドキュメントへの書き出し（docs/architecture/editor-google-docs-export.md）の実行時の依存。
 * 方式（`EDITOR_GOOGLE_DOCS_MODE`）と本人の token は要求のたびに読む。どちらも無ければ null（503 `google_docs_unavailable`）。
 */
export const googleDocsDeps: GoogleDocsApiDeps = {
  auth: () => getAuthProvider(),
  store: () => getStore(),
  gateway: () => getGoogleDocsGateway(process.env),
  credential: (session) => getGoogleDocsCredential(getAuthProvider(), session),
};
