"use client";

import { ShellRail } from "niho-docs-ui/shell";
import type { AttachedAiSteps, AttachedPage } from "@/lib/attached-page";
import { AiPanel, type AiPanelPlacement, type AiReads } from "./AiBox";

export type InfoPanelProps = {
  /** 開いているページ（下書きを読み終えて、操作できるとき）。読み込んでいる間は null（AI は描くだけで操作を受けない）。 */
  page: AttachedPage | null;
  /** PageSteps が持つ既存の工程。通常ページは null。 */
  aiSteps: AttachedAiSteps | null;
  /** 分割ビュー（設計 §5.5）での置き場所。デスクトップだけ渡す（AiPanel の placement）。 */
  placement?: AiPanelPlacement;
  /** AI がページを書き換えた・元に戻した（右に並べたページを読み直す）。 */
  onPagesChanged?: (pageIds: readonly string[]) => void;
  /** 入力欄の上の「読むもの」。 */
  reads?: AiReads | null;
};

/**
 * 右のレール。「AIと作る」だけを置く（ページ設定は持たない。公開に関する欄は公開のシート、フォルダの移動・並びは「⋯」の「移動…」と
 * 左の一覧のドラッグ、文字数とページの情報は本文の列の右下、書き出し・削除は「⋯」）。
 * レールを閉じても AI は mount したまま、会話 draft と実行中の処理を保つ。左のドック・メインの下へ移しても作り直さない（EditorShell の dock）。
 */
export function InfoPanel({ page, aiSteps, placement, onPagesChanged, reads }: InfoPanelProps) {
  return (
    <ShellRail label="AIと作る">
      <AiPanel pageId={page?.id ?? null} context={page?.ai ?? null} steps={aiSteps} placement={placement} onPagesChanged={onPagesChanged} reads={reads} />
    </ShellRail>
  );
}
