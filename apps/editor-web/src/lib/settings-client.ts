/** ブラウザから設定と使用量のAPIを呼ぶ（同じ origin。鍵・token は扱わない）。 */

import type { EditorSettingsPatch, MediaStorageUsage } from "@niho/editor-store";
import { SETTINGS_MESSAGES } from "@/settings/messages";
import type { UsageSummary } from "@/server/ai-api";
import type { SettingsDto } from "@/server/settings-api";

export type { MediaStorageUsage, SettingsDto, UsageSummary };

/** 失敗。message は画面に出す一言。 */
export type SettingsFailure = { ok: false; status: number; error: string | null; message: string };

function messageOf(status: number): string {
  if (status === 400) return SETTINGS_MESSAGES.rejected;
  if (status === 401) return SETTINGS_MESSAGES.signedOut;
  if (status === 403) return SETTINGS_MESSAGES.forbidden;
  if (status === 503) return SETTINGS_MESSAGES.unavailable;
  return SETTINGS_MESSAGES.failed;
}

async function failureOf(response: Response): Promise<SettingsFailure> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return { ok: false, status: response.status, error: typeof body?.error === "string" ? body.error : null, message: messageOf(response.status) };
}

const NETWORK: SettingsFailure = { ok: false, status: 0, error: null, message: SETTINGS_MESSAGES.network };

function hasSettings(body: unknown): body is { settings: SettingsDto } {
  return typeof body === "object" && body !== null && typeof (body as { settings?: unknown }).settings === "object" && (body as { settings: unknown }).settings !== null;
}

/** 今の設定（画面を開き直したとき・保存に失敗した後の読み直し）。 */
export async function loadSettings(): Promise<{ ok: true; settings: SettingsDto } | SettingsFailure> {
  let response: Response;
  try {
    response = await fetch("/api/settings", { credentials: "same-origin", cache: "no-store" });
  } catch {
    return NETWORK;
  }
  if (!response.ok) return failureOf(response);
  const body = (await response.json().catch(() => null)) as unknown;
  return hasSettings(body) ? { ok: true, settings: body.settings } : { ...NETWORK, message: SETTINGS_MESSAGES.failed };
}

/** 渡した項目だけを入れ替える。応答は入れ替えた後の設定。 */
export async function saveSettings(patch: EditorSettingsPatch): Promise<{ ok: true; settings: SettingsDto } | SettingsFailure> {
  let response: Response;
  try {
    response = await fetch("/api/settings", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
  } catch {
    return NETWORK;
  }
  if (!response.ok) return failureOf(response);
  const body = (await response.json().catch(() => null)) as unknown;
  return hasSettings(body) ? { ok: true, settings: body.settings } : { ...NETWORK, message: SETTINGS_MESSAGES.failed };
}

/** 今月の AI の使用量（AI が無効でも答える）。 */
export async function loadAiUsage(): Promise<{ ok: true; usage: UsageSummary } | SettingsFailure> {
  let response: Response;
  try {
    response = await fetch("/api/ai/usage", { credentials: "same-origin", cache: "no-store" });
  } catch {
    return { ...NETWORK, message: SETTINGS_MESSAGES.usageFailed };
  }
  if (!response.ok) return { ...(await failureOf(response)), message: SETTINGS_MESSAGES.usageFailed };
  const body = (await response.json().catch(() => null)) as { usage?: unknown } | null;
  const usage = body?.usage;
  if (typeof usage !== "object" || usage === null) return { ...NETWORK, message: SETTINGS_MESSAGES.usageFailed };
  return { ok: true, usage: usage as UsageSummary };
}

function isByteCount(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,80}$/.test(value);
}

function isMediaStorageUsage(value: unknown): value is MediaStorageUsage {
  if (typeof value !== "object" || value === null) return false;
  const usage = value as Partial<MediaStorageUsage>;
  return isByteCount(usage.totalBytes) && isByteCount(usage.imageBytes) && isByteCount(usage.audioBytes)
    && BigInt(usage.totalBytes) === BigInt(usage.imageBytes) + BigInt(usage.audioBytes);
}

/** アカウントのクラウドメディア使用量。容量の上限はまだ設けない。 */
export async function loadStorageUsage(): Promise<{ ok: true; usage: MediaStorageUsage } | SettingsFailure> {
  let response: Response;
  try {
    response = await fetch("/api/storage/usage", { credentials: "same-origin", cache: "no-store" });
  } catch {
    return { ...NETWORK, message: SETTINGS_MESSAGES.storageUsageFailed };
  }
  if (!response.ok) return { ...(await failureOf(response)), message: SETTINGS_MESSAGES.storageUsageFailed };
  const body = (await response.json().catch(() => null)) as { usage?: unknown } | null;
  if (!isMediaStorageUsage(body?.usage)) return { ...NETWORK, message: SETTINGS_MESSAGES.storageUsageFailed };
  return { ok: true, usage: body.usage };
}
