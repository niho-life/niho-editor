import type {
  NihoPrivatePhoto,
  NihoPrivatePhotoList,
  PrivatePhotoDevelopSettings,
  PrivatePhotoJsonValue,
} from "./types";

const PHOTO_KEYS = [
  "id", "contentSha256", "fileName", "fileExtension", "contentType", "sizeBytes", "status", "storedAt",
  "developSettings", "developSettingsUpdatedAt", "developRevision", "hasEdits", "createdAt",
] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{1,512}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_ORIGINAL_BYTES = 200 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const MAX_SETTINGS_DEPTH = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT_RE.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isUnicodeWithoutControls(value: string, maxCharacters: number): boolean {
  let characters = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if ((codePoint >= 0 && codePoint <= 0x1f) || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return false;
    characters += 1;
    if (characters > maxCharacters) return false;
  }
  return characters > 0;
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  }
  return true;
}

function validateAndFreezeJson(value: unknown, depth: number): value is PrivatePhotoJsonValue {
  if (depth > MAX_SETTINGS_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return hasOnlyUnicodeScalars(value);
  if (Array.isArray(value)) {
    if (!value.every((item) => validateAndFreezeJson(item, depth + 1))) return false;
    Object.freeze(value);
    return true;
  }
  if (!isRecord(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (!hasOnlyUnicodeScalars(key) || !validateAndFreezeJson(item, depth + 1)) return false;
  }
  Object.freeze(value);
  return true;
}

function parseSettings(value: unknown): PrivatePhotoDevelopSettings | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_SETTINGS_BYTES || !validateAndFreezeJson(value, 0)) return undefined;
  return value as PrivatePhotoDevelopSettings;
}

export function isPrivatePhotoCursor(value: unknown): value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "ascii") > 512 || !CURSOR_RE.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").toString("base64url") === value;
  } catch {
    return false;
  }
}

export function parsePrivatePhoto(value: unknown): NihoPrivatePhoto | null {
  if (!isRecord(value) || !exactKeys(value, PHOTO_KEYS)) return null;
  const settings = parseSettings(value.developSettings);
  if (settings === undefined
    || typeof value.id !== "string" || !UUID_RE.test(value.id)
    || typeof value.contentSha256 !== "string" || !SHA256_RE.test(value.contentSha256)
    || typeof value.fileName !== "string" || !isUnicodeWithoutControls(value.fileName, 255)
    || typeof value.fileExtension !== "string" || !/^[A-Za-z0-9]{1,16}$/.test(value.fileExtension)
    || typeof value.contentType !== "string"
    || !(/^(?:image\/[A-Za-z0-9][A-Za-z0-9.+-]{0,121}|application\/octet-stream)$/.test(value.contentType))
    || !Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) < 1 || (value.sizeBytes as number) > MAX_ORIGINAL_BYTES
    || value.status !== "stored" || !isIsoInstant(value.storedAt) || !isIsoInstant(value.createdAt)
    || (value.developSettingsUpdatedAt !== null && !isIsoInstant(value.developSettingsUpdatedAt))
    || !Number.isSafeInteger(value.developRevision) || (value.developRevision as number) < 0
    || typeof value.hasEdits !== "boolean") return null;
  return Object.freeze({
    id: value.id.toLowerCase(),
    contentSha256: value.contentSha256,
    fileName: value.fileName,
    fileExtension: value.fileExtension,
    contentType: value.contentType,
    sizeBytes: value.sizeBytes as number,
    status: "stored" as const,
    storedAt: value.storedAt,
    developSettings: settings,
    developSettingsUpdatedAt: value.developSettingsUpdatedAt,
    developRevision: value.developRevision as number,
    hasEdits: value.hasEdits,
    createdAt: value.createdAt,
  });
}

export function parsePrivatePhotoList(value: unknown): NihoPrivatePhotoList | null {
  if (!isRecord(value) || !exactKeys(value, ["photos", "nextCursor"]) || !Array.isArray(value.photos)
    || value.photos.length > 60 || (value.nextCursor !== null && !isPrivatePhotoCursor(value.nextCursor))) return null;
  const photos: NihoPrivatePhoto[] = [];
  for (const candidate of value.photos) {
    const photo = parsePrivatePhoto(candidate);
    if (!photo) return null;
    photos.push(photo);
  }
  return Object.freeze({ photos: Object.freeze(photos), nextCursor: value.nextCursor });
}

export function parsePrivatePhotoEnvelope(value: unknown, expectedId: string): NihoPrivatePhoto | null {
  if (!isRecord(value) || !exactKeys(value, ["photo"])) return null;
  const photo = parsePrivatePhoto(value.photo);
  return photo?.id === expectedId ? photo : null;
}
