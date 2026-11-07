import { useEffect, useState } from "react";
import { EditorShell, ShellHeader, ShellPanelHead, ShellRail, ShellSidebar, ShellSidePane, SHELL_DOCK_DEFAULT, computeShellDock, type ShellDocks } from "../src/shell";

// 実ブラウザ・Mac の WebView で、合成イベントを使わず DnD を検証する画面。
// 通信・保存・AI 実行は持たず、製品と同じ一覧・ドック・右ページを組み合わせる。
const pages = [
  { id: "main", title: "合成メイン", when: "たった今" },
  { id: "reference", title: "合成参考ページ", when: "たった今" },
  { id: "third", title: "合成第三ページ", when: "たった今" },
];
const docks: ShellDocks = { left: [{ id: "list", size: 1 }], right: [{ id: "ai", size: 1 }] };

export function SplitDemo() {
  const [main, setMain] = useState("main");
  const [side, setSide] = useState<string | null>(null);
  const [width, setWidth] = useState(document.documentElement.clientWidth);
  useEffect(() => {
    const resize = () => setWidth(document.documentElement.clientWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const openSide = (id: string) => { if (id !== main) setSide(id); };
  const title = (id: string) => pages.find((page) => page.id === id)!.title;
  return (
    <div className="g-frame" data-docs-app-root="" data-docs-shared-ui="">
      <EditorShell
        sidebarOpen railOpen
        sidebar={<ShellSidebar items={pages} currentId={main} onSelect={setMain} onDrop={() => undefined} side={{ id: side ?? undefined, onOpen: openSide }} />}
        header={<ShellHeader />}
        rail={<ShellRail><ShellPanelHead panel="ai" drag /><textarea aria-label="AIへのメッセージ" defaultValue="保持する合成の入力" /></ShellRail>}
        dock={{
          wide: width >= 900, docks, widths: { ...SHELL_DOCK_DEFAULT },
          fit: computeShellDock({ width, widths: { ...SHELL_DOCK_DEFAULT }, docks: { left: ["list"], right: ["ai"] }, side: side !== null }),
          onDropPage: (id, where) => where === "side" ? openSide(id) : setMain(id),
          side: side ? <ShellSidePane pageId={side} title={title(side)} onClose={() => setSide(null)} onSwap={() => { setMain(side); setSide(main); }}><p>{title(side)}の本文</p></ShellSidePane> : undefined,
        }}
      >
        <article><h1>{title(main)}</h1><p>実機ドラッグ確認用の合成本文です。</p></article>
      </EditorShell>
    </div>
  );
}
