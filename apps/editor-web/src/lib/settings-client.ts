/** ブラウザから設定と使用量のAPIを呼ぶ（同じ origin。鍵・token は扱わない）。 */

import type { EditorSettingsPatch, MediaStorageUsage, RecipeGuideExtraction, RecipeSample } from "@niho/editor-store";
import { SETTINGS_MESSAGES } from "@/settings/messages";
import type { UsageSummary } from "@/server/ai-api";
import type { SettingsDto, SettingsPatchInput } from "@/server/settings-api";

export type { MediaStorageUsage };
export type { SettingsDto, SettingsPatchInput, SettingsRecipeInput } from "@/server/settings-api";
export type { UsageSummary };

export type GuideExtractionPreview = Pick<RecipeGuideExtraction, "sampleIds" | "guide" | "candidates"> & { createdAt?: string };

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
export async function saveSettings(patch: SettingsPatchInput | EditorSettingsPatch): Promise<{ ok: true; settings: SettingsDto } | SettingsFailure> {
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

/** その手順と登録済みのお手本文を、本人の新しい手順として複製する。 */
export async function duplicateSettingsRecipe(recipeId: string): Promise<{ ok: true; settings: SettingsDto } | SettingsFailure> {
  let response: Response;
  try {
    response = await fetch(`/api/settings/recipes/${encodeURIComponent(recipeId)}/duplicate`, {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    return NETWORK;
  }
  if (!response.ok) {
    const failure = await failureOf(response);
    if (failure.error === "recipe_limit") return { ...failure, message: "手順の上限に達しているため複製できません。不要な手順を削除してください" };
    if (failure.error === "sample_content_missing") return { ...failure, message: "お手本文を読めないため複製できません。元の手順を確認してください" };
    return failure;
  }
  const body = (await response.json().catch(() => null)) as unknown;
  return hasSettings(body) ? { ok: true, settings: body.settings } : { ...NETWORK, message: SETTINGS_MESSAGES.failed };
}

function sampleFailureMessage(error: string | null, status: number): string {
  switch (error) {
    case "sample_limit": return "この手順に登録できるお手本は5件までです。";
    case "too_large": return "文書が大きすぎます。8 MiB以下のファイルを選んでください。";
    case "unsupported_type": return "Markdown、テキスト、Word、PDFに対応しています。";
    case "unsafe_url": return "安全のため、このURLは取り込めません。公開WebページのURLを確認してください。";
    case "timeout": return "文書の取得に時間がかかりすぎました。";
    case "fetch_failed": return "URLから文書を取得できませんでした。";
    case "invalid_document": return "文書を読み取れませんでした。形式と内容を確認してください。";
    case "no_samples": return "先にお手本文書を取り込んでください。";
    case "quota_exceeded": return "今月のAI利用上限に達しました。";
    case "samples_changed": return "お手本が更新されました。もう一度抽出してください。";
    case "guide_extraction_failed": return "抽出できませんでした。お手本文書を確認してもう一度お試しください。";
    case "ai_unavailable": return "いまはAIを利用できません。";
    default: return messageOf(status);
  }
}

async function sampleFailureOf(response: Response): Promise<SettingsFailure> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const error = typeof body?.error === "string" ? body.error : null;
  return { ok: false, status: response.status, error, message: sampleFailureMessage(error, response.status) };
}

/** 利用者が選んだ1つのファイル、または1つのURLを手順のお手本として保存する。 */
export async function importRecipeSample(recipeId: string, input: { file: File } | { url: string }): Promise<{ ok: true; sample: RecipeSample } | SettingsFailure> {
  let response: Response;
  try {
    if ("file" in input) {
      const form = new FormData();
      form.set("file", input.file);
      response = await fetch(`/api/settings/recipes/${encodeURIComponent(recipeId)}/samples`, { method: "POST", credentials: "same-origin", body: form });
    } else {
      const form = new FormData();
      form.set("url", input.url);
      response = await fetch(`/api/settings/recipes/${encodeURIComponent(recipeId)}/samples`, { method: "POST", credentials: "same-origin", body: form });
    }
  } catch {
    return NETWORK;
  }
  if (!response.ok) return sampleFailureOf(response);
  const body = (await response.json().catch(() => null)) as { sample?: unknown } | null;
  if (typeof body?.sample !== "object" || body.sample === null || typeof (body.sample as { id?: unknown }).id !== "string") {
    return { ...NETWORK, message: SETTINGS_MESSAGES.failed };
  }
  return { ok: true, sample: body.sample as RecipeSample };
}

/** 最後に保存された抽出案を読む。本文は取得しない。 */
export async function loadGuideExtraction(recipeId: string): Promise<{ ok: true; extraction: GuideExtractionPreview | null } | SettingsFailure> {
  let response: Response;
  try {
    response = await fetch(`/api/settings/recipes/${encodeURIComponent(recipeId)}/guide-extraction`, { credentials: "same-origin", cache: "no-store" });
  } catch {
    return NETWORK;
  }
  if (!response.ok) return sampleFailureOf(response);
  const body = (await response.json().catch(() => null)) as { extraction?: unknown } | null;
  if (body?.extraction === null) return { ok: true, extraction: null };
  const extraction = body?.extraction as Partial<GuideExtractionPreview> | undefined;
  if (!extraction || !Array.isArray(extraction.sampleIds) || typeof extraction.guide !== "string" || !Array.isArray(extraction.candidates)) {
    return { ...NETWORK, message: SETTINGS_MESSAGES.failed };
  }
  return { ok: true, extraction: extraction as GuideExtractionPreview };
}

/** 保存済みのお手本からガイドと固有名詞候補を作り、確認用に保存する。 */
export async function extractGuide(recipeId: string): Promise<{ ok: true; extraction: GuideExtractionPreview } | SettingsFailure> {
  let response: Response;
  try {
    response = await fetch(`/api/settings/recipes/${encodeURIComponent(recipeId)}/guide-extraction`, { method: "POST", credentials: "same-origin" });
  } catch {
    return NETWORK;
  }
  if (!response.ok) return sampleFailureOf(response);
  const body = (await response.json().catch(() => null)) as { extraction?: unknown } | null;
  const extraction = body?.extraction as Partial<GuideExtractionPreview> | undefined;
  if (!extraction || !Array.isArray(extraction.sampleIds) || typeof extraction.guide !== "string" || !Array.isArray(extraction.candidates)) {
    return { ...NETWORK, message: SETTINGS_MESSAGES.failed };
  }
  return { ok: true, extraction: extraction as GuideExtractionPreview };
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
