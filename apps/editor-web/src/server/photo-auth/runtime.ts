import "server-only";
import { getAuthProvider, getPhotoAuthProvider } from "../../auth";
import type { PhotoAuthDeps } from "./index";

/**
 * 写真の本番entrypointが共有する遅延認証依存。import時にはproviderや環境値を読まず、各要求でDocsと写真を別々に解決する。
 * candidateはphoto-auth/index.tsだけを取り込むため、このNext/runtime依存を閉包へ持ち込まない。
 */
export const photoAuthRuntimeDeps: PhotoAuthDeps = Object.freeze({
  auth: () => getAuthProvider(),
  photoAuth: () => getPhotoAuthProvider(),
});
