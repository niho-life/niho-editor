import { useId } from "react";
import { ShellField } from "./settings-parts";

/**
 * 固有名詞・登場人物の一覧をまとめて直す部品（フォルダの欄 #37 と、ページの設定で使う）。
 * 設定（editor.niho.life/settings）の固有名詞は 2026-11-05 から 1 行ずつ直す表（editor-settings.tsx の EditorTermRows）に替えたが、
 * フォルダの欄はこの形のまま（名前と振る舞いは変えない）。
 */

/**
 * 編集している固有名詞の 1 行。`variants`（誤りやすい表記）は**打ったままの文字列**で、区切りの文字そのものも残る
 * （controlled な欄なので、ここで配列にして描き直すと「・」を打った瞬間に消えて続きが前の語に繋がる）。
 * 配列に分けるのは保存のとき（呼ぶ側。editor-web は docs-core の `parseVariants`）。
 */
export type EditorSettingsTermDraft = { term: string; reading: string; variants: string; note: string };

const STACK = { display: "grid", gap: 12 } as const;
const ROW = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 } as const;
const NOTE = { margin: 0, fontSize: 12.5, lineHeight: 1.6, color: "var(--ed-ink-sub)" } as const;
const CARD = { display: "grid", gap: 12, padding: "14px 16px", border: "1px solid var(--ed-line)", borderRadius: 16 } as const;
const EMPTY = { margin: 0, fontSize: 13, color: "var(--ed-ink-mute)" } as const;
const SUBHEAD = { fontSize: 13, fontWeight: 600 } as const;
/** 送っている間のボタン（disabled にするとフォーカスが外れるので、aria-disabled と見た目だけ）。 */
const BUSY = { opacity: 0.4, cursor: "progress" } as const;

export const SHELL_TERMS_TEXT = {
  empty: "まだありません",
  termsHelp: "AI の提案に、この表記のとおりに書くよう渡します。表記のない行は保存できません。",
} as const;

/**
 * 固有名詞と誤りやすい表記の編集。誤りやすい表記は 1 つの欄に「・」で並べて書く。
 * 設定（アカウント共通）とフォルダの欄（#37）で同じ部品を使う（`heading` で見出しの言葉だけを替える）。
 */
export function ShellTermsEditor({
  terms,
  max,
  busy,
  onChange,
  onCancel,
  onSave,
  heading = "固有名詞と誤りやすい表記",
  help = SHELL_TERMS_TEXT.termsHelp,
  name = "固有名詞",
}: {
  terms: EditorSettingsTermDraft[];
  max: number;
  busy: boolean;
  onChange: (next: EditorSettingsTermDraft[]) => void;
  onCancel: () => void;
  onSave: () => void;
  heading?: string;
  help?: string;
  /** ボタンのアクセシブル名に使う短い名前（「◯◯を保存」）。 */
  name?: string;
}) {
  const headingId = useId();
  const busyProps = busy ? { "aria-disabled": true as const, style: BUSY } : {};
  const at = (index: number, patch: Partial<EditorSettingsTermDraft>) => onChange(terms.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  return (
    <div style={STACK} role="group" aria-labelledby={headingId}>
      <h3 id={headingId} style={SUBHEAD}>
        {heading}
      </h3>
      <p style={NOTE}>{help}</p>
      {terms.length === 0 && <p style={EMPTY}>{SHELL_TERMS_TEXT.empty}</p>}
      {terms.map((entry, index) => (
        <div key={index} style={CARD}>
          <div className="es-form">
            <ShellField label={`${index + 1} 行目の表記`} value={entry.term} onChange={(term) => at(index, { term })} />
            <ShellField label={`${index + 1} 行目のよみ`} value={entry.reading} onChange={(reading) => at(index, { reading })} />
            {/* 打ったままの文字列を持つ（区切りを打った時点で配列にすると、続きが前の語に繋がる） */}
            <ShellField label={`${index + 1} 行目の誤りやすい表記（「・」で区切る）`} value={entry.variants} onChange={(variants) => at(index, { variants })} />
            <ShellField label={`${index + 1} 行目の補足`} value={entry.note} onChange={(note) => at(index, { note })} />
          </div>
          <div style={ROW}>
            <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label={`この行を削除（${index + 1} 行目）`} onClick={() => onChange(terms.filter((_, i) => i !== index))}>
              この行を削除
            </button>
          </div>
        </div>
      ))}
      <div style={ROW}>
        {terms.length < max && (
          <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={() => onChange([...terms, { term: "", reading: "", variants: "", note: "" }])}>
            行を追加
          </button>
        )}
        <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label={`${name}の編集をやめる`} onClick={onCancel}>
          やめる
        </button>
        <button type="button" className="es-btn es-btn--primary es-btn--sm" aria-label={`${name}を保存`} {...busyProps} onClick={() => !busy && onSave()}>
          保存
        </button>
      </div>
    </div>
  );
}

/** 登場人物の 1 行（フォルダの欄。#37）。固有名詞と違って区切りの欄が無いので、打ったままの文字列は持たない。 */
export type EditorSettingsEntityDraft = { name: string; reading: string; role: string; note: string };

/** 登場人物の編集（フォルダの欄。名前・よみ・役割・補足）。固有名詞の編集（`ShellTermsEditor`）と同じ形。 */
export function ShellEntitiesEditor({
  entities,
  max,
  busy,
  onChange,
  onCancel,
  onSave,
  heading = "登場人物",
  help = "録音に出てくる人を書いておくと、文字起こしと AI の提案で名前の表記が揃います。",
}: {
  entities: EditorSettingsEntityDraft[];
  max: number;
  busy: boolean;
  onChange: (next: EditorSettingsEntityDraft[]) => void;
  onCancel: () => void;
  onSave: () => void;
  heading?: string;
  help?: string;
}) {
  const headingId = useId();
  const busyProps = busy ? { "aria-disabled": true as const, style: BUSY } : {};
  const at = (index: number, patch: Partial<EditorSettingsEntityDraft>) => onChange(entities.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  return (
    <div style={STACK} role="group" aria-labelledby={headingId}>
      <h3 id={headingId} style={SUBHEAD}>
        {heading}
      </h3>
      <p style={NOTE}>{help}</p>
      {entities.length === 0 && <p style={EMPTY}>{SHELL_TERMS_TEXT.empty}</p>}
      {entities.map((entry, index) => (
        <div key={index} style={CARD}>
          <div className="es-form">
            <ShellField label={`${index + 1} 行目の名前`} value={entry.name} onChange={(name) => at(index, { name })} />
            <ShellField label={`${index + 1} 行目のよみ`} value={entry.reading} onChange={(reading) => at(index, { reading })} />
            <ShellField label={`${index + 1} 行目の役割`} value={entry.role} onChange={(role) => at(index, { role })} />
            <ShellField label={`${index + 1} 行目の補足`} value={entry.note} onChange={(note) => at(index, { note })} />
          </div>
          <div style={ROW}>
            <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label={`この行を削除（${index + 1} 行目）`} onClick={() => onChange(entities.filter((_, i) => i !== index))}>
              この行を削除
            </button>
          </div>
        </div>
      ))}
      <div style={ROW}>
        {entities.length < max && (
          <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={() => onChange([...entities, { name: "", reading: "", role: "", note: "" }])}>
            行を追加
          </button>
        )}
        <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label={`${heading}の編集をやめる`} onClick={onCancel}>
          やめる
        </button>
        <button type="button" className="es-btn es-btn--primary es-btn--sm" aria-label={`${heading}を保存`} {...busyProps} onClick={() => !busy && onSave()}>
          保存
        </button>
      </div>
    </div>
  );
}
