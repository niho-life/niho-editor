import { useRef, useState, type ReactNode } from "react";
import { Icon } from "../shell/icons";
import { ShellMenu } from "../shell/menu";
import type { ShellButtonTone, ShellMenuItem } from "../shell/types";

/**
 * 「ページ」パネルの「流れ」（#309。モック editor-folder-pages-v1 の「流れ」）。Tauri-free: 通信・ルーターは持たず、
 * 行の内容と押したときの口（props）だけ。
 *
 * 見出し「<手順名> ▾ · <フォルダ名>」（▾ でフォルダの手順を替える）。行は 録音 › 文字起こし › 段階…（手順の全段階）。
 * ある入れ物は名前とタブの札、無い段階は「（まだ）」。今のページは強調し「◯◯ から」（何から作られたか）を添える。
 * 各行の右端に **作成**／**済み**（今のページより前の段階には出ない。録音の行には無い）。文字起こしの行はエンジンのメニュー
 * （この録音で使ったエンジンは済み）。作成中は回る印。状態は色だけで表さない（済み・作成中・失敗・前提変更は文字でも出す）。
 */
export type PageFlowStatus = "done" | "run" | "wait" | "stale" | "failed";

export type PageFlowTab = {
  id: string;
  /** タブの札（名前か番号。1 つだけのときは空でよい）。 */
  label: string;
  status: PageFlowStatus | null;
  /** 最新の run で待ち・実行中。 */
  running: boolean;
};

export type PageFlowRow = {
  key: string;
  kind: "rec" | "transcript" | "step";
  name: string;
  holder: { id: string; title: string } | null;
  tabs: PageFlowTab[];
  /** 今開いているタブの行。 */
  current: boolean;
  /** 今の行だけ: 「◯◯ から」の ◯◯。 */
  from: string | null;
  action: "go" | "done" | null;
  /** 文字起こしの行で、録音のタブを開いているときのエンジン。 */
  engines?: { id: string; label: string; used: boolean }[];
};

export type PageFlowAction = { id: string; label: string; tone?: ShellButtonTone; busy?: boolean };

export type PageFlowProps = {
  recipe: { id: string; name: string };
  /** ▾ の候補（その人の手順。使えないものは理由つきで押せない）。 */
  recipes: readonly { id: string; name: string; unusableReason?: string | null }[];
  /** 入っているフォルダ。無ければ「フォルダの外」の一言。 */
  folder: { id: string; title: string } | null;
  rows: readonly PageFlowRow[];
  /** 送っている間（作成・取消などのボタンを押せない）。 */
  busy: boolean;
  /** 一言（いま何が起きているか。role=status）。 */
  note: string | null;
  /** 最新の run にできること（やめる・やり直す・設定を見る）。 */
  actions?: readonly PageFlowAction[];
  onAction?: (id: string) => void;
  /** 行（入れ物）を押した。そのページ（最後に見たタブ）を開く。 */
  onOpen: (holderId: string) => void;
  /** 段階の「作成」。 */
  onMake: (row: PageFlowRow) => void;
  /** 文字起こしの「作成 ▾」でエンジンを選んだ。 */
  onTranscribe: (engine: string) => void;
  onChangeRecipe: (recipeId: string) => void;
  /** 行の下に出すもの（失敗の途中出力・手順の版の知らせ）。 */
  children?: ReactNode;
};

export const PAGE_FLOW_TEXT = {
  list: "流れ",
  recipeMenu: "このフォルダの手順",
  recipeButton: (name: string) => `手順: ${name}。替える`,
  outside: "（フォルダの外。作成するとフォルダに入ります）",
  none: "（まだ）",
  make: "作成",
  makeLabel: (name: string) => `${name}を作成`,
  done: "済み",
  doneLabel: (name: string) => `${name}は作成済み`,
  engineMenu: "エンジンを選ぶ · 「文字起こし」のタブになります",
  engineUsed: "済み",
  from: (name: string) => `${name} から`,
  status: { done: "済み", run: "作成中…", wait: "待機", stale: "前提変更", failed: "失敗" } as Record<PageFlowStatus, string>,
  open: (name: string) => `${name}を開く`,
} as const;

const ROW_ICON = { rec: "mic", transcript: "list", step: "spark" } as const;

/** タブの札の列（タブが 2 つ以上のときだけ札を出す。状態の言葉は 1 つでも出す）。 */
function tabsText(tabs: readonly PageFlowTab[]): string {
  const labelled = tabs.length > 1;
  const words = tabs.map((tab) => {
    const status = tab.running ? PAGE_FLOW_TEXT.status.run : tab.status && tab.status !== "done" ? PAGE_FLOW_TEXT.status[tab.status] : "";
    return [labelled ? tab.label : "", status].filter(Boolean).join(" ");
  }).filter(Boolean);
  return words.join(" · ");
}

export function PageFlow({ recipe, recipes, folder, rows, busy, note, actions = [], onAction, onOpen, onMake, onTranscribe, onChangeRecipe, children }: PageFlowProps) {
  const [menu, setMenu] = useState<"recipe" | "engines" | null>(null);
  const recipeButton = useRef<HTMLButtonElement | null>(null);
  const engineButton = useRef<HTMLButtonElement | null>(null);
  const recipeItems: ShellMenuItem[] = recipes.map((item) => ({
    id: item.id,
    label: item.name,
    ...(item.id === recipe.id ? { current: true, hint: "今の手順", disabled: true } : item.unusableReason ? { disabled: true, hint: item.unusableReason } : {}),
  }));
  const transcript = rows.find((row) => row.kind === "transcript" && row.engines && row.engines.length > 0);
  const engineItems: ShellMenuItem[] = (transcript?.engines ?? []).map((engine) => ({
    id: engine.id,
    label: engine.label,
    ...(engine.used ? { disabled: true, hint: PAGE_FLOW_TEXT.engineUsed } : {}),
  }));
  return (
    <section className="es-flow" aria-label={PAGE_FLOW_TEXT.list}>
      <h3 className="es-flow-hd">
        <button
          ref={recipeButton}
          type="button"
          className="es-flow-recipe"
          aria-label={PAGE_FLOW_TEXT.recipeButton(recipe.name)}
          aria-haspopup="menu"
          aria-expanded={menu === "recipe"}
          onClick={() => setMenu(menu === "recipe" ? null : "recipe")}
        >
          <Icon name="spark" />
          <span>{recipe.name}</span>
          <Icon name="down" />
        </button>
        <span className="es-flow-folder">· {folder ? folder.title || "無題" : PAGE_FLOW_TEXT.outside}</span>
      </h3>
      {menu === "recipe" && (
        <ShellMenu
          label={PAGE_FLOW_TEXT.recipeMenu}
          heading={PAGE_FLOW_TEXT.recipeMenu}
          className="es-menu--flow"
          items={recipeItems}
          trigger={recipeButton}
          onSelect={(id) => {
            setMenu(null);
            onChangeRecipe(id);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      <ol className="es-flow-rows" aria-label={PAGE_FLOW_TEXT.list}>
        {rows.map((row) => {
          const running = row.tabs.some((tab) => tab.running);
          const icon = running ? <i className="es-busy" aria-hidden="true" /> : <Icon name={row.holder ? "check" : ROW_ICON[row.kind]} className={row.holder ? "es-flow-ico es-flow-ico--on" : "es-flow-ico"} />;
          const tabs = row.holder ? tabsText(row.tabs) : "";
          return (
            <li key={row.key} className={`es-flow-row${row.current ? " es-flow-row--cur" : ""}${row.holder ? "" : " es-flow-row--none"}`}>
              {row.holder ? (
                <button
                  type="button"
                  className="es-flow-go"
                  aria-label={PAGE_FLOW_TEXT.open(row.name)}
                  aria-current={row.current ? "page" : undefined}
                  onClick={() => onOpen(row.holder!.id)}
                >
                  {icon}
                  <span>{row.name}</span>
                  {tabs && <small>{tabs}</small>}
                  {row.current && row.from && <em className="es-flow-src">{PAGE_FLOW_TEXT.from(row.from)}</em>}
                </button>
              ) : (
                <span className="es-flow-go">
                  {icon}
                  <span>{row.name}{PAGE_FLOW_TEXT.none}</span>
                </span>
              )}
              {row.kind === "transcript" && row.engines && row.engines.length > 0 && (
                <button
                  ref={engineButton}
                  type="button"
                  className="es-flow-mk"
                  aria-label={PAGE_FLOW_TEXT.makeLabel(row.name)}
                  aria-haspopup="menu"
                  aria-expanded={menu === "engines"}
                  aria-disabled={busy || undefined}
                  onClick={() => !busy && setMenu(menu === "engines" ? null : "engines")}
                >
                  <Icon name="plus" />
                  {PAGE_FLOW_TEXT.make}
                  <Icon name="down" />
                </button>
              )}
              {row.kind === "step" && row.action === "go" && (
                <button type="button" className="es-flow-mk" aria-label={PAGE_FLOW_TEXT.makeLabel(row.name)} aria-disabled={busy || undefined} onClick={() => !busy && onMake(row)}>
                  <Icon name="plus" />
                  {PAGE_FLOW_TEXT.make}
                </button>
              )}
              {row.kind === "step" && row.action === "done" && (
                <button type="button" className="es-flow-mk" aria-label={PAGE_FLOW_TEXT.doneLabel(row.name)} aria-disabled="true" disabled>
                  <Icon name="check" />
                  {PAGE_FLOW_TEXT.done}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {menu === "engines" && (
        <ShellMenu
          label={PAGE_FLOW_TEXT.engineMenu}
          heading={PAGE_FLOW_TEXT.engineMenu}
          className="es-menu--flow"
          items={engineItems}
          trigger={engineButton}
          onSelect={(id) => {
            setMenu(null);
            onTranscribe(id);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      <p className="es-flow-note" role="status">{note ?? ""}</p>
      {actions.length > 0 && (
        <div className="es-flow-actions">
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={`es-btn es-btn--${action.tone ?? "outline"} es-btn--sm${action.busy ? " es-btn--busy" : ""}`}
              aria-disabled={action.busy || busy || undefined}
              onClick={() => !action.busy && !busy && onAction?.(action.id)}
            >
              {action.busy && <i className="es-busy" aria-hidden="true" />}
              {action.label}
            </button>
          ))}
        </div>
      )}
      {children}
    </section>
  );
}
