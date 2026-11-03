import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Secret Manager から runtime だけが受け取る keyring。通常の page 保存には使わない。 */
export type PrivateJobsEnv = { readonly EDITOR_PRIVATE_JOBS_KEY_RING?: string | undefined };

export type ManagedTranslationPrivateJobBinding = {
  readonly owner: string;
  readonly proposalId: string;
  readonly purpose: "managed-translation";
  readonly expiresAt: string;
};

export type GoogleDocsPrivateJobBinding = {
  readonly owner: string;
  readonly jobId: string;
  readonly itemId: string;
  readonly purpose: "google-docs";
  readonly expiresAt: string;
};

export type PrivateJobBinding = ManagedTranslationPrivateJobBinding | GoogleDocsPrivateJobBinding;

export type EncryptedPrivateJobPayload = {
  readonly keyId: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly tag: Uint8Array;
};

export interface PrivateJobPayloadCipher {
  encrypt(value: unknown, binding: PrivateJobBinding): EncryptedPrivateJobPayload;
  decrypt(value: EncryptedPrivateJobPayload, binding: PrivateJobBinding): unknown;
}

const KEY_ID = /^[A-Za-z0-9._-]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_KEYRING_BYTES = 4096;
const MAX_KEYS = 8;

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function keyBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length < 40 || value.length > 48 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === 32 && bytes.toString("base64") === value ? bytes : null;
}

function bindingBytes(binding: PrivateJobBinding): Uint8Array {
  if (typeof binding.owner !== "string" || binding.owner.length < 1 || binding.owner.length > 256
    || new Date(binding.expiresAt).toISOString() !== binding.expiresAt) {
    throw new TypeError("editor-web: invalid private job binding");
  }
  if (binding.purpose === "managed-translation") {
    if (!UUID.test(binding.proposalId)) throw new TypeError("editor-web: invalid private job binding");
    // Existing managed-translation envelopes depend on these exact bytes. Do not add a version or field here.
    return Buffer.from(JSON.stringify([binding.owner, binding.proposalId.toLowerCase(), binding.purpose, binding.expiresAt]), "utf8");
  }
  if (binding.purpose === "google-docs" && UUID.test(binding.jobId) && UUID.test(binding.itemId)) {
    return Buffer.from(JSON.stringify([
      binding.owner,
      binding.jobId.toLowerCase(),
      binding.itemId.toLowerCase(),
      binding.purpose,
      binding.expiresAt,
    ]), "utf8");
  }
  throw new TypeError("editor-web: invalid private job binding");
}

function envelope(value: EncryptedPrivateJobPayload): { keyId: string; nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  const nonce = Buffer.from(value.nonce);
  const ciphertext = Buffer.from(value.ciphertext);
  const tag = Buffer.from(value.tag);
  if (!KEY_ID.test(value.keyId) || nonce.byteLength !== 12 || tag.byteLength !== 16 || ciphertext.byteLength < 1) {
    throw new Error("editor-web: private job payload is unavailable");
  }
  return { keyId: value.keyId, nonce, ciphertext, tag };
}

/**
 * 未設定・形違い・active key 不在は null。管理翻訳だけを閉じ、通常編集や既存 EN page は止めない。
 * 実鍵の値は error・log に載せない。
 */
export function createPrivateJobPayloadCipher(env: PrivateJobsEnv): PrivateJobPayloadCipher | null {
  const raw = env.EDITOR_PRIVATE_JOBS_KEY_RING?.trim() ?? "";
  if (raw === "" || Buffer.byteLength(raw, "utf8") > MAX_KEYRING_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!plain(parsed) || !exact(parsed, ["active", "keys"]) || typeof parsed.active !== "string" || !KEY_ID.test(parsed.active) || !plain(parsed.keys)) return null;
  const entries = Object.entries(parsed.keys);
  if (entries.length < 1 || entries.length > MAX_KEYS || entries.some(([id]) => !KEY_ID.test(id))) return null;
  const keys = new Map<string, Uint8Array>();
  for (const [id, encoded] of entries) {
    const bytes = keyBytes(encoded);
    if (!bytes) return null;
    keys.set(id, bytes);
  }
  if (!keys.has(parsed.active)) return null;
  const active = parsed.active;

  return {
    encrypt(value, binding) {
      const encoded = Buffer.from(JSON.stringify(value), "utf8");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keys.get(active)!, nonce);
      cipher.setAAD(bindingBytes(binding));
      const ciphertext = Buffer.concat([cipher.update(encoded), cipher.final()]);
      return { keyId: active, nonce, ciphertext, tag: cipher.getAuthTag() };
    },
    decrypt(value, binding) {
      const checked = envelope(value);
      const key = keys.get(checked.keyId);
      if (!key) throw new Error("editor-web: private job payload is unavailable");
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, checked.nonce);
        decipher.setAAD(bindingBytes(binding));
        decipher.setAuthTag(checked.tag);
        const decoded = Buffer.concat([decipher.update(checked.ciphertext), decipher.final()]).toString("utf8");
        return JSON.parse(decoded);
      } catch {
        throw new Error("editor-web: private job payload is unavailable");
      }
    },
  };
}
