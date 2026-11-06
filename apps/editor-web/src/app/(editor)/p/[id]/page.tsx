import { notFound, redirect } from "next/navigation";
import { OpenPage } from "@/components/FramePages";
import { StoreUnavailable } from "@/components/Notice";
import { getStore } from "@/server/db";
import { recordingDeps, shareDeps } from "@/server/deps";
import { readRecordingSeconds } from "@/server/recordings-api";
import { requireSession } from "@/server/session";
import { readShareFlag } from "@/server/share-api";

export const dynamic = "force-dynamic";

const SIDE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ページ。別の人のページ・存在しない id・UUID として不正な id はどれも同じ 404。
 * リンクで共有しているか（「…」の「共有中」の印）も一緒に読む。渡すのは真偽だけで、リンク（bearer）は HTML・RSC の payload に入れない。
 * 録音ページ（kind が rec）だけ、情報パネルの「録音」の長さ（秒）を読む。渡すのは長さだけで、段落・話者名は payload に入れない。
 * id がタブの入れ物（kind='page'）なら最後に開いたタブへ（#307。URL はタブの id。`?side=` は保つ）。タブの帯（#308）のために、
 * 同じ入れ物のタブの一覧（本文なし）も渡す。
 */
export default async function PageView(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await props.params;
  const session = await requireSession(`/p/${id}`);
  const store = getStore();
  if (!store) return <StoreUnavailable />;
  const resolved = await store.resolvePage(session.userId, id);
  if (!resolved) notFound();
  const page = resolved.tab;
  if (page.id.toLowerCase() !== id.toLowerCase()) {
    const side = (await props.searchParams).side;
    redirect(`/p/${page.id}${typeof side === "string" && SIDE_ID.test(side) ? `?side=${side}` : ""}`);
  }
  // タブを開いたら、入れ物の「最後に開いたタブ」を進める（次に入れ物の id で開いたときに戻ってくる）
  const [shared] = await Promise.all([readShareFlag(shareDeps.store(), session.userId, page.id), page.page !== null ? store.touchLastTab(session.userId, page.id) : Promise.resolve(false)]);
  const { kind, title, lang, cover, lead, parent, stepStatus, createdAt, updatedAt } = page;
  // 開いたページの行は題名の表示に使うだけ（一覧の 2 行目の公開は listPageChunk の行が持つ）
  const recordingSec = kind === "rec" ? await readRecordingSeconds(recordingDeps.store(), session.userId, page.id) : null;
  return (
    <OpenPage
      key={page.id}
      summary={{ id: page.id, kind, title, lang, parent, stepStatus, sortOrder: page.sortOrder, page: page.page, role: page.role, madeFrom: page.madeFrom, createdAt, updatedAt, publication: null }}
      tabs={resolved.tabs.map(({ id: tabId, kind: tabKind, title: tabTitle, tabName, tabPos, stepStatus: tabStepStatus }) => ({
        id: tabId,
        kind: tabKind,
        title: tabTitle,
        tabName: tabName ?? null,
        tabPos: tabPos ?? 0,
        stepStatus: tabStepStatus,
      }))}
      blocks={page.blocks}
      revision={page.revision}
      cover={cover}
      lead={lead}
      shared={shared}
      recordingSec={recordingSec}
    />
  );
}
