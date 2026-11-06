/**
 * 何も足していない新しいページを捨てる（オーナー決定 2026-11-05）ための、端末の中の 2 つの控え。
 *
 * - 捨てる候補（localStorage `niho-editor:left-empty-pages`）: タブを閉じる・再読み込み・別のサイトへ移る（`pagehide`）ときは、
 *   その場では捨てずに id をここへ足すだけにする（再読み込みの `GET /p/{id}` と捨てる要求がすれ違って、開いているページが
 *   サーバーでは消えている、を起こさない）。次にアプリを開いたとき（EditorFrame）に、今開いているページ以外を捨てるよう頼む。
 * - このタブで作ったページ（sessionStorage `niho-editor:tab-created-pages`）: 「新しいページ」で作ったときに足す。再読み込みでも残るので、
 *   再読み込みのあと `/p/{id}` で開いたページも、何も足さずに離れたら捨てる対象になる。この印の無い既存のページは対象にしない。
 *
 * どちらも id（UUID）の配列だけを持つ（題名・本文は持たない）。読み書きできない環境（プライベートの制限など）では何もしない。
 */

import { PageRequestError, discardPageRequest } from "./pages-client";

export const LEFT_EMPTY_PAGES_KEY = "niho-editor:left-empty-pages";
export const TAB_CREATED_PAGES_KEY = "niho-editor:tab-created-pages";
/** 捨てる候補の上限（古いものから落とす）。 */
export const LEFT_EMPTY_PAGES_MAX = 20;
/** このタブで作ったページの印の上限（古いものから落とす）。 */
export const TAB_CREATED_PAGES_MAX = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Area = "local" | "session";

function storageOf(area: Area): Storage | null {
  try {
    return area === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function read(area: Area, key: string): string[] {
  try {
    const raw = storageOf(area)?.getItem(key);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const ids = value.filter((item): item is string => typeof item === "string" && UUID.test(item)).map((item) => item.toLowerCase());
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

function write(area: Area, key: string, ids: readonly string[]): void {
  try {
    const storage = storageOf(area);
    if (!storage) return;
    if (ids.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(ids));
  } catch {
    // 書けなくても、捨て損ねた空のページが一覧に残るだけ
  }
}

/** 足す（重複なし。上限を超えたら古いものから落とす）。 */
function add(area: Area, key: string, max: number, ids: readonly string[]): void {
  const fresh = ids.filter((id) => UUID.test(id)).map((id) => id.toLowerCase());
  if (fresh.length === 0) return;
  const next = [...read(area, key).filter((id) => !fresh.includes(id)), ...fresh];
  write(area, key, next.slice(-max));
}

/** `pagehide` で離れた、何も足していないページを捨てる候補に足す。 */
export function addLeftEmptyCandidate(id: string): void {
  add("local", LEFT_EMPTY_PAGES_KEY, LEFT_EMPTY_PAGES_MAX, [id]);
}

/** 捨てる候補を全て取り出す（取り出した分は控えから消える。届かなかったものは returnLeftEmptyCandidates で戻す）。 */
export function takeLeftEmptyCandidates(): string[] {
  const ids = read("local", LEFT_EMPTY_PAGES_KEY);
  if (ids.length > 0) write("local", LEFT_EMPTY_PAGES_KEY, []);
  return ids;
}

/** 捨てる要求が届かなかった候補を戻す。 */
export function returnLeftEmptyCandidates(ids: readonly string[]): void {
  add("local", LEFT_EMPTY_PAGES_KEY, LEFT_EMPTY_PAGES_MAX, ids);
}

/** 候補から外す（開き直して、また開いているページ）。 */
export function dropLeftEmptyCandidate(id: string): void {
  const ids = read("local", LEFT_EMPTY_PAGES_KEY);
  const next = ids.filter((item) => item !== id.toLowerCase());
  if (next.length !== ids.length) write("local", LEFT_EMPTY_PAGES_KEY, next);
}

/** このタブの「新しいページ」で作ったページとして覚える。 */
export function markTabCreatedPage(id: string): void {
  add("session", TAB_CREATED_PAGES_KEY, TAB_CREATED_PAGES_MAX, [id]);
}

/**
 * 「新しいページ」で作ったページの印を外す（何も足していない新しいページを捨てる対象から外す）。
 * 利用者がそのページに自分で何かを足した（タブの ＋）ときに使う。捨てる候補にも残さない。
 */
export function unmarkTabCreatedPage(id: string): void {
  const key = id.toLowerCase();
  const ids = read("session", TAB_CREATED_PAGES_KEY);
  const next = ids.filter((item) => item !== key);
  if (next.length !== ids.length) write("session", TAB_CREATED_PAGES_KEY, next);
  dropLeftEmptyCandidate(id);
}

/** このタブの「新しいページ」で作ったページか（再読み込みのあとも分かる）。 */
export function isTabCreatedPage(id: string): boolean {
  return UUID.test(id) && read("session", TAB_CREATED_PAGES_KEY).includes(id.toLowerCase());
}

/** 捨てる要求の失敗のうち、あとでもう一度頼むもの（届かなかった・ログイン切れ・サーバーの失敗）。404 などは頼み直さない。 */
export function isRetryableDiscardError(error: unknown): boolean {
  if (!(error instanceof PageRequestError)) return true;
  return error.status === 401 || error.status >= 500;
}

/**
 * アプリを開いたとき: 捨てる候補を、今開いているページ（再読み込み・最後に開いたページへ戻った）以外について捨てるよう頼む。
 * 今開いているページは候補から外すだけ（捨てない）。消えたら onRemoved。届かなかったものは候補に戻し、404・空でなかったものは外す。
 */
export async function discardLeftEmptyCandidates(currentId: string | null, onRemoved: (id: string) => void): Promise<void> {
  const current = currentId?.toLowerCase() ?? null;
  const ids = takeLeftEmptyCandidates().filter((id) => id !== current);
  const retry: string[] = [];
  await Promise.all(
    ids.map((id) =>
      discardPageRequest(id).then(
        (discarded) => {
          if (discarded) onRemoved(id);
        },
        (error: unknown) => {
          if (isRetryableDiscardError(error)) retry.push(id);
        },
      ),
    ),
  );
  if (retry.length > 0) returnLeftEmptyCandidates(retry);
}
