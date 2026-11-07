import "niho-ui/styles/tokens.css";
import "niho-ui/styles/editor-tokens.css";
import "../src/styles/shell.css";
import "./gallery.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Check } from "./check";
import { AccountDemo, DestDemo, LoginDemo, PreviewDemo, SettingsDemo, SiteDemo, WebDestDemo, WebSettingsDemo, WebSiteDemo } from "./pages";
import type { ShellDest } from "../src/shell";
import { Screen, type ScreenForced } from "./screen";
import { SplitDemo } from "./split-demo";
import { SCREENS, findScreen, parseHash } from "./screens";

function useRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return { hash, ...parseHash(hash) };
}

function Index() {
  return (
    <main className="g-index">
      <h1>NIHO editor 枠（shell）ギャラリー</h1>
      <p>モック v6（#48）フェーズ1・2の画面。状態はこのページの useState で持ち、DocsHost・通信・保存は使わない。</p>
      <ul>
        <li><a href="#/split">分割ビューの実機ドラッグ確認（合成ページ）</a></li>
        <li><a href="#/split?mac=1">Macの余白・スクロール・フォルダの確認（合成ページ）</a></li>
        {SCREENS.map((screen) => (
          <li key={screen.id}>
            <a href={`#/${screen.id}`}>{screen.label}</a> <code>{screen.id}</code>
          </li>
        ))}
        <li>
          <a href="#/_check">横スクロールの確認（全画面 × 1440 / 390 / 320）</a> <code>_check</code>
        </li>
      </ul>
    </main>
  );
}

const DESTS: ShellDest[] = ["exp", "niho", "site"];

/** 画面の中身。page: / new / newrec / sel: / sheet:publish / sheet:done は枠の画面（Screen）、それ以外はフェーズ2の画面。 */
function Body({ id, forced }: { id: string; forced: ScreenForced }) {
  const [name = "", arg = ""] = id.split(":");
  if (name === "login") return <LoginDemo />;
  if (name === "preview") return <PreviewDemo id={arg || "kita"} />;
  if (name === "dest") return <DestDemo forced={forced} />;
  if (name === "site") return <SiteDemo forced={forced} />;
  if (name === "account") return <AccountDemo forced={forced} />;
  if (name === "settings") return <SettingsDemo forced={forced} />;
  if (name === "settings-web") return <WebSettingsDemo forced={forced} />;
  if (name === "dest-web") return <WebDestDemo forced={forced} />;
  if (name === "site-web") return <WebSiteDemo forced={forced} />;
  if (name === "sheet" && arg === "addDest") return <DestDemo forced={forced} addDest />;
  return <Screen id={id} forced={forced} />;
}

function App() {
  const { hash, route, params } = useRoute();
  if (route === "" ) return <Index />;
  if (route === "split") return <SplitDemo windowControls={params.has("mac")} />;
  if (route === "_check") return <Check />;
  const id = route.startsWith("page:") || route.startsWith("preview:") || findScreen(route) ? route : "";
  if (!id) return <Index />;
  const pick = params.get("pick");
  const forced: ScreenForced = {
    sidebar: params.has("sidebar") ? params.get("sidebar") === "1" : undefined,
    rail: params.has("rail") ? params.get("rail") === "1" : undefined,
    pick: DESTS.find((dest) => dest === pick),
    conn: params.has("conn") ? params.get("conn") === "1" : undefined,
    page: params.get("page") ?? undefined,
    // 録音の文字起こし（話者の数・直している状態・時刻・再生）
    speakers: params.has("speakers") ? Number(params.get("speakers")) : undefined,
    edit: params.has("edit") ? params.get("edit") === "1" : undefined,
    time: params.has("time") ? params.get("time") === "1" : undefined,
    play: params.has("play") ? params.get("play") === "1" : undefined,
    playing: params.has("playing") ? params.get("playing") === "1" : undefined,
    web: params.get("web") === "1",
    note: params.get("note") === "1",
    // 設定（editor-web）の、開いている編集
    terms: params.get("terms") === "1",
    about: params.get("about") === "1",
    recipe: params.get("recipe") ?? undefined,
    // 発信先（editor-web）の、開いている下書き・確認・新しい鍵
    add: params.get("add") === "1",
    url: params.get("url") === "1",
    confirm: params.get("confirm") ?? undefined,
    issuedKey: params.get("key") === "1",
  };
  // 画面を替えたら状態を作り直す（モックの render と同じ）
  return (
    <div className="g-frame" data-docs-app-root data-docs-shared-ui>
      <Body key={hash} id={id} forced={forced} />
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
