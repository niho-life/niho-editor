import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * シートの外を inert にする（支援技術から隠し、フォーカス・クリックも届かなくする）。#43。
 * veil から .es-root（無ければ body）までの各段で、自分以外の兄弟に inert を付ける。
 * 開く前から inert だった要素には触らない（返す関数は、ここで付けた分だけを外す）。aria-hidden も触らない。
 * React 18 は inert を props で扱えないので、属性を直に付け外しする。
 */
function inertOutside(veil: HTMLElement): () => void {
  const marked: Element[] = [];
  for (let node: HTMLElement = veil; node.parentElement; node = node.parentElement) {
    const parent = node.parentElement;
    for (const sibling of parent.children) {
      if (sibling === node || sibling.hasAttribute("inert")) continue;
      sibling.setAttribute("inert", "");
      marked.push(sibling);
    }
    if (parent.classList.contains("es-root") || parent === document.body) break;
  }
  return () => {
    for (const element of marked) element.removeAttribute("inert");
  };
}

export type ShellSheetProps = {
  /** ダイアログの名前（aria-label）。中身を替えるとき（公開 → 公開しました）はこれも替えると、フォーカスが中へ移り直す。 */
  label: string;
  onClose: () => void;
  /** .es-sheet に足す class（レールのシートの es-sheet--rail など）。 */
  className?: string;
  /** .es-veil に足す class（設定の集中編集の es-veil--edit：右に全高で出す）。 */
  veilClassName?: string;
  children: ReactNode;
};

/**
 * 公開のシートの枠。デスクトップでは中央、900px 未満では下からのシート（スタイル側）。
 * role="dialog" aria-modal。開いたら中（data-autofocus の要素、なければダイアログ自身）へフォーカスし、
 * Esc・外（幕）の押下で閉じ、Tab は中で回り、閉じたら開く前の要素へフォーカスを戻す。
 * 開いているあいだ、シートの外（.es-root の中の兄弟）は inert（閉じたら元に戻す）。
 * シートの中から別のシートを開いてもよい（入れ子）。そのあいだ Esc・Tab はいちばん内側のシートだけが扱う。
 * EditorShell の overlay に渡す（.es-root の中に出すため）。
 */
export function ShellSheet({ label, onClose, className, veilClassName, children }: ShellSheetProps) {
  const veil = useRef<HTMLDivElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  // 開く前にフォーカスしていた要素を覚え、外を inert にし、Esc で閉じ、閉じたら inert を外してから戻す
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreInert = veil.current ? inertOutside(veil.current) : () => undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // シートの中から開いたシート（入れ子。ⓘ の説明など）があれば、Esc はいちばん内側だけを閉じる
      if (dialog.current?.querySelector(".es-sheet")) return;
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // inert の要素にはフォーカスできないので、先に外す
      restoreInert();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // 開いたとき、中身が替わったとき（label が替わったとき）に、中へフォーカスを移す
  useEffect(() => {
    const node = dialog.current;
    (node?.querySelector<HTMLElement>("[data-autofocus]") ?? node)?.focus();
  }, [label]);

  const trap = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const node = dialog.current;
    // 入れ子のシートの中の Tab は、そのシートが回す
    if (event.target instanceof Element && event.target.closest(".es-sheet") !== node) return;
    const items = [...(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      node?.focus();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === node)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={veil}
      className={veilClassName ? `es-veil ${veilClassName}` : "es-veil"}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialog} className={className ? `es-sheet ${className}` : "es-sheet"} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={trap}>
        {children}
      </div>
    </div>
  );
}
