import { useEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Icon } from "./icons";
import type { ShellMenuItem } from "./types";

/**
 * 開いているあいだだけ、Esc と外のクリックでメニューを閉じる。Esc のあとはボタン（trigger）へフォーカスを戻す。
 * trigger を押したときの開閉は呼ぶ側の onClick が持つ（外のクリック扱いにしない）。
 */
export function useMenuDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  trigger?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
      trigger?.current?.focus();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target) || trigger?.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [ref, onClose, trigger]);
}

export type ShellMenuProps = {
  label: string;
  items: ShellMenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
  trigger?: RefObject<HTMLElement | null>;
  className?: string;
  style?: CSSProperties;
};

/** 開いたら先頭にフォーカスし、↑↓・Home・End で動かし、Esc で閉じるメニュー。 */
export function ShellMenu({ label, items, onSelect, onClose, trigger, className, style }: ShellMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useMenuDismiss(ref, onClose, trigger);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  const move = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };
  return (
    <div ref={ref} className={className ? `es-menu ${className}` : "es-menu"} style={style} role="menu" aria-label={label} onKeyDown={move}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
          className={`es-mi${item.danger ? " es-mi--danger" : ""}${item.current ? " es-mi--on" : ""}`}
          aria-current={item.current ? "page" : undefined}
          aria-checked={item.checked === undefined ? undefined : item.checked}
          aria-disabled={item.disabled || undefined}
          onClick={() => !item.disabled && onSelect(item.id)}
        >
          {item.icon && <Icon name={item.icon} />}
          {item.label}
          {item.badge ? <small className="es-mi-badge">{item.badge}</small> : item.hint ? <small>{item.hint}</small> : null}
          {item.checked && <span className="es-mi-check" aria-hidden="true"><Icon name="check" /></span>}
        </button>
      ))}
    </div>
  );
}
