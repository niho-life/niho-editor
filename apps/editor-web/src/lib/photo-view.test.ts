import { describe, expect, it } from "vitest";
import { PHOTO_LIMITS } from "@niho/photo-library-contract";
import { library, storedPhoto } from "@niho/photo-library-contract/fixtures";
import { formatPhotoBytes, photoUploadLabel, photoUploadMessage, uploadAllowed, uploadFormatAllowed, type PhotoUploadRow } from "./photo-view";
import { PhotoUploadError } from "./photo-upload";

const row = (patch: Partial<PhotoUploadRow>): PhotoUploadRow => ({
  id: "one", file: new File(["x"], "synthetic.jpg"), stage: "preparing", fraction: null,
  message: null, controller: null, ...patch,
});

describe("photo upload view states", () => {
  it("shows the owner-set binary quota as 5 GB and smaller usage in readable units", () => {
    expect(formatPhotoBytes(PHOTO_LIMITS.quotaBytes)).toBe("5 GB");
    expect(formatPhotoBytes(PHOTO_LIMITS.quotaBytes / 2)).toBe("2.5 GB");
    expect(formatPhotoBytes(1024 ** 2)).toBe("1.0 MB");
  });

  it("closes file addition at the confirmed quota boundary or without ingest capability", () => {
    expect(uploadAllowed(library, library.usage)).toBe(true);
    expect(uploadAllowed(library, { ...library.usage, availableBytes: 0 })).toBe(false);
    expect(uploadAllowed({ ...library, capabilities: { ...library.capabilities, formats: [] } }, library.usage)).toBe(false);
  });

  it("accepts only an ingest-enabled extension declared by the server", () => {
    expect(uploadFormatAllowed(library, new File(["x"], "photo.jpg"))).toBe(true);
    const rawOnlyDng = { ...library, capabilities: { ...library.capabilities, formats: [
      { format: "raw" as const, extensions: ["dng"], ingest: true, workingCopy: true },
    ] } };
    expect(uploadFormatAllowed(rawOnlyDng, new File(["x"], "photo.dng"))).toBe(true);
    expect(uploadFormatAllowed(rawOnlyDng, new File(["x"], "photo.rw2"))).toBe(false);
  });

  it("keeps progress and processing distinct from confirmed original storage", () => {
    expect(photoUploadLabel(row({ stage: "uploading", fraction: 0.6 }))).toContain("60%");
    expect(photoUploadLabel(row({ stage: "confirming" }))).toContain("確認中");
    expect(photoUploadLabel(row({ stage: "processing" }))).toContain("確認中");
    expect(photoUploadLabel(row({ stage: "stored", mediaState: storedPhoto.media.state }))).toContain("原本を保存しました");
    expect(photoUploadLabel(row({ stage: "failed", message: "容量不足" }))).toBe("容量不足");
    expect(photoUploadLabel(row({ stage: "cancelled" }))).toContain("取り消し");
  });

  it("uses fixed Japanese errors and never exposes ticket or server error text", () => {
    expect(photoUploadMessage(new PhotoUploadError("resume"))).toContain("再試行");
    expect(photoUploadMessage(Object.assign(new Error("secret ticket url"), { code: "temporarily_unavailable" }))).not.toContain("secret");
    expect(photoUploadMessage(new Error("raw internal message"))).not.toContain("raw");
  });
});
