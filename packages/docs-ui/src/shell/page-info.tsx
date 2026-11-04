import { useEffect, useId, useRef, type RefObject } from "react";
import { Icon } from "./icons";
import { useMenuDismiss } from "./menu";

export type ShellPageInfoProps = {
  /** ボタンに出す数（「1,240 字」「1,180 words」）。 */
  count: string;
  /** ポップオーバーの行（作成・更新・録音・文字数）。 */
  rows: { label: string; value: string }[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** 渡すと、ポップオーバーの右上に ⓘ を出す（説明は押したときのシートだけに置く）。 */
  info?: { label: string; onOpen: () => void };
};

/**
 * 本文の列の右下の小さな文字数（EditorShell の corner に渡す）。押すと上にページの情報（作成・更新・録音・文字数）を出す。
 * Esc・外のクリックで閉じ、Esc のあとはボタンへフォーカスを戻す。開いたらポップオーバーの最初の要素へフォーカスする。
 */
export function ShellPageInfo({ count, rows, open, onToggle, onClose, info }: ShellPageInfoProps) {
  const button = useRef<HTMLButtonElement | null>(null);
  const popId = useId();
  return (
    <div className="es-countwrap">
      {open && (
        <PageInfoPop
          id={popId}
          rows={rows}
          info={
            info && {
              label: info.label,
              // ⓘ のシートを閉じたらボタンへ戻るよう、ポップオーバーを閉じてボタンへフォーカスしてから開く
              onOpen: () => {
                onClose();
                button.current?.focus();
                info.onOpen();
              },
            }
          }
          trigger={button}
          onClose={onClose}
        />
      )}
      <button
        ref={button}
        type="button"
        className="es-count"
        aria-label={`${count}、ページの情報`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={onToggle}
      >
        {count}
      </button>
    </div>
  );
}

function PageInfoPop({
  id,
  rows,
  info,
  trigger,
  onClose,
}: {
  id: string;
  rows: ShellPageInfoProps["rows"];
  info?: ShellPageInfoProps["info"];
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useMenuDismiss(ref, onClose, trigger);
  useEffect(() => {
    const node = ref.current;
    (node?.querySelector<HTMLElement>("button") ?? node)?.focus();
  }, []);
  return (
    <div ref={ref} id={id} className="es-count-pop" role="dialog" aria-label="ページの情報" tabIndex={-1}>
      {info && (
        <button type="button" className="es-info" aria-label={info.label} title={info.label} onClick={info.onOpen}>
          <Icon name="info" />
        </button>
      )}
      <dl className="es-kv">
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
