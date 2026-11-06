import type { RefObject } from "react";
import { Icon } from "./icons";
import { ShellMenu } from "./menu";
import type { ShellMenuItem } from "./types";

export type NewPageKind = "blank" | "recording" | "folder";

const ITEMS: Record<NewPageKind, ShellMenuItem> = {
  blank: { id: "blank", label: "空のページ", icon: "doc", hint: "⌘N" },
  recording: { id: "recording", label: "録音から", icon: "mic" },
  // フォルダは入れ子にしないので、いつも上の段にできる（それを言葉では書かない。オーナー 2026-11-06）
  folder: { id: "folder", label: "フォルダ", icon: "folder", separated: true },
};

/** 既定の項目（Web）。Mac は `kinds={["blank", "recording"]}` を渡して今の 2 つのままにできる。 */
export const NEW_PAGE_KINDS: readonly NewPageKind[] = ["blank", "recording", "folder"];

/**
 * 「新しいページ」の＋を押すと出るメニュー。空のページ（⌘N）／録音から／（区切り）フォルダ。
 * `inside` を渡すと上に「『◯◯』の中に」の見出しを出す（空のページ・録音からはそのフォルダの中にできる。呼ぶ側が作る）。
 */
export function NewPageMenu({
  onPick,
  onClose,
  trigger,
  kinds = NEW_PAGE_KINDS,
  inside,
}: {
  onPick: (kind: NewPageKind) => void;
  onClose: () => void;
  trigger?: RefObject<HTMLElement | null>;
  kinds?: readonly NewPageKind[];
  inside?: { title: string } | null;
}) {
  const items = kinds.map((kind, index) => (index === 0 ? { ...ITEMS[kind], separated: false } : ITEMS[kind]));
  return (
    <ShellMenu
      label={inside ? `新しいページ（「${inside.title || "無題"}」の中に）` : "新しいページ"}
      className="es-menu--narrow"
      items={items}
      trigger={trigger}
      onClose={onClose}
      heading={
        inside ? (
          <>
            <Icon name="folder" />
            <span>「{inside.title || "無題"}」の中に</span>
          </>
        ) : undefined
      }
      onSelect={(id) => onPick(id === "recording" ? "recording" : id === "folder" ? "folder" : "blank")}
    />
  );
}
