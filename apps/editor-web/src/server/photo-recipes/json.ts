import "server-only";
import { createHash } from "node:crypto";
import { PHOTO_LIMITS, type Json, type JsonObject } from "../../../../../packages/photo-library-contract/src/v1";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalarString(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Clone only bounded JSON values. The generic error never includes caller-controlled input. */
export function clonePhotoJson(value: unknown, depth = 0): Json {
  if (depth > PHOTO_LIMITS.maxJsonDepth) throw new TypeError("invalid photo JSON");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("invalid photo JSON");
    return value;
  }
  if (typeof value === "string") {
    if (!scalarString(value)) throw new TypeError("invalid photo JSON");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => clonePhotoJson(item, depth + 1));
  if (!record(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("invalid photo JSON");
  }
  const result: Record<string, Json> = Object.create(null) as Record<string, Json>;
  for (const [key, child] of Object.entries(value)) {
    if (!scalarString(key)) throw new TypeError("invalid photo JSON");
    result[key] = clonePhotoJson(child, depth + 1);
  }
  return result;
}

/** RFC 8785-equivalent canonicalization for the already-bounded JSON domain used by P05. */
export function canonicalPhotoJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPhotoJson).join(",")}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalPhotoJson(object[key]!)}`).join(",")}}`;
}

export function photoJsonSha256(value: Json): string {
  return createHash("sha256").update(canonicalPhotoJson(value), "utf8").digest("hex");
}

export function photoJsonBytes(value: Json): number {
  return Buffer.byteLength(canonicalPhotoJson(value), "utf8");
}
