import { useId } from "react";
import { Icon } from "./icons";
import { ShellField, ShellKv, ShellKvs, ShellPills, ShellSection, ShellSettingsPage } from "./settings-parts";

/**
 * editor.niho.life の設定（Issue #108。モック v6 の V.settings を、Web で本当に出せる項目に合わせたもの）。
 * props 駆動の表示部品で、通信・保存・下書きの持ち方は呼ぶ側（apps/editor-web の SettingsView）が持つ。
 *
 * 変えられるのは AI の提案の言語・固有名詞・手順の 3 つ。文字起こしのエンジンと保存先はサーバー側が決めるので
 * 読むだけで、ここでは変えられない理由を一言添える（設計 §2.1・§12）。
 * 固有名詞と手順の編集は、この画面の中で開く（別のシートにしない。狭い画面でも並びが同じで、戻る先が画面のまま）。
 *
 * モック v6 のプロフィールの節は持たない（NIHO アカウントの値で、editor では変えられない。役割とつながりは #42）。
 */

export const EDITOR_SETTINGS_NAV = [
  { id: "es-s-ai", label: "AI" },
  { id: "es-s-steps", label: "手順" },
  { id: "es-s-tr", label: "文字起こし" },
  { id: "es-s-save", label: "保存" },
];

export type EditorSettingsAiLang = "same" | "ja" | "en";

/** 文字起こしの方式。`fake` は開発・CI の偽物、`off` は使わない設定。 */
export type EditorSettingsEngine = "deepgram" | "fake" | "gemini" | "off";

/** 保存先（`DocsStorageMode`。`UNSET` は未選択＝クラウドと同じ扱い）。 */
export type EditorSettingsStorage = "UNSET" | "CLOUD" | "CLOSING" | "LOCAL";

export type EditorSettingsTerm = { term: string; reading: string; variants: string[]; note: string };

/**
 * 編集している固有名詞の 1 行。`variants`（誤りやすい表記）は**打ったままの文字列**で、区切りの文字そのものも残る
 * （controlled な欄なので、ここで配列にして描き直すと「・」を打った瞬間に消えて続きが前の語に繋がる）。
 * 配列に分けるのは保存のとき（呼ぶ側。editor-web は docs-core の `parseVariants`）。
 */
export type EditorSettingsTermDraft = { term: string; reading: string; variants: string; note: string };
export type EditorSettingsStep = { id: string; name: string; instruction: string };

export type EditorSettingsRecipe = {
  id: string;
  name: string;
  /** お手本（全部の段階に渡す文書ガイド）。 */
  guide: string;
  steps: EditorSettingsStep[];
  /** 既定の 3 つのどれか。 */
  isDefault: boolean;
  /** 既定に手を入れている（既定に戻せる）。 */
  modified: boolean;
};

export type EditorSettingsUsage = {
  /** Asia/Tokyo の年月（`2026-10`）。 */
  month: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  limitUsd: number | null;
  nearLimit: boolean;
};

export type EditorSettingsTranscription = {
  engine: EditorSettingsEngine;
  /** 1 回の文字起こしの時間切れ（秒）。使わない設定なら null。 */
  timeoutSec: number | null;
  maxBytes: number;
  maxDurationSec: number;
  retentionDays: number;
  extensions: string[];
};

export type EditorSettingsPageProps = {
  /** 保存の状態の一言（`role="status"` で読み上げる。空なら何も言わない）。 */
  status: string;
  /** 送っている間（ボタンは押せない見た目にし、押しても何も起きない）。 */
  busy: boolean;

  aiLang: EditorSettingsAiLang;
  onAiLang: (lang: EditorSettingsAiLang) => void;

  glossary: EditorSettingsTerm[];
  /** 編集している行（null のときは、まとめと「編集」だけを出す）。 */
  termsDraft: EditorSettingsTermDraft[] | null;
  onEditTerms: () => void;
  onTermsDraft: (terms: EditorSettingsTermDraft[]) => void;
  onCancelTerms: () => void;
  onSaveTerms: () => void;

  /** 「あなたについて」（AI に毎回渡す、本人の説明と書き方の希望）。 */
  about: string;
  /** 編集している文（null のときは、まとめと「編集」だけを出す）。 */
  aboutDraft: string | null;
  onEditAbout: () => void;
  onAboutDraft: (about: string) => void;
  onCancelAbout: () => void;
  onSaveAbout: () => void;

  /** 効いている手順（既定の並び → 足したものの並び）。 */
  recipes: EditorSettingsRecipe[];
  /** 編集している手順（null のときは一覧だけ）。 */
  recipeDraft: EditorSettingsRecipe | null;
  onEditRecipe: (id: string) => void;
  onRecipeDraft: (recipe: EditorSettingsRecipe) => void;
  onCancelRecipe: () => void;
  onSaveRecipe: () => void;
  onDuplicateRecipe: (id: string) => void;
  /** 既定の手順を既定に戻す。 */
  onResetRecipe: (id: string) => void;
  /** 足した手順を消す。 */
  onRemoveRecipe: (id: string) => void;
  onAddRecipe: () => void;
  /** 段階の id を作る（足した手順の「段階を追加」。呼ぶ側が乱数を持つ）。 */
  newStepId: () => string;

  /** 読めなかったときは null（`usageNote` に理由の一言）。 */
  usage: EditorSettingsUsage | null;
  usageNote: string | null;

  transcription: EditorSettingsTranscription;
  storage: EditorSettingsStorage;

  limits: { glossary: number; recipes: number; steps: number; aboutChars: number };
};

const STACK = { display: "grid", gap: 12 } as const;
const ROW = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 } as const;
const NOTE = { margin: 0, fontSize: 12.5, lineHeight: 1.6, color: "var(--ed-ink-sub)" } as const;
const STATUS = { margin: 0, minHeight: 18, fontSize: 12.5, fontWeight: 600, color: "var(--ed-ink-sub)" } as const;
const CARD = { display: "grid", gap: 12, padding: "14px 16px", border: "1px solid var(--ed-line)", borderRadius: 16 } as const;
const EMPTY = { margin: 0, fontSize: 13, color: "var(--ed-ink-mute)" } as const;
const SUBHEAD = { fontSize: 13, fontWeight: 600 } as const;
/** 送っている間のボタン（disabled にするとフォーカスが外れるので、aria-disabled と見た目だけ）。 */
const BUSY = { opacity: 0.4, cursor: "progress" } as const;

export const EDITOR_SETTINGS_TEXT = {
  aiLang: { same: "書いた言語のまま", ja: "日本語", en: "English" },
  engine: { deepgram: "Deepgram", fake: "偽物（開発・CI）", gemini: "Gemini", off: "使わない" },
  storage: { UNSET: "NIHO クラウド（未選択）", CLOUD: "NIHO クラウド", CLOSING: "クラウドから移行中", LOCAL: "この Mac だけ" },
  empty: "まだありません",
  loading: "読み込んでいます…",
  engineFixed: "エンジンはサーバーの設定で決まります（Web からは選べません）",
  engineOff: "いまは文字起こしを使えません",
  engineFake: "開発と CI の偽物です（本番では使いません）",
  geminiLater: "Gemini は、長い音声の区切りをサーバー側に持っていないので、まだ選べません",
  overLimitSize: "超えるものは保存の前に断ります",
  storageFixed:
    "保存先は Mac アプリの設定で選びます（ブラウザの保存領域は消えることがあるので、Web からは「この Mac だけ」を選べません）。クラウド以外では、公開・リンクで共有・サーバーへの保存ができません。",
  nearLimit: "今月の上限に近づいています。上限に届くと、月が替わるまで AI の提案を使えません",
  overLimit: "今月の上限に届いたので、月が替わるまで AI の提案を使えません",
  termsHelp: "AI の提案に、この表記のとおりに書くよう渡します。表記のない行は保存できません。",
  aboutHelp:
    "AI に毎回渡す、あなたの説明と書き方の希望です（どんな人か・何を書いているか・言い回しの好み）。公開のときに出る著者の情報とは別のもので、ここに書いたことは公開されません。",
  fixedSteps: "既定の手順は、段階の数を変えられません（できあがったページがその段階に結んでいます）。段階を足すには、複製してから編集してください。",
} as const;

/** 容量（上限は GB の切りのよい値）。 */
function gigabytes(bytes: number): string {
  const value = bytes / 1024 ** 3;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} GB`;
}

function hours(seconds: number): string {
  const hour = Math.floor(seconds / 3600);
  const minute = Math.round((seconds % 3600) / 60);
  return minute === 0 ? `${hour} 時間` : `${hour} 時間 ${minute} 分`;
}

/** 使用量の金額（小さい額も 0 にしない）。 */
function usd(value: number): string {
  return `$${value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

export function EditorSettingsPage(props: EditorSettingsPageProps) {
  const { busy, glossary, termsDraft, recipes, recipeDraft, usage, transcription, storage, limits } = props;
  // gallery は型で守られていないので、渡されなかったときも落ちないようにする（編集中なのは文字のときだけ）
  const about = props.about ?? "";
  const aboutDraft = typeof props.aboutDraft === "string" ? props.aboutDraft : null;
  const busyProps = busy ? { "aria-disabled": true as const, style: BUSY } : {};
  const quiet = (label: string, text: string, onClick: () => void) => (
    <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label={label} {...busyProps} onClick={() => !busy && onClick()}>
      {text}
    </button>
  );
  return (
    <ShellSettingsPage title="設定" nav={EDITOR_SETTINGS_NAV}>
      <p role="status" style={STATUS}>
        {props.status}
      </p>

      <ShellSection id="es-s-ai" title="AI">
        <ShellKvs>
          <ShellKv label="提案の言語">
            <ShellPills
              label="提案の言語"
              value={props.aiLang}
              onChange={props.onAiLang}
              options={[
                { id: "same" as const, label: EDITOR_SETTINGS_TEXT.aiLang.same },
                { id: "ja" as const, label: EDITOR_SETTINGS_TEXT.aiLang.ja },
                { id: "en" as const, label: EDITOR_SETTINGS_TEXT.aiLang.en },
              ]}
            />
          </ShellKv>
          <ShellKv label="固有名詞">
            {termsDraft === null ? (
              <>
                {glossary.length === 0 ? <span style={EMPTY}>{EDITOR_SETTINGS_TEXT.empty}</span> : <code>{glossary.map((entry) => entry.term).join(" · ")}</code>}
                {quiet("固有名詞を編集", "編集", props.onEditTerms)}
              </>
            ) : null}
          </ShellKv>
          <ShellKv label="あなたについて">
            {aboutDraft === null ? (
              <>
                {about.trim() === "" ? <span style={EMPTY}>{EDITOR_SETTINGS_TEXT.empty}</span> : <span className="es-kvs-note">{summaryOf(about)}</span>}
                {quiet("あなたについてを編集", "編集", props.onEditAbout ?? (() => undefined))}
              </>
            ) : null}
          </ShellKv>
          <ShellKv label="今月の使用量">
            {usage ? (
              <>
                <span>
                  {usd(usage.costUsd)}
                  {usage.limitUsd === null ? "" : ` / ${usd(usage.limitUsd)}`}
                </span>
                <span className="es-kvs-note">
                  {usage.month}・送った {usage.inputTokens.toLocaleString("en-US")}・返った {usage.outputTokens.toLocaleString("en-US")} トークン
                </span>
              </>
            ) : (
              <span style={EMPTY}>{props.usageNote ?? EDITOR_SETTINGS_TEXT.loading}</span>
            )}
          </ShellKv>
        </ShellKvs>
        {termsDraft !== null && (
          <TermsEditor terms={termsDraft} max={limits.glossary} busy={busy} onChange={props.onTermsDraft} onCancel={props.onCancelTerms} onSave={props.onSaveTerms} />
        )}
        {aboutDraft !== null && (
          <AboutEditor
            value={aboutDraft}
            max={limits.aboutChars ?? 2_000}
            busy={busy}
            onChange={props.onAboutDraft}
            onCancel={props.onCancelAbout}
            onSave={props.onSaveAbout}
          />
        )}
        {usage?.nearLimit && (
          <p role="alert" style={NOTE}>
            {usage.limitUsd !== null && usage.costUsd >= usage.limitUsd ? EDITOR_SETTINGS_TEXT.overLimit : EDITOR_SETTINGS_TEXT.nearLimit}
          </p>
        )}
      </ShellSection>

      <ShellSection id="es-s-steps" title="手順">
        <ShellKvs>
          {recipes.map((recipe) => (
            <ShellKv key={recipe.id} label={recipe.name}>
              <span>文字起こし › {recipe.steps.map((step) => step.name).join(" › ")}</span>
              {recipe.modified && <span className="es-tag-ok">手を入れています</span>}
              {recipeDraft?.id === recipe.id ? null : (
                <>
                  {quiet(`${recipe.name}を編集`, "編集", () => props.onEditRecipe(recipe.id))}
                  {recipes.length < limits.recipes && quiet(`${recipe.name}を複製`, "複製", () => props.onDuplicateRecipe(recipe.id))}
                  {recipe.isDefault
                    ? recipe.modified && quiet(`${recipe.name}を既定に戻す`, "既定に戻す", () => props.onResetRecipe(recipe.id))
                    : quiet(`${recipe.name}を削除`, "削除", () => props.onRemoveRecipe(recipe.id))}
                </>
              )}
            </ShellKv>
          ))}
        </ShellKvs>
        {recipeDraft !== null && (
          <RecipeEditor
            recipe={recipeDraft}
            fixedSteps={recipes.find((recipe) => recipe.id === recipeDraft.id)?.isDefault ?? false}
            maxSteps={limits.steps}
            busy={busy}
            newStepId={props.newStepId}
            onChange={props.onRecipeDraft}
            onCancel={props.onCancelRecipe}
            onSave={props.onSaveRecipe}
          />
        )}
        <div className="es-kvs-add">
          {recipes.length < limits.recipes && (
            <button type="button" className="es-btn es-btn--outline es-btn--sm" {...busyProps} onClick={() => !busy && props.onAddRecipe()}>
              <Icon name="plus" />
              手順を追加
            </button>
          )}
          <p style={NOTE}>
            手順は {limits.recipes} つまで。段階は 1 つの手順に {limits.steps} つまでです。
          </p>
        </div>
      </ShellSection>

      <ShellSection id="es-s-tr" title="文字起こし">
        <ShellKvs>
          <ShellKv label="エンジン">
            <span>{EDITOR_SETTINGS_TEXT.engine[transcription.engine]}</span>
            <span className="es-kvs-note">{EDITOR_SETTINGS_TEXT.engineFixed}</span>
          </ShellKv>
          {transcription.timeoutSec !== null && (
            <ShellKv label="1 回の時間切れ">
              <span>{Math.round(transcription.timeoutSec / 60)} 分</span>
            </ShellKv>
          )}
          <ShellKv label="1 ファイルの上限">
            <span>
              {gigabytes(transcription.maxBytes)}・{hours(transcription.maxDurationSec)}
            </span>
            <span className="es-kvs-note">{EDITOR_SETTINGS_TEXT.overLimitSize}</span>
          </ShellKv>
          <ShellKv label="受け付ける形式">
            <code>{transcription.extensions.join(" · ")}</code>
          </ShellKv>
          <ShellKv label="クラウドの音声">
            <span>{transcription.retentionDays} 日で消えます</span>
            <span className="es-kvs-note">文字起こしの結果とページは残ります</span>
          </ShellKv>
        </ShellKvs>
        <p style={NOTE}>
          {transcription.engine === "off"
            ? EDITOR_SETTINGS_TEXT.engineOff
            : transcription.engine === "fake"
              ? EDITOR_SETTINGS_TEXT.engineFake
              : EDITOR_SETTINGS_TEXT.geminiLater}
        </p>
      </ShellSection>

      <ShellSection id="es-s-save" title="保存">
        <ShellKvs>
          <ShellKv label="保存先">
            <span>{EDITOR_SETTINGS_TEXT.storage[storage]}</span>
            <span className="es-kvs-note">Web からは選べません</span>
          </ShellKv>
        </ShellKvs>
        <p style={NOTE}>{EDITOR_SETTINGS_TEXT.storageFixed}</p>
      </ShellSection>
    </ShellSettingsPage>
  );
}

/** 固有名詞と誤りやすい表記の編集。誤りやすい表記は 1 つの欄に「・」で並べて書く。 */
function TermsEditor({
  terms,
  max,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  terms: EditorSettingsTermDraft[];
  max: number;
  busy: boolean;
  onChange: (next: EditorSettingsTermDraft[]) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const headingId = useId();
  const busyProps = busy ? { "aria-disabled": true as const, style: BUSY } : {};
  const at = (index: number, patch: Partial<EditorSettingsTermDraft>) => onChange(terms.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  return (
    <div style={STACK} role="group" aria-labelledby={headingId}>
      <h3 id={headingId} style={SUBHEAD}>
        固有名詞と誤りやすい表記
      </h3>
      <p style={NOTE}>{EDITOR_SETTINGS_TEXT.termsHelp}</p>
      {terms.length === 0 && <p style={EMPTY}>{EDITOR_SETTINGS_TEXT.empty}</p>}
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
        <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="固有名詞の編集をやめる" onClick={onCancel}>
          やめる
        </button>
        <button type="button" className="es-btn es-btn--primary es-btn--sm" aria-label="固有名詞を保存" {...busyProps} onClick={() => !busy && onSave()}>
          保存
        </button>
      </div>
    </div>
  );
}

/** まとめに出す 1 行（長い文は先頭だけ）。 */
function summaryOf(text: string): string {
  const line = text.trim().replace(/\s+/gu, " ");
  const chars = Array.from(line);
  return chars.length > 60 ? `${chars.slice(0, 60).join("")}…` : line;
}

/** 「あなたについて」の編集（AI に毎回渡す、本人の説明と書き方の希望）。 */
function AboutEditor({
  value,
  max,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  value: string;
  max: number;
  busy: boolean;
  onChange: (next: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const headingId = useId();
  const busyProps = busy ? { "aria-disabled": true as const, style: BUSY } : {};
  const over = Array.from(value).length > max;
  return (
    <div style={STACK} role="group" aria-labelledby={headingId}>
      <h3 id={headingId} style={SUBHEAD}>
        あなたについて
      </h3>
      <p style={NOTE}>{EDITOR_SETTINGS_TEXT.aboutHelp}</p>
      <div className="es-form">
        <ShellField label="あなたについて" value={value} onChange={onChange} multiline />
      </div>
      <p style={NOTE}>
        {Array.from(value).length.toLocaleString("en-US")} / {max.toLocaleString("en-US")} 字
      </p>
      {over && (
        <p role="alert" style={NOTE}>
          長すぎるので保存できません。{max.toLocaleString("en-US")} 字までにしてください。
        </p>
      )}
      <div style={ROW}>
        <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="あなたについての編集をやめる" onClick={onCancel}>
          やめる
        </button>
        <button
          type="button"
          className="es-btn es-btn--primary es-btn--sm"
          aria-label="あなたについてを保存"
          {...(over ? { "aria-disabled": true as const, style: BUSY } : busyProps)}
          onClick={() => !busy && !over && onSave()}
        >
          保存
        </button>
      </div>
    </div>
  );
}

/** 手順の編集（名前・お手本・段階の名前と指示）。既定の手順は段階を足したり外したりできない。 */
function RecipeEditor({
  recipe,
  fixedSteps,
  maxSteps,
  busy,
  newStepId,
  onChange,
  onCancel,
  onSave,
}: {
  recipe: EditorSettingsRecipe;
  fixedSteps: boolean;
  maxSteps: number;
  busy: boolean;
  newStepId: () => string;
  onChange: (next: EditorSettingsRecipe) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const headingId = useId();
  const busyProps = busy ? { "aria-disabled": true as const, style: BUSY } : {};
  const at = (index: number, patch: Partial<EditorSettingsStep>) =>
    onChange({ ...recipe, steps: recipe.steps.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)) });
  return (
    <div style={STACK} role="group" aria-labelledby={headingId}>
      <h3 id={headingId} style={SUBHEAD}>
        {recipe.name}を編集
      </h3>
      <div className="es-form">
        <ShellField label="手順の名前" value={recipe.name} onChange={(name) => onChange({ ...recipe, name })} />
        <ShellField label="お手本（全部の段階に渡す文書ガイド）" value={recipe.guide} multiline onChange={(guide) => onChange({ ...recipe, guide })} />
      </div>
      {recipe.steps.map((step, index) => (
        <div key={step.id} style={CARD}>
          <div className="es-form">
            <ShellField label={`段階 ${index + 1} の名前`} value={step.name} onChange={(name) => at(index, { name })} />
            <ShellField label={`段階 ${index + 1} の指示`} value={step.instruction} multiline onChange={(instruction) => at(index, { instruction })} />
          </div>
          {!fixedSteps && recipe.steps.length > 1 && (
            <div style={ROW}>
              <button
                type="button"
                className="es-btn es-btn--quiet es-btn--sm"
                aria-label={`この段階を削除（段階 ${index + 1}）`}
                onClick={() => onChange({ ...recipe, steps: recipe.steps.filter((_, i) => i !== index) })}
              >
                この段階を削除
              </button>
            </div>
          )}
        </div>
      ))}
      <div style={ROW}>
        {!fixedSteps && recipe.steps.length < maxSteps && (
          <button
            type="button"
            className="es-btn es-btn--outline es-btn--sm"
            onClick={() => onChange({ ...recipe, steps: [...recipe.steps, { id: newStepId(), name: "新しい段階", instruction: "" }] })}
          >
            <Icon name="plus" />
            段階を追加
          </button>
        )}
        <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label={`${recipe.name}の編集をやめる`} onClick={onCancel}>
          やめる
        </button>
        <button type="button" className="es-btn es-btn--primary es-btn--sm" aria-label={`${recipe.name}を保存`} {...busyProps} onClick={() => !busy && onSave()}>
          保存
        </button>
      </div>
      {fixedSteps && <p style={NOTE}>{EDITOR_SETTINGS_TEXT.fixedSteps}</p>}
    </div>
  );
}
