import assert from "node:assert/strict";
import test from "node:test";
import { createManifest } from "./updater-manifest.mjs";

const signature = Buffer.from("untrusted comment: minisign signature\nRWQ=\ntrusted comment: version 1.2.3\nAA==").toString("base64");
const valid = {
  version: "1.2.3",
  tag: "docs-v1.2.3-0123456789ab",
  assetName: "NIHO-docs-1.2.3-0123456789ab.app.tar.gz",
  signature,
  notes: "NIHO editor 1.2.3",
  pubDate: "2026-11-08T02:03:04Z",
};

test("builds a static Tauri manifest for the Apple Silicon release asset", () => {
  assert.deepEqual(createManifest(valid), {
    version: "1.2.3",
    notes: "NIHO editor 1.2.3",
    pub_date: "2026-11-08T02:03:04Z",
    platforms: {
      "darwin-aarch64": {
        signature,
        url: "https://github.com/niho-life/niho-editor/releases/download/docs-v1.2.3-0123456789ab/NIHO-docs-1.2.3-0123456789ab.app.tar.gz",
      },
    },
  });
});

test("rejects a mismatched release tag, asset name, or signature", () => {
  assert.throws(() => createManifest({ ...valid, tag: "docs-v1.2.2-0123456789ab" }), /tag must match/);
  assert.throws(() => createManifest({ ...valid, assetName: "../latest.json" }), /assetName must be/);
  assert.throws(() => createManifest({ ...valid, signature: "not-a-signature" }), /not a Tauri updater/);
});
