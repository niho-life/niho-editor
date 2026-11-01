import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PhotoStorageError } from "./photo-types";
import { photoUploadSessionAad, type PhotoUploadSessionIdentity } from "./photo-session-identity";

const SCHEMA_VERSION = 1 as const;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_SESSION_URL_BYTES = 8_192;
const MAX_KEY_VERSION = 2_147_483_647;
const ENVELOPE_KEYS = ["schemaVersion", "keyVersion", "nonce", "ciphertext", "tag"] as const;
const UTF8 = new TextEncoder();
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

export interface PhotoSessionEnvelope {
  readonly schemaVersion: 1;
  readonly keyVersion: number;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export interface PhotoSessionCipher {
  seal(sessionUrl: string, identity: PhotoUploadSessionIdentity): PhotoSessionEnvelope;
  unseal(envelope: unknown, identity: PhotoUploadSessionIdentity): string;
}

export type PhotoSessionCipherOptions = {
  key: Uint8Array;
  keyVersion: number;
  rng?: (size: number) => Uint8Array;
};

function unavailable(): PhotoStorageError {
  return new PhotoStorageError("unavailable");
}

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Url(value: unknown, maxEncodedLength: number, exactBytes?: number): Uint8Array {
  if (typeof value !== "string" || value.length < 1 || value.length > maxEncodedLength
    || value.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(value)) throw unavailable();
  const bytes = Buffer.from(value, "base64url");
  if (encodeBase64Url(bytes) !== value || (exactBytes !== undefined && bytes.byteLength !== exactBytes)) throw unavailable();
  return bytes;
}

function sessionUrlBytes(value: string): Uint8Array {
  if (typeof value !== "string") throw unavailable();
  const bytes = UTF8.encode(value);
  try {
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_SESSION_URL_BYTES || UTF8_FATAL.decode(bytes) !== value) throw unavailable();
  } catch {
    throw unavailable();
  }
  return bytes;
}

function validKeyVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_KEY_VERSION;
}

export function createPhotoSessionCipher(options: PhotoSessionCipherOptions): PhotoSessionCipher {
  if (!options || typeof options !== "object" || !(options.key instanceof Uint8Array) || options.key.byteLength !== 32 || !validKeyVersion(options.keyVersion)
    || (options.rng !== undefined && typeof options.rng !== "function")) throw unavailable();
  const key = Buffer.from(options.key);
  const keyVersion = options.keyVersion;
  const rng = options.rng ?? randomBytes;

  return {
    seal(sessionUrl, identity) {
      try {
        const plaintext = sessionUrlBytes(sessionUrl);
        const generatedNonce = rng(NONCE_BYTES);
        if (!(generatedNonce instanceof Uint8Array) || generatedNonce.byteLength !== NONCE_BYTES) throw unavailable();
        const nonce = Uint8Array.from(generatedNonce);
        const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
        cipher.setAAD(photoUploadSessionAad(identity, SCHEMA_VERSION, keyVersion));
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const tag = cipher.getAuthTag();
        return {
          schemaVersion: SCHEMA_VERSION,
          keyVersion,
          nonce: encodeBase64Url(nonce),
          ciphertext: encodeBase64Url(ciphertext),
          tag: encodeBase64Url(tag),
        };
      } catch {
        throw unavailable();
      }
    },

    unseal(envelope, identity) {
      try {
        if (envelope === null || Array.isArray(envelope) || typeof envelope !== "object"
          || Object.keys(envelope).length !== ENVELOPE_KEYS.length
          || ENVELOPE_KEYS.some((keyName) => !Object.hasOwn(envelope, keyName))) throw unavailable();
        const value = envelope as Record<string, unknown>;
        if (value.schemaVersion !== SCHEMA_VERSION || value.keyVersion !== keyVersion) throw unavailable();
        const nonce = decodeBase64Url(value.nonce, 16, NONCE_BYTES);
        const ciphertext = decodeBase64Url(value.ciphertext, 10_923);
        if (ciphertext.byteLength > MAX_SESSION_URL_BYTES) throw unavailable();
        const tag = decodeBase64Url(value.tag, 22, TAG_BYTES);
        const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
        decipher.setAAD(photoUploadSessionAad(identity, SCHEMA_VERSION, keyVersion));
        decipher.setAuthTag(tag);
        // Do not decode any plaintext until final() has authenticated the complete message.
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        let sessionUrl: string;
        try {
          sessionUrl = UTF8_FATAL.decode(plaintext);
        } catch {
          throw unavailable();
        }
        sessionUrlBytes(sessionUrl);
        return sessionUrl;
      } catch {
        throw unavailable();
      }
    },
  };
}
