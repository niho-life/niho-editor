import baseline from "@niho/photo-library-contract/sdk-baseline";

const SDK_VERSION_PREFIX = "photo-sdk-v";

export const PHOTO_SDK_RELEASE_TAG = baseline.releaseTag;
export const PHOTO_SDK_VERSION = baseline.releaseTag.slice(SDK_VERSION_PREFIX.length);
export const PHOTO_SDK_SOURCE_COMMIT = baseline.sourceCommit;
export const PHOTO_DEVELOP_ENGINE_VERSION = baseline.engine.version;
export const PHOTO_DEVELOP_ENGINE_CRATE_VERSION = baseline.engine.crateVersion;
export const PHOTO_DEVELOP_ENGINE_MANIFEST_SHA256 = baseline.engine.manifest.sha256;

export const PHOTO_DEVELOP_ENGINE_RUNTIME_NAMESPACE =
  `/photo-runtime/${baseline.releaseTag}/${baseline.manifest.sha256}/develop-engine/${baseline.engine.version}` as const;

export const PHOTO_DEVELOP_ENGINE_MANIFEST_URL =
  `${PHOTO_DEVELOP_ENGINE_RUNTIME_NAMESPACE}/manifest-${baseline.engine.crateVersion}.json` as const;

export function photoSdkRuntimeAssets() {
  return Object.freeze({
    sdkVersion: PHOTO_SDK_VERSION,
    sdkReleaseTag: PHOTO_SDK_RELEASE_TAG,
    sdkSourceCommit: PHOTO_SDK_SOURCE_COMMIT,
    engineVersion: PHOTO_DEVELOP_ENGINE_VERSION,
    engineCrateVersion: PHOTO_DEVELOP_ENGINE_CRATE_VERSION,
    manifestUrl: PHOTO_DEVELOP_ENGINE_MANIFEST_URL,
    manifestSha256: PHOTO_DEVELOP_ENGINE_MANIFEST_SHA256,
  });
}
