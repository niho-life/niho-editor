import { useEffect, useState } from "react";
import { TabBar } from "../src/page/TabBar";
import { EditorShell, ShellHeader, ShellPanelHead, ShellRail, ShellSidebar, ShellSidePane, SHELL_DOCK_DEFAULT, computeShellDock, type ShellDocks } from "../src/shell";

// 実ブラウザ・Mac の WebView で、合成イベントを使わず DnD を検証する画面。
// 通信・保存・AI 実行は持たず、製品と同じ一覧・ドック・右ページを組み合わせる。
const pages = [
  { id: "main", title: "合成メイン", when: "たった今" },
  { id: "reference", title: "合成参考ページ", when: "たった今" },
  { id: "third", title: "合成第三ページ", when: "たった今" },
];
const docks: ShellDocks = { left: [{ id: "list", size: 1 }], right: [{ id: "ai", size: 1 }] };

export function SplitDemo({ windowControls = false }: { windowControls?: boolean }) {
  const [main, setMain] = useState("main");
  const [side, setSide] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(true);
  const [folderOpen, setFolderOpen] = useState(true);
  const [width, setWidth] = useState(document.documentElement.clientWidth);
  useEffect(() => {
    const resize = () => setWidth(document.documentElement.clientWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const openSide = (id: string) => { if (id !== main) setSide(id); };
  const title = (id: string) => pages.find((page) => page.id === id)?.title ?? "フォルダ内の合成ページ";
  return (
    <div className="g-frame" data-docs-app-root="" data-docs-shared-ui="">
      <EditorShell
        windowControls={windowControls} sidebarOpen={listOpen} railOpen={width >= 900}
        sidebar={<ShellSidebar items={[...pages, { id: "folder", title: "合成フォルダ", when: "昨日", folder: true, icon: "folder", open: folderOpen }, ...(folderOpen ? [{ id: "child", title: "フォルダ内の合成ページ", when: "昨日", depth: 1 as const }] : [])]} currentId={main} onSelect={setMain} onToggleFolder={() => setFolderOpen((open) => !open)} onCollapse={() => setListOpen(false)} onDrop={() => undefined} side={{ id: side ?? undefined, onOpen: openSide }} />}
        header={<ShellHeader showListButton={!listOpen} onToggleList={() => setListOpen((open) => !open)} />}
        rail={<ShellRail><ShellPanelHead panel="ai" drag /><textarea aria-label="AIへのメッセージ" defaultValue="保持する合成の入力" /></ShellRail>}
        dock={{
          wide: width >= 900, docks, widths: { ...SHELL_DOCK_DEFAULT },
          fit: computeShellDock({ width, widths: { ...SHELL_DOCK_DEFAULT }, docks: { left: listOpen ? ["list"] : [], right: ["ai"] }, side: side !== null }),
          onDropPage: (id, where) => where === "side" ? openSide(id) : setMain(id),
          side: side ? <ShellSidePane pageId={side} title={title(side)} onClose={() => setSide(null)} onSwap={() => { setMain(side); setSide(main); }}><p>{title(side)}の本文</p></ShellSidePane> : undefined,
        }}
      >
        <TabBar tabs={[{ id: main, label: "下書き" }]} currentId={main} onOpen={setMain} onAdd={() => undefined} />
        <article className="es-canvas-in"><h1>{title(main)}</h1><div className="es-body">{Array.from({ length: 45 }, (_, index) => <p key={index}>合成本文 {index + 1}。スクロールを確認するための文章です。</p>)}</div></article>
      </EditorShell>
    </div>
  );
}
