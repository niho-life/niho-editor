import type { PhotoErrorCode, Photo } from "@niho/photo-library-contract";
import type { PhotoLibraryPhoto } from "niho-photo-editing/library/photo-library";

const MESSAGES: Partial<Record<PhotoErrorCode, string>> = {
  invalid_request: "写真の要求を確認できませんでした。",
  invalid_cursor: "写真一覧を最初から読み直してください。",
  unauthenticated: "ログインを確認してください。",
  origin_rejected: "この画面から写真を操作できません。",
  not_found: "写真が見つかりません。",
  quota_exceeded: "写真の保存容量が足りません。",
  revision_conflict: "別の端末で写真が更新されました。",
  unsupported_settings: "この補正は現在の環境では変更できません。",
  rate_limited: "操作が多いため、少し待ってからお試しください。",
  temporarily_unavailable: "写真サービスを一時的に利用できません。",
};

export class CloudPhotoError extends Error {
  readonly name = "CloudPhotoError";
  readonly stalePhoto?: PhotoLibraryPhoto;
  readonly code: PhotoErrorCode | "invalid_response" | "scope_changed" | "unsupported_operation" | "content_too_large";
  readonly status: number | null;
  readonly requestId: string | null;
  readonly retryable: boolean;

  constructor(
    code: PhotoErrorCode | "invalid_response" | "scope_changed" | "unsupported_operation" | "content_too_large",
    status: number | null,
    requestId: string | null,
    retryable: boolean,
    options?: { stalePhoto?: PhotoLibraryPhoto },
  ) {
    super(code in MESSAGES ? MESSAGES[code as PhotoErrorCode] : messageForLocalCode(code));
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.retryable = retryable;
    if (options?.stalePhoto) this.stalePhoto = options.stalePhoto;
  }
}

function messageForLocalCode(code: CloudPhotoError["code"]): string {
  switch (code) {
    case "scope_changed": return "写真ライブラリが切り替わりました。";
    case "unsupported_operation": return "この操作は現在利用できません。";
    case "content_too_large": return "写真が読み込み上限を超えています。";
    case "invalid_response": return "写真サービスの応答を確認できませんでした。";
    default: return "写真を操作できませんでした。";
  }
}

export function fixedMessage(error: unknown, fallback: string): string {
  return error instanceof CloudPhotoError ? error.message : fallback;
}

export function isCloudPhotoError(error: unknown): error is CloudPhotoError {
  return error instanceof CloudPhotoError;
}

export type RawRecipeRecord = Readonly<{ photo: Photo; receivedAt: string }>;
