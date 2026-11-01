import { describe, expect, it } from "vitest";
import { createPhotoSessionCipher, type PhotoSessionEnvelope } from "./photo-session-cipher";
import type { PhotoUploadSessionIdentity } from "./photo-session-identity";

const SESSION_URL = "https://storage.googleapis.com/upload/storage/v1/b/synthetic-docs-bucket/o?upload_id=synthetic-private-session";
const IDENTITY: PhotoUploadSessionIdentity = {
  ownerId: "synthetic-owner",
  uploadId: "44444444-4444-4444-8444-444444444444",
  stageKey: "photo/stage/44444444-4444-4444-8444-444444444444",
  sizeBytes: 123_456,
  contentType: "image/jpeg",
  libraryId: "55555555-5555-4555-8555-555555555555",
  libraryLifecycleEpoch: 6,
  uploadLeaseGeneration: 7,
};
const key = (seed = 1) => Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256);

function genericUnavailable(error: unknown) {
  expect(error).toMatchObject({ code: "unavailable", message: "photo storage: unavailable" });
  expect(String(error)).not.toMatch(/synthetic-private-session|synthetic-owner|storage\.googleapis\.com/i);
}

function changed(value: string): string {
  const first = value[0] === "A" ? "B" : "A";
  return first + value.slice(1);
}

describe("encrypted private photo upload session codec", () => {
  it("roundtrips with fresh non-deterministic nonces and never exposes plaintext", () => {
    const codec = createPhotoSessionCipher({ key: key(), keyVersion: 4 });
    const first = codec.seal(SESSION_URL, IDENTITY);
    const second = codec.seal(SESSION_URL, IDENTITY);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(codec.unseal(first, IDENTITY)).toBe(SESSION_URL);
    expect(codec.unseal(second, IDENTITY)).toBe(SESSION_URL);
    expect(Object.keys(first).sort()).toEqual(["ciphertext", "keyVersion", "nonce", "schemaVersion", "tag"]);
    expect(JSON.stringify(first)).not.toContain(SESSION_URL);
    expect(JSON.stringify(codec)).not.toMatch(/synthetic-private-session|\"key\"/i);
  });

  it("clones the supplied key before caller mutation", () => {
    const supplied = key();
    const codec = createPhotoSessionCipher({ key: supplied, keyVersion: 1, rng: () => new Uint8Array(12).fill(9) });
    const envelope = codec.seal(SESSION_URL, IDENTITY);
    supplied.fill(0);
    expect(codec.unseal(envelope, IDENTITY)).toBe(SESSION_URL);
  });

  it("authenticates every identity field", () => {
    const codec = createPhotoSessionCipher({ key: key(), keyVersion: 2, rng: () => new Uint8Array(12).fill(3) });
    const envelope = codec.seal(SESSION_URL, IDENTITY);
    const otherUpload = "66666666-6666-4666-8666-666666666666";
    const changedIdentities: PhotoUploadSessionIdentity[] = [
      { ...IDENTITY, ownerId: "another-owner" },
      { ...IDENTITY, uploadId: otherUpload, stageKey: `photo/stage/${otherUpload}` },
      { ...IDENTITY, stageKey: "photo/stage/77777777-7777-4777-8777-777777777777" },
      { ...IDENTITY, sizeBytes: IDENTITY.sizeBytes + 1 },
      { ...IDENTITY, contentType: "image/png" },
      { ...IDENTITY, libraryId: "77777777-7777-4777-8777-777777777777" },
      { ...IDENTITY, libraryLifecycleEpoch: IDENTITY.libraryLifecycleEpoch + 1 },
      { ...IDENTITY, uploadLeaseGeneration: IDENTITY.uploadLeaseGeneration + 1 },
    ];
    for (const identity of changedIdentities) {
      try {
        codec.unseal(envelope, identity);
        throw new Error("expected failure");
      } catch (error) {
        genericUnavailable(error);
      }
    }
  });

  it("rejects changed nonce, ciphertext, tag, key version and wrong keys", () => {
    const codec = createPhotoSessionCipher({ key: key(), keyVersion: 2, rng: () => new Uint8Array(12).fill(4) });
    const envelope = codec.seal(SESSION_URL, IDENTITY);
    for (const altered of [
      { ...envelope, nonce: changed(envelope.nonce) },
      { ...envelope, ciphertext: changed(envelope.ciphertext) },
      { ...envelope, tag: changed(envelope.tag) },
      { ...envelope, keyVersion: 3 },
    ]) expect(() => codec.unseal(altered, IDENTITY)).toThrowError("photo storage: unavailable");
    const wrongKey = createPhotoSessionCipher({ key: key(99), keyVersion: 2 });
    expect(() => wrongKey.unseal(envelope, IDENTITY)).toThrowError("photo storage: unavailable");
    const wrongVersion = createPhotoSessionCipher({ key: key(), keyVersion: 3 });
    expect(() => wrongVersion.unseal(envelope, IDENTITY)).toThrowError("photo storage: unavailable");
  });

  it("requires an exact closed envelope and canonical bounded base64url", () => {
    const codec = createPhotoSessionCipher({ key: key(), keyVersion: 8, rng: () => new Uint8Array(12).fill(5) });
    const envelope = codec.seal(SESSION_URL, IDENTITY);
    const invalid: unknown[] = [
      null,
      [],
      { ...envelope, unknown: "field" },
      { schemaVersion: 1, keyVersion: 8, nonce: envelope.nonce, ciphertext: envelope.ciphertext },
      { ...envelope, schemaVersion: 2 },
      { ...envelope, nonce: `${envelope.nonce}=` },
      { ...envelope, nonce: "A" },
      { ...envelope, nonce: envelope.nonce.slice(1) },
      { ...envelope, ciphertext: `${envelope.ciphertext}=` },
      { ...envelope, ciphertext: "A" },
      { ...envelope, ciphertext: "A".repeat(10_924) },
      { ...envelope, tag: changed(envelope.tag).slice(1) },
      { ...envelope, tag: "_".repeat(23) },
    ];
    for (const value of invalid) expect(() => codec.unseal(value, IDENTITY)).toThrowError("photo storage: unavailable");
  });

  it("rejects invalid keys, versions, RNG output, identity and plaintext bounds generically", () => {
    for (const invalidKey of [new Uint8Array(31), new Uint8Array(33)]) {
      expect(() => createPhotoSessionCipher({ key: invalidKey, keyVersion: 1 })).toThrowError("photo storage: unavailable");
    }
    for (const keyVersion of [-1, 2_147_483_648, 1.5]) {
      expect(() => createPhotoSessionCipher({ key: key(), keyVersion })).toThrowError("photo storage: unavailable");
    }
    const badRng = createPhotoSessionCipher({ key: key(), keyVersion: 1, rng: () => new Uint8Array(11) });
    expect(() => badRng.seal(SESSION_URL, IDENTITY)).toThrowError("photo storage: unavailable");
    const codec = createPhotoSessionCipher({ key: key(), keyVersion: 1 });
    for (const value of ["", "x".repeat(8_193)]) expect(() => codec.seal(value, IDENTITY)).toThrowError("photo storage: unavailable");
    expect(() => codec.seal(SESSION_URL, { ...IDENTITY, ownerId: "bad\nowner" })).toThrowError("photo storage: unavailable");
  });

  it("does not include plaintext or provider details in authentication errors", () => {
    const codec = createPhotoSessionCipher({ key: key(), keyVersion: 1 });
    const envelope = codec.seal(SESSION_URL, IDENTITY);
    const corrupted: PhotoSessionEnvelope = { ...envelope, tag: changed(envelope.tag) };
    try {
      codec.unseal(corrupted, IDENTITY);
      throw new Error("expected failure");
    } catch (error) {
      genericUnavailable(error);
    }
  });
});
