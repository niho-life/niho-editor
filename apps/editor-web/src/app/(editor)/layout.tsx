import type { ReactNode } from "react";
import { headers } from "next/headers";
import { EditorFrame } from "@/components/EditorFrame";
import { StoreUnavailable } from "@/components/Notice";
import { listRecentPages } from "@niho/editor-store";
import { PAGE_CHUNK } from "@/lib/page-limits";
import { getPool, getStore } from "@/server/db";
import { frameMe, guessNarrow } from "@/server/frame";
import { requireSession } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * 描いた時刻（一覧の「N分前」の基準。ブラウザの最初の描画も同じ値を使う）。要求ごとに 1 回だけ読む
 * （react-hooks/purity は component の中の Date.now() を断るので関数に分ける。この layout は要求ごとに描く）。
 */
function renderedAt(): number {
  return Date.now();
}

/** editor の枠（一覧＋ヘッダー）。未ログインなら今の path を戻り先にしてログインへ。一覧は最初の区切りだけをここで読む。 */
export default async function EditorLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const store = getStore();
  if (!store) return <StoreUnavailable />;
  const pool = getPool();
  const [chunk, recent, requestHeaders] = await Promise.all([
    store.listPageChunk(session.userId, { limit: PAGE_CHUNK }),
    // 「最近」（#37。開いたページの記録。行が無ければ空）
    pool ? listRecentPages(pool, session.userId) : Promise.resolve([]),
    headers(),
  ]);
  return (
    <EditorFrame
      initial={{ pages: chunk.pages, next: chunk.next, recent, now: renderedAt(), me: frameMe(session), initialNarrow: guessNarrow(requestHeaders) }}
    >
      {children}
    </EditorFrame>
  );
}
