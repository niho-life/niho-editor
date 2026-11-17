import { useRef, useState, type ReactNode } from "react";
import { Icon } from "../shell/icons";
import { ShellMenu } from "../shell/menu";
import type { ShellButtonTone, ShellMenuItem } from "../shell/types";

/**
 * 「手順」のカード（文書生成。#309 の「流れ」を #344 でカードにした。モック editor-page-refine-v1 の「録音から作ったページ」と
 * 「書いたページ」の AI の ＋ →「記事制作」）。Tauri-free: 通信・ルーターは持たず、行の内容と押したときの口（props）だけ。
 *
 * - 見出し「<手順名> ▾ · <フォルダ名>」（▾ でフォルダの手順を替える。フォルダの外ならフォルダ名は出さない）。
 * - 行: 開いているページが流れの中（どれかの行が current）なら 録音 › 文字起こし › 段階…。流れの外（直接書いたページ）なら、
 *   先頭に「このページ」（いま）を置き、その後ろに段階だけを並べる（録音・文字起こしは出さない）。
 * - 印: 入れ物があり今でない行は ✓（済み。押すとそのページを開く）、今の行は ●、これからの行は ○ と番号（出している並びでの順番）。
 *   作成中は回る印。読み上げには「済み」「いま開いているページ」「これから」を添える（見える印に頼らない）。
 * - 作成のボタンは 1 つ（緑の主ボタン）: 目標の段階まで作る（既定は作れるいちばん後の段階）。作れる段階の行は押せて
 *   （aria-pressed）、押すとそこが目標になり「ここまで」の札が付く。録音のタブを開いていて文字起こしのエンジンがあれば、
 *   ボタンは「文字起こしを作る ▾」（エンジンのメニュー。その録音で使ったエンジンは済み）。作れる段階が無ければボタンは出さない。
 * - フォルダの外では、ボタンの下に「作ったページは、このページと一緒に新しいフォルダにまとまります。」。
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
  /** go は今のタブを入力にこの段階まで作れる、done は今のタブから作ったタブがこの段階にある。 */
  action: "go" | "done" | null;
  /** 文字起こしの行で、録音のタブか文字起こしのタブを開いているときのエンジン。 */
  engines?: { id: string; label: string; used: boolean }[];
};

export type PageFlowAction = { id: string; label: string; tone?: ShellButtonTone; busy?: boolean };

export type PageFlowProps = {
  recipe: { id: string; name: string };
  /** ▾ の候補（その人の手順。使えないものは理由つきで押せない）。 */
  recipes: readonly { id: string; name: string; unusableReason?: string | null }[];
  /** 入っているフォルダ。無ければ、作成のボタンの下に「新しいフォルダにまとまります」の一言。 */
  folder: { id: string; title: string } | null;
  rows: readonly PageFlowRow[];
  /** 送っている間（作成・取消などのボタンを押せない）。 */
  busy: boolean;
  /** 一言（いま何が起きているか。role=status）。 */
  note: string | null;
  /** 最新の run にできること（やめる・やり直す・設定を見る）。 */
  actions?: readonly PageFlowAction[];
  onAction?: (id: string) => void;
  /** ✓ の行（入れ物）を押した。そのページ（最後に見たタブ）を開く。 */
  onOpen: (holderId: string) => void;
  /** 作成のボタン（目標の段階の行を渡す）。 */
  onMake: (row: PageFlowRow) => void;
  /** 「文字起こしを作る ▾」でエンジンを選んだ。 */
  onTranscribe: (engine: string) => void;
  onChangeRecipe: (recipeId: string) => void;
  /** 行の下に出すもの（失敗の途中出力・手順の版の知らせ）。 */
  children?: ReactNode;
};

export const PAGE_FLOW_TEXT = {
  /** カード（section）の名前。パネルの名前と同じ。 */
  card: "手順",
  rows: "段階",
  recipeMenu: "このフォルダの手順",
  recipeButton: (name: string) => `手順: ${name}。替える`,
  /** 流れの外のページで、先頭に置く行。 */
  self: "このページ",
  /** 読み上げに添える言葉（見える印は ✓・●・○）。 */
  state: { done: "済み", cur: "いま開いているページ", todo: "これから" },
  now: "いま見ている",
  goal: "ここまで",
  makeTo: (name: string) => `${name}まで作る`,
  /** 目標までに作る段階が 2 つ以上のとき、作成のボタンに添える。 */
  count: (count: number) => `（${count} 段階）`,
  transcribe: "文字起こしを作る",
  pickHint: "段階を押すと、そこで止められます",
  outside: "作ったページは、このページと一緒に新しいフォルダにまとまります。",
  engineMenu: "エンジンを選ぶ · 「文字起こし」のタブになります",
  engineUsed: "済み",
  from: (name: string) => `${name} から`,
  status: { done: "済み", run: "作成中…", wait: "待機", stale: "前提変更", failed: "失敗" } as Record<PageFlowStatus, string>,
  open: (name: string) => `${name}を開く`,
} as const;

/** 流れの外のページで先頭に置く「このページ」の行の key。 */
export const PAGE_FLOW_SELF_KEY = "self";

type RowState = keyof typeof PAGE_FLOW_TEXT.state;

/** タブの札の列（タブが 2 つ以上のときだけ札を出す。状態の言葉は 1 つでも出す）。 */
function tabsText(tabs: readonly PageFlowTab[]): string {
  const labelled = tabs.length > 1;
  const words = tabs.map((tab) => {
    const status = tab.running ? PAGE_FLOW_TEXT.status.run : tab.status && tab.status !== "done" ? PAGE_FLOW_TEXT.status[tab.status] : "";
    return [labelled ? tab.label : "", status].filter(Boolean).join(" ");
  }).filter(Boolean);
  return words.join(" · ");
}

/** 出す行。流れの外（どの行も今でない）なら「このページ」＋段階だけ。 */
function shownRows(rows: readonly PageFlowRow[]): readonly PageFlowRow[] {
  if (rows.some((row) => row.current)) return rows;
  const self: PageFlowRow = { key: PAGE_FLOW_SELF_KEY, kind: "step", name: PAGE_FLOW_TEXT.self, holder: null, tabs: [], current: true, from: null, action: null };
  return [self, ...rows.filter((row) => row.kind === "step")];
}

export function PageFlow({ recipe, recipes, folder, rows, busy, note, actions = [], onAction, onOpen, onMake, onTranscribe, onChangeRecipe, children }: PageFlowProps) {
  const [menu, setMenu] = useState<"recipe" | "engines" | null>(null);
  // 押して選んだ目標の段階（key）。選んでいなければ、作れるいちばん後の段階
  const [chosen, setChosen] = useState<string | null>(null);
  const recipeButton = useRef<HTMLButtonElement | null>(null);
  const engineButton = useRef<HTMLButtonElement | null>(null);
  const recipeItems: ShellMenuItem[] = recipes.map((item) => ({
    id: item.id,
    label: item.name,
    ...(item.id === recipe.id ? { current: true, hint: "今の手順", disabled: true } : item.unusableReason ? { disabled: true, hint: item.unusableReason } : {}),
  }));
  const shown = shownRows(rows);
  // 録音のタブを開いていて、文字起こしのエンジンがある: 作成のボタンは「文字起こしを作る ▾」（段階は録音のタブからは作らない）
  const transcript = rows.find((row) => row.kind === "transcript" && row.engines && row.engines.length > 0);
  const engineMode = transcript !== undefined && rows.some((row) => row.kind === "rec" && row.current);
  const engineItems: ShellMenuItem[] = (transcript?.engines ?? []).map((engine) => ({
    id: engine.id,
    label: engine.label,
    ...(engine.used ? { disabled: true, hint: PAGE_FLOW_TEXT.engineUsed } : {}),
  }));
  // 目標にできる段階（今のタブを入力に作れる段階）と、目標
  const pickable = engineMode ? [] : shown.filter((row) => row.kind === "step" && row.action === "go");
  const target = pickable.find((row) => row.key === chosen) ?? pickable.at(-1) ?? null;
  // 目標までに作る段階の数（今のタブの次の段階から目標まで。作成済みの段階も新しいタブで作り直す）
  const making = shown.filter((row) => row.kind === "step" && row.action !== null);
  const count = target ? making.indexOf(target) + 1 : 0;
  const targetIndex = target ? shown.indexOf(target) : -1;
  const hasButton = engineMode || target !== null;

  return (
    <section className="es-flow" aria-label={PAGE_FLOW_TEXT.card} tabIndex={-1}>
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
        {folder && <span className="es-flow-folder">· {folder.title || "無題"}</span>}
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
      <ol className="es-flow-rows" aria-label={PAGE_FLOW_TEXT.rows}>
        {shown.map((row, index) => {
          const canPick = pickable.includes(row);
          const state: RowState = row.current ? "cur" : !canPick && row.holder ? "done" : "todo";
          const running = row.tabs.some((tab) => tab.running);
          const isTarget = row === target;
          const after = canPick && targetIndex >= 0 && index > targetIndex;
          const tabs = state === "todo" ? "" : tabsText(row.tabs);
          const mark = running ? <i className="es-busy" /> : state === "done" ? <Icon name="check" /> : state === "cur" ? null : index + 1;
          const inner = (
            <>
              <span className="es-flow-dot" aria-hidden="true">{mark}</span>
              <span className="es-flow-nm">
                {row.name}
                <span className="es-vh">（{PAGE_FLOW_TEXT.state[state]}）</span>
              </span>
              {isTarget ? (
                <span className="es-flow-tag">{PAGE_FLOW_TEXT.goal}</span>
              ) : tabs ? (
                <small>{tabs}</small>
              ) : state === "cur" ? (
                <span className="es-flow-tag es-flow-tag--now" aria-hidden="true">{PAGE_FLOW_TEXT.now}</span>
              ) : null}
              {row.current && row.from && <em className="es-flow-src">{PAGE_FLOW_TEXT.from(row.from)}</em>}
            </>
          );
          return (
            <li key={row.key} className={`es-flow-row es-flow-row--${state}${after ? " es-flow-row--after" : ""}`}>
              {canPick ? (
                <button type="button" className="es-flow-go" aria-pressed={isTarget} onClick={() => setChosen(row.key)}>
                  {inner}
                </button>
              ) : state === "done" ? (
                <button type="button" className="es-flow-go" title={PAGE_FLOW_TEXT.open(row.name)} onClick={() => onOpen(row.holder!.id)}>
                  {inner}
                </button>
              ) : (
                <div className="es-flow-go" aria-current={state === "cur" ? "page" : undefined}>
                  {inner}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {hasButton && (
        <div className="es-flow-mk">
          {engineMode ? (
            <button
              ref={engineButton}
              type="button"
              className={`es-btn es-btn--primary es-flow-make${busy ? " es-btn--busy" : ""}`}
              aria-haspopup="menu"
              aria-expanded={menu === "engines"}
              aria-disabled={busy || undefined}
              onClick={() => !busy && setMenu(menu === "engines" ? null : "engines")}
            >
              {busy && <i className="es-busy" aria-hidden="true" />}
              {PAGE_FLOW_TEXT.transcribe}
              <Icon name="down" />
            </button>
          ) : (
            <button
              type="button"
              className={`es-btn es-btn--primary es-flow-make${busy ? " es-btn--busy" : ""}`}
              aria-disabled={busy || undefined}
              onClick={() => !busy && target && onMake(target)}
            >
              {busy && <i className="es-busy" aria-hidden="true" />}
              {PAGE_FLOW_TEXT.makeTo(target!.name)}
              {count > 1 && <span className="es-flow-count">{PAGE_FLOW_TEXT.count(count)}</span>}
            </button>
          )}
          {pickable.length > 1 && <p>{PAGE_FLOW_TEXT.pickHint}</p>}
          {!folder && <p>{PAGE_FLOW_TEXT.outside}</p>}
        </div>
      )}
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
