/** ブラウザから フォルダまわりの API（並び・子の一覧・録音の欄・「最近」。#37）を呼ぶ（同じ origin）。 */

import type { PageEntity, PageFields, PageSummary } from "@niho/editor-store";
import { PageRequestError } from "./pages-client";

async function send(path: string, method: "POST" | "PATCH", body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new PageRequestError(response.status);
  return response.status === 204 ? null : response.json();
}

/**
 * 手動の並びを 1 つ動かす。もう端なら `moved: false`（何も変わっていない）。動かしたときの `orders` は、同じ親の全ての行の
 * サーバーが確定した並び（行の id → sortOrder。読み込んでいない兄弟も含む）。
 */
export async function movePageOrderRequest(id: string, move: "up" | "down"): Promise<{ moved: boolean; orders: Map<string, number> }> {
  const data = (await send(`/api/pages/${encodeURIComponent(id)}/order`, "PATCH", { move })) as { moved?: unknown; orders?: unknown } | null;
  const orders = new Map<string, number>();
  if (Array.isArray(data?.orders)) {
    for (const item of data.orders as unknown[]) {
      const { id: rowId, sortOrder } = (item ?? {}) as { id?: unknown; sortOrder?: unknown };
      if (typeof rowId === "string" && typeof sortOrder === "number" && Number.isSafeInteger(sortOrder)) orders.set(rowId, sortOrder);
    }
  }
  return { moved: data?.moved === true, orders };
}

/** ページを開いたことを「最近」に記録する（届かなくても画面は止めない）。 */
export async function recordPageOpenRequest(id: string): Promise<void> {
  await send(`/api/pages/${encodeURIComponent(id)}/open`, "POST");
}

function fieldsOf(data: unknown): PageFields {
  const fields = (data as { fields?: unknown } | null)?.fields;
  if (typeof fields !== "object" || fields === null) throw new PageRequestError(500);
  const { entities, terms, background } = fields as { entities?: unknown; terms?: unknown; background?: unknown };
  return {
    entities: Array.isArray(entities) ? (entities as PageEntity[]) : [],
    terms: Array.isArray(terms) ? (terms as PageFields["terms"]) : [],
    background: typeof background === "string" ? background : "",
  };
}

/** 録音ページの欄「この録音について」（登場人物・固有名詞・背景）。 */
export async function loadPageFields(id: string): Promise<PageFields> {
  const response = await fetch(`/api/pages/${encodeURIComponent(id)}/fields`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new PageRequestError(response.status);
  return fieldsOf(await response.json());
}

/** 録音ページの欄を入れ替える（渡した項目だけ）。 */
export async function savePageFieldsRequest(id: string, patch: Partial<PageFields>): Promise<PageFields> {
  return fieldsOf(await send(`/api/pages/${encodeURIComponent(id)}/fields`, "PATCH", patch));
}

/** そのページの中の行（フォルダの子。並びの順）。 */
export async function listPageChildrenRequest(id: string): Promise<PageSummary[]> {
  const response = await fetch(`/api/pages/${encodeURIComponent(id)}/children`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new PageRequestError(response.status);
  const data = (await response.json()) as { pages?: unknown };
  if (!Array.isArray(data.pages)) throw new PageRequestError(500);
  return data.pages as PageSummary[];
}

/** フォルダの書き出し（.md ＋写真の zip）の URL。 */
export function folderExportUrl(id: string): string {
  return `/api/pages/${encodeURIComponent(id)}/export.zip`;
}
