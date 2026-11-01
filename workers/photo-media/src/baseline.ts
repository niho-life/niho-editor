import { createHash } from "node:crypto";
import baseline from "../../../packages/photo-library-contract/sdk-baseline.json" with { type: "json" };
import type { RenderCapability } from "../../../packages/photo-library-contract/src/v1.ts";

export const MEDIA_BASELINE = Object.freeze({
  sdkVersion: baseline.releaseTag.slice("photo-sdk-v".length),
  crateVersion: baseline.engine.crateVersion,
  manifestSha256: baseline.engine.manifest.sha256,
  sourceCommit: baseline.sourceCommit,
});

/** Installation/build adapters must verify the actual release bytes before loading code. */
export function verifyPinnedArtifact(name: string, bytes: Uint8Array): void {
  const item = name === baseline.manifest.file ? baseline.manifest
    : name === baseline.receipt.file ? baseline.receipt
    : name === baseline.engine.manifest.file ? baseline.engine.manifest
    : baseline.packages.find((entry) => entry.file === name);
  if (!item || createHash("sha256").update(bytes).digest("hex") !== item.sha256 || ("size" in item && bytes.byteLength !== item.size)) {
    throw new Error("photo-media: pinned artifact verification failed");
  }
}

export function isPinnedRenderer(renderer: RenderCapability): boolean {
  return renderer.sdkVersion === MEDIA_BASELINE.sdkVersion
    && renderer.crateVersion === MEDIA_BASELINE.crateVersion
    && renderer.manifestSha256 === MEDIA_BASELINE.manifestSha256;
}
