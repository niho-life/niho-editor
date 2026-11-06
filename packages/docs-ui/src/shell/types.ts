/*
 * editor の枠（shell）の表示用の型。モック v6（#48）の画面状態を props で描くための形だけを持つ。
 * 保存・通信・DocsHost は持たない（状態は呼ぶ側が持つ）。
 */

/** 公開先。exp＝NIHO Experience、niho＝NIHO、site＝本人のサイト。 */
export type ShellDest = "exp" | "niho" | "site";
export type ShellLang = "ja" | "en";
/** ページの種類。step は録音から作った手順のサブページ、folder は本文を持たない入れ物。 */
export type ShellPageKind = "note" | "rec" | "step" | "article" | "folder";
/** 状態の丸。private＝自分だけ、published＝公開中、updated＝更新あり、limited＝限定公開、stopped＝公開をやめた。 */
export type ShellStatusState = "private" | "published" | "updated" | "limited" | "stopped";
/** 段階の状態。done＝済み、run＝作成中、wait＝待機、failed＝失敗、stale＝前提変更（上流が変わった）。設計 §7.2。 */
export type ShellStepState = "done" | "run" | "wait" | "failed" | "stale";
/** 主ボタンは面と文字をセット（--ed-primary-bg / --ed-primary-ink）。outline は白地の縁、quiet は面なし。 */
export type ShellButtonTone = "primary" | "outline" | "quiet";

export type ShellMenuItem = {
  id: string;
  label: string;
  icon?: ShellIconName;
  /** 右に小さく添える補足（例: 文字起こし）。 */
  hint?: string;
  /** 右の数のバッジ（例: 未処理の招待）。 */
  badge?: string;
  danger?: boolean;
  /** 押せない項目（aria-disabled。消さずに出して、押せない理由を hint に書く）。 */
  disabled?: boolean;
  /** いま開いているページ（設定系のページでメニューに現在地を示す）。 */
  current?: boolean;
  /** 切り替えの項目の今の値（あれば `menuitemcheckbox` で、ON のとき右に ✓）。 */
  checked?: boolean;
  /** この項目の前に区切りの線を引く。 */
  separated?: boolean;
};

/**
 * 一覧の1行。2行目（sub）は公開先・録音・作成中のときだけ持つ。
 * 木は `depth` の並びで表す（深い行は、直前の浅い行の中に入る）。段はフォルダ（0）› ページ（1）› 録音のサブページ（2）まで。
 */
export type ShellListItem = {
  id: string;
  /** 空なら「無題」と薄く出す。 */
  title: string;
  /** 更新の時刻（「たった今」「昨日」「10月24日」）。 */
  when: string;
  /** 木の段。省けば 0（上の段）。 */
  depth?: 0 | 1 | 2;
  /** フォルダの行（`kind = 'folder'`。子が無くても）。開閉のボタンを出す（子が無ければ幅だけ取って押せない）。 */
  folder?: boolean;
  /** 中身の無いフォルダ（`folder` のときだけ見る）。開閉は押せず、幅だけ取る。 */
  empty?: boolean;
  /** 題名の前の小さなアイコン（フォルダ・録音・工程のサブページ）。 */
  icon?: "folder" | "mic" | "spark";
  /** フォルダを開いているか（`folder` のときだけ見る。閉じているあいだ、呼ぶ側は中の行を渡さない）。 */
  open?: boolean;
  /** 手順が動いている行の回るマーク（設計 §7.2）。印だけでは状態を表さないので、sub の文字（「作成中…」）と一緒に渡す。 */
  busy?: boolean;
  sub?: { text: string; dest?: ShellDest };
};

export type ShellPublication = {
  dest: ShellDest;
  range: "live" | "unlisted" | "stopped";
  /** 公開したあとに直した内容があり、まだ読者に出ていない。 */
  updated?: boolean;
  /** 公開先の URL（host/path/slug）。 */
  url: string;
};

export type ShellIconName =
  | "plus"
  | "chev"
  | "down"
  | "copy"
  | "reset"
  | "search"
  | "panel"
  | "side"
  | "more"
  | "lock"
  | "globe"
  | "mic"
  | "spark"
  | "img"
  | "folder"
  | "list"
  | "link"
  | "eye"
  | "back"
  | "ext"
  | "ship"
  | "people"
  | "gear"
  | "play"
  | "pause"
  | "doc"
  | "cal"
  | "type"
  | "h"
  | "minus"
  | "up"
  | "pin"
  | "phone"
  | "mail"
  | "check"
  | "edit"
  | "trash"
  | "info"
  | "grip"
  | "swap"
  | "x"
  | "float"
  | "caret-up"
  | "caret-down";
