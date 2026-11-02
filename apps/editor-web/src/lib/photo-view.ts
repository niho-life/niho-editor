import type { PersonalPhotoLibrary, Photo, QuotaUsage } from "@niho/photo-library-contract";
import { photoFileFormat, PhotoUploadError, type PhotoUploadStage } from "./photo-upload";

export type PhotoUploadRow = {
  id: string; file: File; stage: PhotoUploadStage | "stored" | "existing" | "cancelled" | "failed";
  fraction: number | null; message: string | null; controller: AbortController | null;
  mediaState?: Photo["media"]["state"];
};

export function uploadAllowed(library: PersonalPhotoLibrary, usage: QuotaUsage | null): boolean {
  return library.state === "active" && (usage?.availableBytes ?? library.usage.availableBytes) > 0 &&
    library.capabilities.formats.some((format) => format.ingest);
}

export function uploadFormatAllowed(library: PersonalPhotoLibrary, file: File): boolean {
  const format = photoFileFormat(file);
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  return format !== null && extension !== undefined && library.capabilities.formats.some((item) =>
    item.format === format && item.ingest && item.extensions.some((supported) =>
      supported.replace(/^\./, "").toLowerCase() === extension));
}

export function formatPhotoBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    const gigabytes = bytes / 1024 ** 3;
    return `${gigabytes.toFixed(Number.isInteger(gigabytes) ? 0 : 1)} GB`;
  }
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} byte`;
}

export function photoUploadLabel(row: PhotoUploadRow): string {
  switch (row.stage) {
    case "preparing": return "追加の準備中";
    case "uploading": return `送信中 ${Math.round((row.fraction ?? 0) * 100)}%`;
    case "confirming": return "原本の保存を確認中";
    case "processing": return "原本の保存を確認中・表示用画像を準備中";
    case "stored": return row.mediaState === "ready" ? "原本を保存しました。表示用画像も利用できます。" :
      row.mediaState === "failed" ? "原本を保存しました。表示用画像の準備に失敗しました。" :
        row.mediaState === "unsupported" ? "原本を保存しました。表示用画像には対応していません。" :
          "原本を保存しました。表示用画像を準備中です。";
    case "existing": return "同じ写真が保存済みです。";
    case "cancelled": return "追加を取り消しました。";
    case "failed": return row.message ?? "追加できませんでした。";
  }
}

export function photoUploadMessage(error: unknown): string {
  if (error instanceof PhotoUploadError) {
    if (error.reason === "unsupported") return "この形式は追加できません。";
    if (error.reason === "too_large") return "このファイルは追加できる大きさを超えています。";
    if (error.reason === "resume") return "送信の再開を確認できません。再試行してください。";
    if (error.reason === "cancelled") return "追加を取り消しました。";
  }
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "quota_exceeded") return "写真の保存容量が足りません。";
    if (error.code === "unsupported_format") return "この形式は追加できません。";
    if (error.code === "temporarily_unavailable") return "写真サービスを一時的に利用できません。再試行してください。";
  }
  return "写真を追加できませんでした。再試行してください。";
}
