"use client";

import { useRef, useState, type SyntheticEvent } from "react";
import type { Block } from "@niho/editor-store";
import { PageFlow } from "niho-docs-ui/page/PageFlow";
import { ShellPanelHead } from "niho-docs-ui/shell";
import type { AttachedFlow } from "@/lib/attached-page";
import { StepsRequestError, getStepPartialOutput, updateStepRunRecipe, type StepRun, type StepRunStep } from "@/lib/steps-client";
import { isStepRunActive } from "@/lib/steps-view";

function blockText(value: unknown): string {
  if (Array.isArray(value)) return value.map(blockText).join("");
  if (typeof value !== "object" || value === null) return "";
  const node = value as Record<string, unknown>;
  if (node.type === "text") return typeof node.text === "string" ? node.text : "";
  if (node.type === "hardBreak") return "\n";
  const children = Array.isArray(node.content) ? node.content.map(blockText).join("") : "";
  if (node.type === "heading") return "#".repeat(node.attrs && typeof node.attrs === "object" && (node.attrs as Record<string, unknown>).level === 3 ? 3 : 2) + " " + children;
  if (node.type === "bulletList") return Array.isArray(node.content) ? node.content.map((item) => "• " + blockText(item)).join("\n") : "";
  if (node.type === "callout") return children.split("\n").map((line) => "▌ " + line).join("\n");
  return children;
}

function partialText(blocks: readonly Block[]): string {
  return blocks.map((block) => blockText(block)).filter(Boolean).join("\n\n");
}

/** 失敗した段階の途中出力（利用者が開いたときだけ読む。details/summary なのでキーボードで開閉できる）。 */
function StepPartialOutputDisclosure({ folderId, runId, step }: { folderId: string; runId: string; step: StepRunStep }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open || loading || loaded.current) return;
    loaded.current = true;
    setLoading(true);
    void getStepPartialOutput(folderId, runId, step.index)
      .then((blocks) => setContent(partialText(blocks)))
      .catch((reason: unknown) => {
        loaded.current = false;
        setError(reason instanceof StepsRequestError && reason.status === 401
          ? "ログインが切れています。もう一度ログインしてください。"
          : reason instanceof StepsRequestError && reason.status === 404
            ? "この途中出力はもう利用できません。流れを読み直してください。"
            : "途中出力を読み出せませんでした。しばらくしてからもう一度お試しください。");
      })
      .finally(() => setLoading(false));
  };

  return (
    <details className="es-stepband-partial" onToggle={onToggle}>
      <summary>「{step.name}」の途中までの出力を確認</summary>
      {loading && <p role="status">読み込み中です。</p>}
      {error && <p role="status">{error}</p>}
      {content !== null && <pre aria-label="途中までの出力">{content || "表示できる本文がありません。"}</pre>}
    </details>
  );
}

/** 使っている手順の版と、新しくなっていれば変更の一覧と「今の設計に更新」。 */
function RunRecipeNote({ folderId, run, busy, onUpdated }: { folderId: string; run: StepRun; busy: boolean; onUpdated: (message: string) => void }) {
  const [sending, setSending] = useState(false);
  if (run.recipeRevision === undefined) return null;
  const current = run.currentRevision ?? null;
  const update = async () => {
    setSending(true);
    try {
      await updateStepRunRecipe(folderId, run.id, run.recipeRevision!);
      onUpdated("手順の写しを今の設計に更新しました。必要な段階を作り直してください。");
    } catch {
      onUpdated("手順の写しを更新できませんでした。しばらくしてからもう一度。");
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="es-stepband-note">
      使用中の手順: 第{run.recipeRevision}版{current !== null ? `（現在: 第${current}版）` : ""}
      {current !== null && current !== run.recipeRevision && (
        <details>
          <summary>手順が新しくなっています。変更内容を見る</summary>
          <ul>{(run.designChanges ?? []).map((change, index) => <li key={`${index}-${change}`}>{change}</li>)}</ul>
          <p>更新後、必要な段階は流れの「作成」か、タブの「作り直す」で実行してください。段階の追加・削除・並び替えがある場合は、はじめから作り直してください。</p>
          <button type="button" className="es-btn es-btn--outline es-btn--sm" disabled={busy || sending || isStepRunActive(run)} onClick={() => void update()}>
            今の設計に更新
          </button>
        </details>
      )}
    </div>
  );
}

/**
 * 「ページ」のパネルの中身（#311 の箱。#309 で「流れ」）。開いているタブの流れ（FlowWatcher が枠に登録した AttachedFlow）を描く:
 * 手順名 ▾ · フォルダ名、録音 › 文字起こし › 段階… の行と右端の 作成／済み、run の一言と操作、失敗の途中出力、手順の版。
 * 流れの無いページ（フォルダ・古い段階のサブページ）では一言だけ。
 */
export function PagePanel({ flow, onClose, drag }: { flow: AttachedFlow | null; onClose: () => void; drag: boolean }) {
  // 操作の結果の一言はそのタブの分だけ出す（タブが替わったら前の一言は出さない）
  const [note, setNote] = useState<{ owner: string; text: string } | null>(null);
  const ownerId = flow?.ownerId ?? null;
  const run = async (job: () => Promise<{ ok: boolean; message: string }>) => {
    if (!flow) return;
    const result = await job();
    setNote({ owner: flow.ownerId, text: result.message });
  };
  const own = note && note.owner === ownerId ? note.text : null;
  const folderId = flow?.folder?.id ?? null;
  return (
    <>
      <ShellPanelHead panel="page" onClose={onClose} drag={drag} />
      <div className="es-pn-body">
        {flow ? (
          <PageFlow
            recipe={flow.recipe}
            recipes={flow.recipes}
            folder={flow.folder}
            rows={flow.rows}
            busy={flow.busy}
            note={own ?? flow.note}
            actions={flow.actions}
            onAction={flow.onAction}
            onOpen={flow.open}
            onMake={(row) => void run(() => flow.make(row))}
            onTranscribe={(engine) => void run(() => flow.transcribe(engine))}
            onChangeRecipe={(id) => void run(() => flow.changeRecipe(id))}
          >
            {flow.run && folderId && <RunRecipeNote folderId={folderId} run={flow.run} busy={flow.busy} onUpdated={(text) => setNote({ owner: flow.ownerId, text })} />}
            {flow.run && folderId && flow.run.steps.filter((step) => step.state === "failed" && step.hasPartialOutput).map((step) => (
              <StepPartialOutputDisclosure key={flow.run!.id + ":" + step.id + ":" + step.tries} folderId={folderId} runId={flow.run!.id} step={step} />
            ))}
          </PageFlow>
        ) : (
          <p className="es-pn-note">ページを開くと、そのフォルダの手順の流れ（録音 › 文字起こし › 段階）がここに出ます。</p>
        )}
      </div>
    </>
  );
}
