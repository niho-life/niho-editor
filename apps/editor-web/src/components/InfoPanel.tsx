"use client";

import { ShellRail } from "niho-docs-ui/shell";
import type { AttachedAiSteps, AttachedPage } from "@/lib/attached-page";
import { AiPanel, type AiPanelPlacement } from "./AiBox";

export type InfoPanelProps = {
  /** 開いているページ（下書きを読み終えて、操作できるとき）。読み込んでいる間は null（AI は描くだけで操作を受けない）。 */
  page: AttachedPage | null;
  /** PageSteps が持つ既存の工程。通常ページは null。 */
  aiSteps: AttachedAiSteps | null;
  /** パネルの配置（設計 §5.5）での置き場所。デスクトップだけ渡す（AiPanel の placement。見出しを掴んで動かせる）。 */
  placement?: AiPanelPlacement;
  /** パネルの ×（#311。押すと「AIと作る」を閉じる）。 */
  onClose?: () => void;
  /** AI がページを書き換えた・元に戻した（右に並べたページを読み直す）。 */
  onPagesChanged?: (pageIds: readonly string[]) => void;
};

/**
 * 「AIと作る」のパネル。AI だけを置く（ページ設定は持たない。公開に関する欄は公開のシート、フォルダの移動・並びは「⋯」の「移動…」と
 * 左の一覧のドラッグ、文字数とページの情報は本文の列の右下、書き出し・削除は「⋯」）。
 * パネルを閉じても AI は mount したまま、会話 draft と実行中の処理を保つ。別のドックへ移しても作り直さない（EditorShell の dock）。
 */
export function InfoPanel({ page, aiSteps, placement, onClose, onPagesChanged }: InfoPanelProps) {
  return (
    <ShellRail label="AIと作る" onClosePanel={onClose}>
      <AiPanel pageId={page?.id ?? null} context={page?.ai ?? null} steps={aiSteps} placement={placement} onPagesChanged={onPagesChanged} />
    </ShellRail>
  );
}
