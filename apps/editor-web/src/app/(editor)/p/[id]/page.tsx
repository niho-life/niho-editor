import { notFound } from "next/navigation";
import { OpenPage } from "@/components/FramePages";
import { StoreUnavailable } from "@/components/Notice";
import { getStore } from "@/server/db";
import { recordingDeps, shareDeps } from "@/server/deps";
import { readRecordingSeconds } from "@/server/recordings-api";
import { requireSession } from "@/server/session";
import { readShareFlag } from "@/server/share-api";

export const dynamic = "force-dynamic";

/**
 * ページ。別の人のページ・存在しない id・UUID として不正な id はどれも同じ 404。
 * リンクで共有しているか（「…」の「共有中」の印）も一緒に読む。渡すのは真偽だけで、リンク（bearer）は HTML・RSC の payload に入れない。
 * 録音ページ（kind が rec）だけ、情報パネルの「録音」の長さ（秒）を読む。渡すのは長さだけで、段落・話者名は payload に入れない。
 */
export default async function PageView(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await requireSession(`/p/${id}`);
  const store = getStore();
  if (!store) return <StoreUnavailable />;
  const [page, shared] = await Promise.all([store.getPage(session.userId, id), readShareFlag(shareDeps.store(), session.userId, id)]);
  if (!page) notFound();
  const { kind, title, lang, parent, stepStatus, createdAt, updatedAt } = page;
  // 開いたページの行は題名の表示に使うだけ（一覧の 2 行目の公開は listPageChunk の行が持つ）
  const recordingSec = kind === "rec" ? await readRecordingSeconds(recordingDeps.store(), session.userId, page.id) : null;
  return (
    <OpenPage
      key={page.id}
      summary={{ id: page.id, kind, title, lang, parent, stepStatus, sortOrder: page.sortOrder, createdAt, updatedAt, publication: null }}
      blocks={page.blocks}
      revision={page.revision}
      shared={shared}
      recordingSec={recordingSec}
    />
  );
}
