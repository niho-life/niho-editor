/** ブラウザから `/api/pages/{id}/publish` を呼ぶ（同じ origin。cookie・token は扱わない）。 */

import type { PublishSelection, PublishSheetDto, PublishedResultDto } from "@/server/publish-api";
import { PUBLISH_MESSAGES } from "@/publish/messages";

export type { PublishSelection, PublishSheetDto, PublishedResultDto };

/** 失敗。message は画面に出す一言（応答に無ければ status から決める）。 */
export type PublishFailure = { ok: false; status: number; error: string | null; message: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pathOf(pageId: string, suffix = ""): string {
  if (!UUID_PATTERN.test(pageId)) throw new Error("invalid page id");
  return `/api/pages/${pageId}/publish${suffix}`;
}

function fallbackMessage(status: number, fallback: string): string {
  if (status === 401) return PUBLISH_MESSAGES.signedOut;
  if (status === 403) return PUBLISH_MESSAGES.forbidden;
  if (status === 404) return PUBLISH_MESSAGES.notFound;
  if (status === 503) return PUBLISH_MESSAGES.unavailable;
  return fallback;
}

async function failureOf(response: Response, fallback: string): Promise<PublishFailure> {
  const body = (await response.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  return {
    ok: false,
    status: response.status,
    error: typeof body?.error === "string" ? body.error : null,
    message: typeof body?.message === "string" ? body.message : fallbackMessage(response.status, fallback),
  };
}

const NETWORK: PublishFailure = { ok: false, status: 0, error: null, message: PUBLISH_MESSAGES.network };

/** シートの query（handle・range・extras・slug）。null なら公開している発信先の既定。 */
export function sheetQuery(selection: PublishSelection | null): string {
  if (selection === null) return "";
  const params = new URLSearchParams({
    handle: selection.handle,
    range: selection.range,
    extras: (["app", "news", "xp"] as const).filter((key) => selection.extras[key]).join(","),
  });
  if (selection.slug !== null) params.set("slug", selection.slug);
  if (selection.category !== null) params.set("category", selection.category);
  if (selection.related.length > 0) params.set("related", selection.related.join(","));
  return `?${params.toString()}`;
}

/** シートのデータ。 */
export async function loadPublishSheet(pageId: string, selection: PublishSelection | null): Promise<{ ok: true; sheet: PublishSheetDto } | PublishFailure> {
  let response: Response;
  try {
    response = await fetch(`${pathOf(pageId)}${sheetQuery(selection)}`, { credentials: "same-origin", cache: "no-store" });
  } catch {
    return NETWORK;
  }
  if (!response.ok) return failureOf(response, PUBLISH_MESSAGES.unavailable);
  // 応答の形が違う（JSON でない・sheet が無い）ときも、例外にせず失敗として返す（画面は読み込みの失敗を出す）
  const body = (await response.json().catch(() => null)) as { sheet?: unknown } | null;
  if (typeof body?.sheet !== "object" || body.sheet === null) return { ok: false, status: response.status, error: null, message: PUBLISH_MESSAGES.unavailable };
  return { ok: true, sheet: body.sheet as PublishSheetDto };
}

/** 公開する・更新を公開・保存・発信先を変える（どれにするかはサーバーが今の公開から決める）。slug は変えられるときだけ送る。 */
export async function publishPageRequest(
  pageId: string,
  body: { handle: string; range: PublishSelection["range"]; extras: PublishSelection["extras"]; category: string | null; related: readonly string[]; slug?: string },
): Promise<{ ok: true; published: PublishedResultDto } | PublishFailure> {
  let response: Response;
  try {
    response = await fetch(pathOf(pageId), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return NETWORK;
  }
  if (!response.ok) return failureOf(response, PUBLISH_MESSAGES.failed);
  const data = (await response.json()) as { published: PublishedResultDto };
  return { ok: true, published: data.published };
}

/** 公開をやめる。 */
export async function stopPublishingRequest(pageId: string): Promise<{ ok: true } | PublishFailure> {
  let response: Response;
  try {
    response = await fetch(pathOf(pageId, "/stop"), { method: "POST", credentials: "same-origin" });
  } catch {
    return NETWORK;
  }
  if (!response.ok) return failureOf(response, PUBLISH_MESSAGES.stopFailed);
  return { ok: true };
}
