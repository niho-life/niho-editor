"use client";

import { ShellRail } from "niho-docs-ui/shell";
import type { AttachedAiSteps, AttachedPage } from "@/lib/attached-page";
import { AiPanel } from "./AiBox";

export type InfoPanelProps = {
  /** 開いているページ（下書きを読み終えて、操作できるとき）。読み込んでいる間は null（AI は描くだけで操作を受けない）。 */
  page: AttachedPage | null;
  /** PageSteps が持つ既存の工程。通常ページは null。 */
  aiSteps: AttachedAiSteps | null;
};

/**
 * 右のレール。「AIと作る」だけを置く（ページ設定は持たない。公開に関する欄は公開のシート、フォルダの移動・並びは「⋯」の「移動…」と
 * 左の一覧のドラッグ、文字数とページの情報は本文の列の右下、書き出し・削除は「⋯」）。
 * レールを閉じても AI は mount したまま、会話 draft と実行中の処理を保つ。
 */
export function InfoPanel({ page, aiSteps }: InfoPanelProps) {
  return (
    <ShellRail label="AIと作る">
      <AiPanel pageId={page?.id ?? null} context={page?.ai ?? null} steps={aiSteps} />
    </ShellRail>
  );
}
