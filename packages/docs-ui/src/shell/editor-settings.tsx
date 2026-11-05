import { useCallback, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Icon } from "./icons";
import { ShellMenu } from "./menu";
import { ShellSheet } from "./sheet";
import type { EditorSettingsTermDraft } from "./terms-editor";
import type { ShellMenuItem } from "./types";

/**
 * editor.niho.life の設定（オーナー決定 2026-11-05。モック docs/mockups/editor-settings-refine-v1.html）。
 * 3 層に分ける: 一覧（EditorSettingsHub）→ 詳細ページ（あなたについて・固有名詞・手順）→ 集中編集のシート（段階の指示・文書ガイド）。
 *
 * - 一覧には変えられる物だけを行にする。行そのものが詳細へのリンク（「編集」ボタンは置かない）。提案の言語だけはその場で決める。
 * - 変えられない事実は使う場所へ移した（形式→ファイル選択の accept と断る文、上限・30 日→「データ」の ⓘ と録音の断り、
 *   エンジン・時間切れ→設定には出さない）。説明は ⓘ の中（押すと行の下に開く。浮かぶ吹き出しにはしない）。
 * - 手順のページは押した操作ごとにすぐ保存する（ページ全体の「保存」は持たない）。結果は h1 の下の status の 1 行で言う。
 *
 * props 駆動の表示部品で、通信・下書き・シートの開閉は呼ぶ側（apps/editor-web の components/settings）が持つ。
 * 画面の移動は href ＋ onNavigate(href)（`<a href>` を出し、普通のクリックだけ横取りする。中クリックは新しいタブで開ける）。
 */

export type EditorSettingsAiLang = "same" | "ja" | "en";

export type EditorSettingsTerm = { term: string; reading: string; variants: string[]; note: string };

export type EditorSettingsAbout = { name: string; text: string };

export type EditorSettingsStep = { id: string; name: string; instruction: string; profile: string };

export type EditorSettingsSample = { id: string; name: string; chars: number; truncatedFrom?: number; sourceUrl?: string };

export type EditorSettingsGuideExtraction = {
  sampleIds: string[];
  guide: string;
  candidates: EditorSettingsTerm[];
  createdAt?: string;
};

export type EditorSettingsRecipeValidation = {
  recipeName: string | null;
  stepNames: Record<string, string>;
  instructions: Record<string, string>;
  unusableReason: string | null;
};

export type EditorSettingsRecipe = {
  id: string;
  name: string;
  /** お手本（全部の段階に渡す文書ガイド）。 */
  guide: string;
  steps: EditorSettingsStep[];
  terms: EditorSettingsTerm[];
  samples: EditorSettingsSample[];
  /** 既定の手順のどれか。 */
  isDefault: boolean;
  /** 既定に手を入れている（既定に戻せる）。 */
  modified: boolean;
  unusableReason?: string | null;
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

/** 保存メディアの容量（byte 数は bigint の十進文字列）。 */
export type EditorSettingsStorageUsage = { totalBytes: string; imageBytes: string; audioBytes: string };

/** 「データ」の ⓘ に出す音声の事実（サーバーの値。変えられない）。 */
export type EditorSettingsAudioFacts = { maxBytes: number; maxDurationSec: number; retentionDays: number };

/** 設定のページの URL（editor-web の app/(editor)/settings の下と同じ形）。 */
export const EDITOR_SETTINGS_HREF = {
  hub: "/settings",
  about: "/settings/about",
  terms: "/settings/terms",
  recipe: (id: string) => `/settings/recipes/${encodeURIComponent(id)}`,
} as const;

export const EDITOR_SETTINGS_TEXT = {
  aiLang: { same: "書いた言語のまま", ja: "日本語", en: "English" },
  profile: { light: "軽量", standard: "標準", advanced: "高性能" } as Record<string, string>,
  empty: "まだありません",
  aboutEmpty: "まだ書いていません",
  loading: "読み込んでいます…",
  nearLimit: "今月の上限に近づいています。上限に届くと、月が替わるまで AI の提案を使えません",
  overLimit: "今月の上限に届いたので、月が替わるまで AI の提案を使えません",
  aboutSub: "AI に毎回渡す、あなたの説明と書き方の希望。公開はされません",
  termsSub: "AI の提案と文字起こし修正に、この表記のとおりに書くよう渡します",
  termEmpty: "表記を入れてください",
  fixedSteps: "既定の手順は段階の数を変えられません",
  stepHint: "前の段階の結果と文書ガイド・固有名詞は自動で渡されます",
  guideInfo: "文書ガイドは、この手順のどの段階にも渡すお手本です（構成・書き方・表記・してはいけないこと）。",
  guideEmpty: "まだありません。構成や書き方の決まりを書くと、どの段階にも渡します",
  recipeTermsInfo: "アカウント共通の固有名詞に加えて、この手順を動かすときだけ渡します。",
  importNote: "本文は 30,000 字まで保存します。ページや公開内容には入らず、抽出を頼んだときだけ AI へ送ります。上限は 8 MiB",
  extractNote: "取り込みだけでは文書ガイドや固有名詞を変更しません。必要なものだけ反映してください",
  cloud: "ページとメディアは NIHO クラウドに保存され、Web と Mac アプリで共通。容量の上限はありません",
  counted: "アップロード済みの画像と保持期限内の音声（ゴミ箱を含む）。ページ本文・版履歴・NIHO Photo のライブラリは含みません",
} as const;

const PROFILES = ["light", "standard", "advanced"] as const;
/** 送っている間のボタン（disabled にするとフォーカスが外れるので、aria-disabled と見た目だけ）。 */
const BUSY = { opacity: 0.4, cursor: "progress" } as const;
const busyProps = (busy: boolean) => (busy ? { "aria-disabled": true as const, style: BUSY } : {});

const fmt = (value: number) => value.toLocaleString("en-US");
const charCount = (text: string) => Array.from(text).length;

/** 音声ファイルの容量（上限は GiB の切りのよい値）。 */
function gigabytes(bytes: number): string {
  const value = bytes / 1024 ** 3;
  return `${Number.isInteger(value) ? value : value.toFixed(1)} GiB`;
}

/** bigint の使用量を安全に表示する（Number へ変換して精度を落とさない）。 */
function mediaBytes(value: string): string {
  const bytes = BigInt(value);
  if (bytes < 1024n) return `${bytes.toLocaleString("en-US")} bytes`;
  const units = [[1024n ** 3n, "GiB"], [1024n ** 2n, "MiB"], [1024n, "KiB"]] as const;
  const [divisor, unit] = units.find(([scale]) => bytes >= scale)!;
  const tenths = (bytes * 10n + divisor / 2n) / divisor;
  const whole = (tenths / 10n).toLocaleString("en-US");
  const fraction = tenths % 10n;
  return `${whole}${fraction === 0n ? "" : `.${fraction}`} ${unit}`;
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

/** 長い文の先頭の 1 行（見出しの記号は落とす）。 */
function firstLine(text: string, max = 60): string {
  const line = (text.split("\n").find((entry) => entry.trim() !== "") ?? "").replace(/^[-#*>\s]+/u, "").trim();
  const chars = Array.from(line);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : line;
}

function uniqueStepName(base: string, steps: readonly Pick<EditorSettingsStep, "name">[]): string {
  const key = (name: string) => name.normalize("NFKC").trim();
  const used = new Set(steps.map((step) => key(step.name)));
  if (!used.has(key(base))) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!used.has(key(candidate))) return candidate;
  }
}

/** 段階の写し（id は呼ぶ側が作る。名前は重ならないように「のコピー」を付ける）。 */
export function duplicateStep(step: EditorSettingsStep, id: string, steps: readonly EditorSettingsStep[]): EditorSettingsStep {
  return { ...step, id, name: uniqueStepName(`${step.name.trim()}のコピー`, steps) };
}

/** 段階を動かす（id と profile はそのまま）。 */
export function moveStep(steps: readonly EditorSettingsStep[], from: number, to: number): EditorSettingsStep[] {
  const next = [...steps];
  if (from < 0 || from >= next.length) return next;
  const [moved] = next.splice(from, 1);
  if (!moved) return next;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
  return next;
}

/** 新しい段階（指示は空。空のままでは保存しない）。 */
export function blankStep(id: string, steps: readonly EditorSettingsStep[]): EditorSettingsStep {
  return { id, name: uniqueStepName("新しい段階", steps), instruction: "", profile: "standard" };
}

/** `<a href>` のまま、普通のクリックだけを onNavigate へ回す（修飾キー・中クリックはブラウザに任せる）。 */
function linkTo(href: string, onNavigate: (href: string) => void) {
  return {
    href,
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onNavigate(href);
    },
  };
}

/** ⓘ を押すと、すぐ下に説明を開く（aria-expanded / aria-controls）。 */
function useDisclosure(label: string) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = (
    <button type="button" className="es-ib es-ib--sm" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
      <Icon name="info" />
    </button>
  );
  const panel = (children: ReactNode) => (
    <div id={id} className="es-row-info" hidden={!open}>
      {children}
    </div>
  );
  return { button, panel };
}

/** ひとつだけ選ぶ切り替え（押すと決まる）。 */
function Choice<T extends string>({ label, options, value, onChange, busy }: { label: string; options: readonly { id: T; label: string }[]; value: T; onChange: (id: T) => void; busy?: boolean }) {
  return (
    <div className="es-choice" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" aria-pressed={option.id === value} {...busyProps(Boolean(busy))} onClick={() => !busy && option.id !== value && onChange(option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** ⋯ のメニュー。押せない項目は aria-disabled で出す。 */
function MenuButton({ label, items, onSelect, busy }: { label: string; items: ShellMenuItem[]; onSelect: (id: string) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <span className="es-mw">
      <button ref={trigger} type="button" className="es-ib es-ib--sm" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="more" />
      </button>
      {open && (
        <ShellMenu
          label={label}
          className="es-menu--right es-menu--narrow"
          items={busy ? items.map((item) => ({ ...item, disabled: true })) : items}
          trigger={trigger}
          onClose={close}
          onSelect={(id) => {
            setOpen(false);
            trigger.current?.focus();
            onSelect(id);
          }}
        />
      )}
    </span>
  );
}

/** 手順の ⋯ の項目。既定の手順は消せない（押せない形で出し、理由を添える）。 */
export function recipeMenuItems(recipe: Pick<EditorSettingsRecipe, "isDefault" | "modified">, canDuplicate: boolean): ShellMenuItem[] {
  const items: ShellMenuItem[] = [{ id: "duplicate", label: "複製", icon: "copy", disabled: !canDuplicate, hint: canDuplicate ? undefined : "上限です" }];
  if (recipe.isDefault && recipe.modified) items.push({ id: "reset", label: "既定に戻す", icon: "reset" });
  items.push(recipe.isDefault ? { id: "remove", label: "削除", icon: "trash", danger: true, disabled: true, hint: "既定の手順" } : { id: "remove", label: "削除", icon: "trash", danger: true });
  return items;
}

/** 段階の ⋯ の項目。既定の手順（fixedSteps）は並べ替えだけ。 */
export function stepMenuItems(index: number, count: number, fixedSteps: boolean, maxSteps: number): ShellMenuItem[] {
  const items: ShellMenuItem[] = [
    { id: "up", label: "上へ", icon: "up", disabled: index === 0 },
    { id: "down", label: "下へ", icon: "down", disabled: index === count - 1 },
  ];
  if (!fixedSteps) {
    items.push({ id: "duplicate", label: "複製", icon: "copy", disabled: count >= maxSteps });
    if (count > 1) items.push({ id: "remove", label: "削除", icon: "trash", danger: true });
  }
  return items;
}

/** 詳細ページの枠: 「設定」へ戻るリンク・見出し・1 行の説明・保存の状態。 */
function SubPage({ title, heading, actions, sub, status, onNavigate, children }: { title: string; heading?: ReactNode; actions?: ReactNode; sub?: ReactNode; status: string; onNavigate: (href: string) => void; children: ReactNode }) {
  return (
    <div className="es-page es-page--set">
      <a className="es-back" {...linkTo(EDITOR_SETTINGS_HREF.hub, onNavigate)}>
        <Icon name="back" />
        設定
      </a>
      <div className="es-set-hd">
        {heading ?? <h1>{title}</h1>}
        {actions}
      </div>
      {sub && <div className="es-set-sub">{sub}</div>}
      <p role="status" className="es-set-status">
        {status}
      </p>
      {children}
    </div>
  );
}

function Group({ id, title, aside, info, children }: { id?: string; title: string; aside?: ReactNode; info?: ReactNode; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="es-sect" id={id} aria-labelledby={headingId}>
      <div className="es-sect-hd">
        <h2 id={headingId}>{title}</h2>
        {aside}
      </div>
      {info}
      {children}
    </section>
  );
}

// ===== 1. 一覧（/settings） =====

export type EditorSettingsHubProps = {
  /** 保存の状態の一言（`role="status"` で読み上げる。空なら何も言わない）。 */
  status: string;
  /** 送っている間（ボタンは押せない見た目にし、押しても何も起きない）。 */
  busy: boolean;
  aiLang: EditorSettingsAiLang;
  onAiLang: (lang: EditorSettingsAiLang) => void;
  aboutName: string;
  about: string;
  glossary: EditorSettingsTerm[];
  /** 効いている手順（既定の並び → 足したものの並び）。 */
  recipes: EditorSettingsRecipe[];
  /** 手順の上限より少ないあいだだけ「手順を追加」を出す。 */
  canAddRecipe: boolean;
  onAddRecipe: () => void;
  /** 読めなかったときは null（`usageNote` に理由の一言）。 */
  usage: EditorSettingsUsage | null;
  usageNote: string | null;
  storageUsage: EditorSettingsStorageUsage | null;
  storageUsageNote: string | null;
  audio: EditorSettingsAudioFacts;
  onNavigate: (href: string) => void;
};

function aboutSummary(name: string, text: string): string {
  return [name.trim() ? firstLine(name, 30) : "", text.trim() ? firstLine(text, 40) : ""].filter((part) => part !== "").join(" · ");
}

export function EditorSettingsHub(props: EditorSettingsHubProps) {
  const { busy, recipes, usage, storageUsage, audio, onNavigate } = props;
  const glossary = props.glossary ?? [];
  const about = aboutSummary(props.aboutName ?? "", props.about ?? "");
  const usageInfo = useDisclosure("使用量の内訳");
  const storageInfo = useDisclosure("保存とデータについて");
  const shown = glossary.slice(0, 4).map((entry) => entry.term);
  const ratio = usage && usage.limitUsd !== null && usage.limitUsd > 0 ? Math.min(1, usage.costUsd / usage.limitUsd) : null;
  return (
    <div className="es-page es-page--set">
      <h1>設定</h1>
      <p role="status" className="es-set-status">
        {props.status}
      </p>

      <Group id="es-s-ai" title="AI">
        <div className="es-grp">
          <div className="es-row es-row--lang">
            <span className="es-row-k">提案の言語</span>
            <span className="es-row-e">
              <Choice
                label="提案の言語"
                value={props.aiLang}
                onChange={props.onAiLang}
                busy={busy}
                options={[
                  { id: "same" as const, label: EDITOR_SETTINGS_TEXT.aiLang.same },
                  { id: "ja" as const, label: EDITOR_SETTINGS_TEXT.aiLang.ja },
                  { id: "en" as const, label: EDITOR_SETTINGS_TEXT.aiLang.en },
                ]}
              />
            </span>
          </div>
          <a className="es-row es-row--link" {...linkTo(EDITOR_SETTINGS_HREF.about, onNavigate)}>
            <span className="es-row-k">あなたについて</span>
            <span className={about ? "es-row-v" : "es-row-v es-row-v--none"}>
              <span className="es-row-1l">{about || EDITOR_SETTINGS_TEXT.aboutEmpty}</span>
            </span>
            <span className="es-row-e">
              <Icon name="chev" />
            </span>
          </a>
          <a className="es-row es-row--link" {...linkTo(EDITOR_SETTINGS_HREF.terms, onNavigate)}>
            <span className="es-row-k">固有名詞</span>
            <span className={shown.length ? "es-row-v" : "es-row-v es-row-v--none"}>
              <span className="es-row-1l">
                {shown.length ? shown.join(" · ") : EDITOR_SETTINGS_TEXT.empty}
                {glossary.length > shown.length && <small className="es-row-more">＋{glossary.length - shown.length}</small>}
              </span>
            </span>
            <span className="es-row-e">
              <Icon name="chev" />
            </span>
          </a>
        </div>
      </Group>

      <Group id="es-s-steps" title="手順">
        <div className="es-grp">
          {recipes.map((recipe) => (
            <a key={recipe.id} className="es-row es-row--link" {...linkTo(EDITOR_SETTINGS_HREF.recipe(recipe.id), onNavigate)}>
              <span className="es-row-k">
                <span>{recipe.name}</span>
                {recipe.isDefault ? recipe.modified && <span className="es-tag es-tag--ok">変更あり</span> : <span className="es-tag">自分で作成</span>}
              </span>
              <span className="es-row-v">
                <span className="es-row-1l">文字起こし › {recipe.steps.map((step) => step.name).join(" › ")}</span>
                {recipe.unusableReason && <span className="es-row-warn">実行できません: {recipe.unusableReason}</span>}
              </span>
              <span className="es-row-e">
                <Icon name="chev" />
              </span>
            </a>
          ))}
          {props.canAddRecipe && (
            <button type="button" className="es-row es-row--add" {...busyProps(busy)} onClick={() => !busy && props.onAddRecipe()}>
              <Icon name="plus" />
              <span>手順を追加</span>
            </button>
          )}
        </div>
      </Group>

      <Group id="es-s-data" title="データ">
        <div className="es-grp">
          <div className="es-row">
            <span className="es-row-k">今月の AI 使用量</span>
            <span className="es-row-v es-row-v--inline">
              {usage ? (
                <>
                  {ratio !== null && (
                    <span className="es-bar" aria-hidden="true">
                      <i style={{ width: `${Math.round(ratio * 100)}%` }} />
                    </span>
                  )}
                  <span>
                    {usd(usage.costUsd)}
                    {usage.limitUsd === null ? "" : ` / ${usd(usage.limitUsd)}`}
                  </span>
                </>
              ) : (
                <span className="es-row-v--none">{props.usageNote ?? EDITOR_SETTINGS_TEXT.loading}</span>
              )}
            </span>
            <span className="es-row-e">{usage && usageInfo.button}</span>
            {usage?.nearLimit && (
              <p role="alert" className="es-row-full es-row-warn">
                {usage.limitUsd !== null && usage.costUsd >= usage.limitUsd ? EDITOR_SETTINGS_TEXT.overLimit : EDITOR_SETTINGS_TEXT.nearLimit}
              </p>
            )}
          </div>
          {usage &&
            usageInfo.panel(
              <p>
                {usage.month}・送った {fmt(usage.inputTokens)}・返った {fmt(usage.outputTokens)} トークン。上限に届くと、月が替わるまで AI の提案を使えません。
              </p>,
            )}
          <div className="es-row">
            <span className="es-row-k">メディア容量</span>
            <span className="es-row-v">
              {storageUsage ? (
                <>
                  <span>{mediaBytes(storageUsage.totalBytes)}</span>
                  <small className="es-row-more">
                    画像 {mediaBytes(storageUsage.imageBytes)} · 音声 {mediaBytes(storageUsage.audioBytes)}
                  </small>
                </>
              ) : (
                <span className="es-row-v--none">{props.storageUsageNote ?? EDITOR_SETTINGS_TEXT.loading}</span>
              )}
            </span>
            <span className="es-row-e">{storageInfo.button}</span>
          </div>
          {storageInfo.panel(
            <>
              <p>
                <b>保存とデータ</b> {EDITOR_SETTINGS_TEXT.cloud}
              </p>
              <dl className="es-info-dl">
                <dt>音声</dt>
                <dd>{audio.retentionDays} 日で消えます（文字起こしとページは残ります）</dd>
                <dt>1 ファイル</dt>
                <dd>
                  {gigabytes(audio.maxBytes)}・{hours(audio.maxDurationSec)}まで
                </dd>
                <dt>数えるもの</dt>
                <dd>{EDITOR_SETTINGS_TEXT.counted}</dd>
              </dl>
            </>,
          )}
        </div>
      </Group>
    </div>
  );
}

// ===== 2a. あなたについて（/settings/about） =====

export type EditorSettingsAboutPageProps = {
  status: string;
  busy: boolean;
  value: EditorSettingsAbout;
  onChange: (next: EditorSettingsAbout) => void;
  limits: { aboutChars: number; aboutNameChars: number };
  onSave: () => void;
  onNavigate: (href: string) => void;
};

export function EditorSettingsAboutPage({ status, busy, value, onChange, limits, onSave, onNavigate }: EditorSettingsAboutPageProps) {
  const nameId = useId();
  const textId = useId();
  const nameChars = charCount(value.name);
  const textChars = charCount(value.text);
  const overName = nameChars > limits.aboutNameChars;
  const overText = textChars > limits.aboutChars;
  const blocked = busy || overName || overText;
  return (
    <SubPage title="あなたについて" sub={<span>{EDITOR_SETTINGS_TEXT.aboutSub}</span>} status={status} onNavigate={onNavigate}>
      <div className="es-form es-form--set">
        <div className="es-field">
          <label htmlFor={nameId}>呼び名</label>
          <input id={nameId} className="es-input" value={value.name} aria-invalid={overName || undefined} onChange={(event) => onChange({ ...value, name: event.target.value })} />
          <small className="es-cnt">
            {fmt(nameChars)} / {fmt(limits.aboutNameChars)} 字
          </small>
        </div>
        <div className="es-field">
          <label htmlFor={textId}>説明と書き方の希望</label>
          <textarea id={textId} className="es-area es-area--tall" value={value.text} aria-invalid={overText || undefined} onChange={(event) => onChange({ ...value, text: event.target.value })} />
          <small className="es-cnt">
            {fmt(textChars)} / {fmt(limits.aboutChars)} 字
          </small>
        </div>
        {overName && (
          <p role="alert" className="es-danger">
            呼び名が長すぎるので保存できません。{fmt(limits.aboutNameChars)} 字までにしてください。
          </p>
        )}
        {overText && (
          <p role="alert" className="es-danger">
            説明と書き方の希望が長すぎるので保存できません。{fmt(limits.aboutChars)} 字までにしてください。
          </p>
        )}
      </div>
      <div className="es-set-foot">
        <a className="es-btn es-btn--quiet es-btn--sm" aria-label="あなたについての編集をやめる" {...linkTo(EDITOR_SETTINGS_HREF.hub, onNavigate)}>
          やめる
        </a>
        <button type="button" className="es-btn es-btn--primary es-btn--sm" aria-label="あなたについてを保存" {...busyProps(blocked)} onClick={() => !blocked && onSave()}>
          保存
        </button>
      </div>
    </SubPage>
  );
}

// ===== 固有名詞の表（固有名詞のページと、手順の「この手順だけの固有名詞」） =====

/** 直している 1 行。index が null なら足している新しい行。誤りやすい表記は打ったままの文字列（保存のときに配列にする）。 */
export type EditorTermEditing = { index: number | null; draft: EditorSettingsTermDraft };

export type EditorTermRowsProps = {
  /** 表の名前（読み上げ）。 */
  label: string;
  terms: EditorSettingsTerm[];
  max: number;
  busy: boolean;
  editing: EditorTermEditing | null;
  /** 行を押した（呼ぶ側が誤りやすい表記を「・」で繋いだ下書きを作る）。 */
  onOpen: (index: number) => void;
  onAdd: () => void;
  onDraft: (draft: EditorSettingsTermDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  /** 直している行を消す。 */
  onRemove: () => void;
  /** 表の最後に「追加」の行を出す（手順のページ。固有名詞のページは見出しの右にボタン）。 */
  addRow?: boolean;
};

function TermEditRow({ editing, busy, onDraft, onCancel, onSave, onRemove }: { editing: EditorTermEditing; busy: boolean } & Pick<EditorTermRowsProps, "onDraft" | "onCancel" | "onSave" | "onRemove">) {
  const id = useId();
  const first = useRef<HTMLInputElement | null>(null);
  const { draft } = editing;
  const empty = draft.term.trim() === "";
  const blocked = busy || empty;
  const name = editing.index === null ? "新しい固有名詞" : `${draft.term.trim() || "表記のない行"}`;
  useEffect(() => {
    first.current?.focus();
  }, []);
  const input = (key: keyof EditorSettingsTermDraft, label: string, ref?: typeof first) => (
    <div className="es-field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <input ref={ref} id={`${id}-${key}`} className="es-input" value={draft[key]} onChange={(event) => onDraft({ ...draft, [key]: event.target.value })} />
    </div>
  );
  return (
    <div className="es-row es-row--edit" role="group" aria-label={editing.index === null ? name : `${name}を編集中`}>
      <div className="es-term-fields">
        {input("term", "表記", first)}
        {input("reading", "よみ")}
        {/* 打ったままの文字列を持つ（区切りを打った時点で配列にすると、続きが前の語に繋がる） */}
        {input("variants", "誤りやすい表記（「・」で区切る）")}
        {input("note", "補足")}
      </div>
      {empty && <small className="es-row-hint">{EDITOR_SETTINGS_TEXT.termEmpty}</small>}
      <div className="es-row-acts">
        <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="固有名詞の編集をやめる" onClick={onCancel}>
          やめる
        </button>
        {editing.index !== null && (
          <button type="button" className="es-btn es-btn--quiet es-btn--sm es-btn--danger" aria-label={`${name}を削除`} {...busyProps(busy)} onClick={() => !busy && onRemove()}>
            削除
          </button>
        )}
        <button type="button" className="es-btn es-btn--primary es-btn--sm" aria-label="固有名詞を保存" {...busyProps(blocked)} onClick={() => !blocked && onSave()}>
          保存
        </button>
      </div>
    </div>
  );
}

/** 表記 | よみ | 誤りやすい表記 の表。行を押すとその行だけがその場の欄に変わる（同時に直すのは 1 行。送っている間は別の行を開かない）。 */
export function EditorTermRows(props: EditorTermRowsProps) {
  const { label, terms, max, busy, editing } = props;
  const adding = editing?.index === null;
  const edit = (current: EditorTermEditing) => <TermEditRow key={current.index ?? "new"} editing={current} busy={busy} onDraft={props.onDraft} onCancel={props.onCancel} onSave={props.onSave} onRemove={props.onRemove} />;
  return (
    <div className="es-grp" role="group" aria-label={label}>
      {terms.length > 0 && (
        <div className="es-row es-row--term es-row--th" aria-hidden="true">
          <span>表記</span>
          <span>よみ</span>
          <span>誤りやすい表記</span>
          <span />
        </div>
      )}
      {terms.map((entry, index) =>
        editing?.index === index ? (
          edit(editing)
        ) : (
          <button key={`${index}:${entry.term}`} type="button" className="es-row es-row--term" aria-label={`${entry.term || "表記のない行"} を編集`} {...busyProps(busy)} onClick={() => !busy && props.onOpen(index)}>
            <span className="es-tm-t">{entry.term}</span>
            <span className={entry.reading ? "es-tm-r" : "es-tm-r es-tm--none"} data-k="よみ">
              {entry.reading || "—"}
            </span>
            <span className={entry.variants.length ? "es-tm-v" : "es-tm-v es-tm--none"} data-k="誤りやすい表記">
              {entry.variants.length ? entry.variants.join(" · ") : "—"}
            </span>
            <span className="es-tm-ic">
              <Icon name="edit" />
            </span>
          </button>
        ),
      )}
      {adding && editing && edit(editing)}
      {terms.length === 0 && !adding && <div className="es-row es-row--note">{EDITOR_SETTINGS_TEXT.empty}</div>}
      {props.addRow && !adding && terms.length < max && (
        <button type="button" className="es-row es-row--add" {...busyProps(busy)} onClick={() => !busy && props.onAdd()}>
          <Icon name="plus" />
          <span>追加</span>
        </button>
      )}
    </div>
  );
}

// ===== 2b. 固有名詞（/settings/terms） =====

export type EditorSettingsTermsPageProps = {
  status: string;
  rows: Omit<EditorTermRowsProps, "label" | "addRow">;
  onNavigate: (href: string) => void;
};

export function EditorSettingsTermsPage({ status, rows, onNavigate }: EditorSettingsTermsPageProps) {
  const full = rows.terms.length >= rows.max || rows.editing?.index === null;
  return (
    <SubPage
      title="固有名詞"
      status={status}
      onNavigate={onNavigate}
      actions={
        <button type="button" className="es-btn es-btn--outline es-btn--sm" aria-label="固有名詞を追加" {...busyProps(full)} onClick={() => !full && rows.onAdd()}>
          <Icon name="plus" />
          追加
        </button>
      }
      sub={
        <span>
          {EDITOR_SETTINGS_TEXT.termsSub} · {fmt(rows.terms.length)} 語 / {fmt(rows.max)} 語
        </span>
      }
    >
      <div className="es-sect">
        <EditorTermRows {...rows} label="固有名詞" />
      </div>
    </SubPage>
  );
}

// ===== 2c. 手順（/settings/recipes/{id}）と 3. 集中編集のシート =====

/** 手順のページで開いているシート（呼ぶ側が持つ。下書きもここに入る）。 */
export type EditorRecipeSheet =
  | { kind: "step"; index: number | null; draft: EditorSettingsStep }
  | { kind: "guide"; draft: string }
  | { kind: "import"; file: File | null; url: string }
  | { kind: "extract" };

export type EditorSettingsRecipePageProps = {
  status: string;
  busy: boolean;
  recipe: EditorSettingsRecipe;
  /** 手順の上限より少ない（複製できる）。 */
  canDuplicate: boolean;
  maxSteps: number;
  maxSamples?: number;
  /** 見出しの名前の欄（離れたとき・Enter で onCommitName）。 */
  nameDraft: string;
  nameError: string | null;
  onNameDraft: (name: string) => void;
  onCommitName: () => void;
  onDuplicate: () => void;
  onReset: () => void;
  onRemove: () => void;
  /** 並べ替え・複製・削除の後の段階の並び（すぐ保存する）。 */
  onSteps: (steps: EditorSettingsStep[]) => void;
  newStepId: () => string;
  sheet: EditorRecipeSheet | null;
  onSheet: (sheet: EditorRecipeSheet | null) => void;
  /** 開いている段階の下書きの誤り（名前の重なり・空の指示）。 */
  stepErrors: { name?: string; instruction?: string } | null;
  onSaveStep: () => void;
  onSaveGuide: () => void;
  onImport: () => void;
  onExtract: () => void;
  extraction: EditorSettingsGuideExtraction | null;
  selectedExtractionTerms: string[];
  onToggleExtractionTerm: (key: string, selected: boolean) => void;
  onApplyExtractedGuide: () => void;
  onApplyExtractedTerms: () => void;
  onRemoveSample: (id: string) => void;
  terms: Omit<EditorTermRowsProps, "label" | "addRow">;
  onNavigate: (href: string) => void;
};

/** 集中編集のシートの頭（小さな位置の一言・見出し・閉じる）。 */
function SheetHead({ small, title, onClose }: { small?: string; title: string; onClose: () => void }) {
  return (
    <div className="es-sh-hd">
      <div className="es-sh-ttl">
        {small && <small>{small}</small>}
        <h2>{title}</h2>
      </div>
      <button type="button" className="es-ib" aria-label="閉じる" onClick={onClose}>
        <Icon name="x" />
      </button>
    </div>
  );
}

function SheetFoot({ hint, status, children }: { hint?: string; status: string; children: ReactNode }) {
  return (
    <div className="es-sh-foot">
      {hint && <p className="es-sh-note es-sh-hint es-sh-hint--wide">{hint}</p>}
      <p role="status" className="es-sh-note es-sh-hint">
        {status}
      </p>
      <div className="es-sh-acts">{children}</div>
    </div>
  );
}

function StepSheet({ props, sheet }: { props: EditorSettingsRecipePageProps; sheet: Extract<EditorRecipeSheet, { kind: "step" }> }) {
  const { recipe, busy, stepErrors } = props;
  const nameId = useId();
  const textId = useId();
  const { draft } = sheet;
  const total = recipe.steps.length + (sheet.index === null ? 1 : 0);
  const position = sheet.index === null ? total : sheet.index + 1;
  const blocked = busy || Boolean(stepErrors?.name || stepErrors?.instruction);
  const close = () => props.onSheet(null);
  const set = (patch: Partial<EditorSettingsStep>) => props.onSheet({ ...sheet, draft: { ...draft, ...patch } });
  const profile = (PROFILES as readonly string[]).includes(draft.profile) ? draft.profile : "standard";
  return (
    <ShellSheet label={sheet.index === null ? "新しい段階" : `段階 ${position} の編集`} onClose={close} className="es-sheet--edit" veilClassName="es-veil--edit">
      <SheetHead small={`段階 ${position} / ${total} · ${recipe.name}`} title={draft.name.trim() || "名前のない段階"} onClose={close} />
      <div className="es-sh-body es-sh-body--fill">
        <div className="es-sh-meta">
          <div className="es-field">
            <label htmlFor={nameId}>名前</label>
            <input id={nameId} className="es-input" value={draft.name} aria-invalid={stepErrors?.name ? true : undefined} aria-describedby={stepErrors?.name ? `${nameId}-e` : undefined} onChange={(event) => set({ name: event.target.value })} />
            {stepErrors?.name && (
              <small id={`${nameId}-e`} className="es-danger">
                {stepErrors.name}
              </small>
            )}
          </div>
          <div className="es-field">
            <span className="es-field-lbl" aria-hidden="true">
              重さ
            </span>
            <Choice label="重さ" value={profile} onChange={(next) => set({ profile: next })} options={PROFILES.map((id) => ({ id: id as string, label: EDITOR_SETTINGS_TEXT.profile[id]! }))} />
          </div>
        </div>
        <div className="es-lab">
          <label htmlFor={textId}>指示</label>
          <span className="es-cnt">{fmt(charCount(draft.instruction))} 字</span>
        </div>
        <textarea
          id={textId}
          className="es-area es-area--big"
          data-autofocus
          value={draft.instruction}
          aria-invalid={stepErrors?.instruction ? true : undefined}
          aria-describedby={stepErrors?.instruction ? `${textId}-e` : undefined}
          onChange={(event) => set({ instruction: event.target.value })}
        />
        {stepErrors?.instruction && (
          <small id={`${textId}-e`} className="es-danger">
            {stepErrors.instruction}
          </small>
        )}
      </div>
      <SheetFoot hint={EDITOR_SETTINGS_TEXT.stepHint} status={props.status}>
        <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="段階の編集をやめる" onClick={close}>
          やめる
        </button>
        <button type="button" className="es-btn es-btn--primary es-btn--sm" aria-label="段階を保存" {...busyProps(blocked)} onClick={() => !blocked && props.onSaveStep()}>
          保存
        </button>
      </SheetFoot>
    </ShellSheet>
  );
}

function GuideSheet({ props, sheet }: { props: EditorSettingsRecipePageProps; sheet: Extract<EditorRecipeSheet, { kind: "guide" }> }) {
  const { recipe, busy } = props;
  const textId = useId();
  const close = () => props.onSheet(null);
  return (
    <ShellSheet label="文書ガイドの編集" onClose={close} className="es-sheet--edit" veilClassName="es-veil--edit">
      <SheetHead small={recipe.name} title="文書ガイド" onClose={close} />
      <div className="es-sh-body es-sh-body--fill">
        <div className="es-lab">
          <label htmlFor={textId}>文書ガイド</label>
          <span className="es-cnt">{fmt(charCount(sheet.draft))} 字</span>
        </div>
        <textarea id={textId} className="es-area es-area--big" data-autofocus value={sheet.draft} onChange={(event) => props.onSheet({ ...sheet, draft: event.target.value })} />
      </div>
      <SheetFoot status={props.status}>
        {recipe.samples.length > 0 && (
          <button type="button" className="es-btn es-btn--outline es-btn--sm" {...busyProps(busy)} onClick={() => !busy && props.onExtract()}>
            <Icon name="spark" />
            お手本から抽出
          </button>
        )}
        <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="文書ガイドの編集をやめる" onClick={close}>
          やめる
        </button>
        <button type="button" className="es-btn es-btn--primary es-btn--sm" aria-label="文書ガイドを保存" {...busyProps(busy)} onClick={() => !busy && props.onSaveGuide()}>
          保存
        </button>
      </SheetFoot>
    </ShellSheet>
  );
}

function ImportSheet({ props, sheet }: { props: EditorSettingsRecipePageProps; sheet: Extract<EditorRecipeSheet, { kind: "import" }> }) {
  const { busy } = props;
  const fileId = useId();
  const urlId = useId();
  const blocked = busy || (sheet.file === null && sheet.url.trim() === "");
  const close = () => props.onSheet(null);
  return (
    <ShellSheet label="お手本の文書を取り込む" onClose={close}>
      <SheetHead title="お手本の文書を取り込む" onClose={close} />
      <div className="es-sh-body es-sh-body--fill">
        <div className="es-field">
          <label htmlFor={fileId}>ファイル（Markdown・テキスト・Word・PDF）</label>
          <input id={fileId} className="es-input" type="file" accept=".md,.txt,.docx,.pdf" data-autofocus onChange={(event) => props.onSheet({ ...sheet, file: event.currentTarget.files?.[0] ?? null })} />
        </div>
        <p className="es-or">または</p>
        <div className="es-field">
          <label htmlFor={urlId}>公開 Web ページの URL</label>
          <input id={urlId} className="es-input" type="url" inputMode="url" value={sheet.url} onChange={(event) => props.onSheet({ ...sheet, url: event.target.value })} />
        </div>
        <p className="es-sh-hint es-sh-note">{EDITOR_SETTINGS_TEXT.importNote}</p>
      </div>
      <SheetFoot status={props.status}>
        <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="取り込みをやめる" onClick={close}>
          やめる
        </button>
        <button type="button" className="es-btn es-btn--primary es-btn--sm" {...busyProps(blocked)} onClick={() => !blocked && props.onImport()}>
          取り込む
        </button>
      </SheetFoot>
    </ShellSheet>
  );
}

function ExtractSheet({ props }: { props: EditorSettingsRecipePageProps }) {
  const { busy, extraction, selectedExtractionTerms } = props;
  const guideId = useId();
  const close = () => props.onSheet(null);
  return (
    <ShellSheet label="抽出した案" onClose={close} className="es-sheet--edit" veilClassName="es-veil--edit">
      <SheetHead small={extraction?.createdAt ? `${new Date(extraction.createdAt).toLocaleString("ja-JP")} に抽出` : props.recipe.name} title="抽出した案" onClose={close} />
      <div className="es-sh-body es-sh-body--fill">
        <p className="es-sh-hint es-sh-note">{EDITOR_SETTINGS_TEXT.extractNote}</p>
        {extraction ? (
          <>
            <div className="es-lab">
              <label htmlFor={guideId}>抽出された文書ガイド</label>
              <span className="es-cnt">{fmt(charCount(extraction.guide))} 字</span>
            </div>
            <textarea id={guideId} className="es-area es-area--mid" readOnly value={extraction.guide} />
            <div>
              <button type="button" className="es-btn es-btn--outline es-btn--sm" {...busyProps(busy)} onClick={() => !busy && props.onApplyExtractedGuide()}>
                文書ガイドに置き換える
              </button>
            </div>
            <fieldset className="es-cands">
              <legend>固有名詞候補</legend>
              {extraction.candidates.length === 0 ? (
                <p className="es-sh-hint es-sh-note">新しい候補はありません</p>
              ) : (
                extraction.candidates.map((candidate, index) => {
                  const key = `${candidate.term}:${index}`;
                  const id = `${guideId}-c${index}`;
                  return (
                    <label key={key} htmlFor={id} className="es-cand">
                      <input id={id} type="checkbox" checked={selectedExtractionTerms.includes(key)} onChange={(event) => props.onToggleExtractionTerm(key, event.currentTarget.checked)} />
                      <span>
                        {candidate.term}
                        {candidate.reading ? `（${candidate.reading}）` : ""}
                      </span>
                    </label>
                  );
                })
              )}
              {extraction.candidates.length > 0 && (
                <div>
                  <button type="button" className="es-btn es-btn--outline es-btn--sm" {...busyProps(busy || selectedExtractionTerms.length === 0)} onClick={() => !busy && selectedExtractionTerms.length > 0 && props.onApplyExtractedTerms()}>
                    選んだ固有名詞を追加
                  </button>
                </div>
              )}
            </fieldset>
          </>
        ) : (
          <p className="es-sh-hint es-sh-note">抽出した案はまだありません</p>
        )}
      </div>
      <SheetFoot status={props.status}>
        <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={close}>
          閉じる
        </button>
      </SheetFoot>
    </ShellSheet>
  );
}

export function EditorSettingsRecipePage(props: EditorSettingsRecipePageProps) {
  const { recipe, busy, sheet, maxSteps } = props;
  const maxSamples = props.maxSamples ?? 5;
  const nameId = useId();
  const guideInfo = useDisclosure("文書ガイドとは");
  const termsInfo = useDisclosure("この手順だけの固有名詞とは");
  const fixed = recipe.isDefault;
  const steps = recipe.steps;
  const openStep = (index: number) => {
    const step = steps[index];
    if (step) props.onSheet({ kind: "step", index, draft: { ...step } });
  };
  const onStepMenu = (index: number, id: string) => {
    const step = steps[index];
    if (!step || busy) return;
    if (id === "up" && index > 0) props.onSteps(moveStep(steps, index, index - 1));
    if (id === "down" && index < steps.length - 1) props.onSteps(moveStep(steps, index, index + 1));
    if (id === "duplicate" && !fixed && steps.length < maxSteps) props.onSteps([...steps.slice(0, index + 1), duplicateStep(step, props.newStepId(), steps), ...steps.slice(index + 1)]);
    if (id === "remove" && !fixed && steps.length > 1) props.onSteps(steps.filter((_, i) => i !== index));
  };
  const onRecipeMenu = (id: string) => {
    if (busy) return;
    if (id === "duplicate" && props.canDuplicate) props.onDuplicate();
    if (id === "reset" && recipe.isDefault && recipe.modified) props.onReset();
    if (id === "remove" && !recipe.isDefault) props.onRemove();
  };
  return (
    <SubPage
      title={recipe.name}
      status={props.status}
      onNavigate={props.onNavigate}
      heading={
        <h1>
          <input
            className="es-set-name"
            aria-label="手順の名前"
            value={props.nameDraft}
            aria-invalid={props.nameError ? true : undefined}
            aria-describedby={props.nameError ? `${nameId}-e` : undefined}
            onChange={(event) => props.onNameDraft(event.target.value)}
            onBlur={props.onCommitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                props.onCommitName();
              }
            }}
          />
        </h1>
      }
      actions={<MenuButton label="手順のメニュー" items={recipeMenuItems(recipe, props.canDuplicate)} busy={busy} onSelect={onRecipeMenu} />}
      sub={
        <>
          {props.nameError && (
            <small id={`${nameId}-e`} className="es-danger es-set-err">
              {props.nameError}
            </small>
          )}
          <span>{recipe.isDefault ? "既定の手順" : "自分で作成"}</span>
          {recipe.isDefault && recipe.modified && <span className="es-tag es-tag--ok">変更あり</span>}
          {recipe.unusableReason && <span className="es-set-warn">実行できません: {recipe.unusableReason}</span>}
        </>
      }
    >
      <Group title="段階">
        <div className="es-grp">
          {steps.map((step, index) => (
            <div key={step.id} className="es-row es-row--split">
              <button type="button" className="es-row-main" aria-label={`段階 ${index + 1} ${step.name} を開く`} onClick={() => openStep(index)}>
                <span className="es-num" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="es-row-t">
                  <b>{step.name}</b>
                  <small>{firstLine(step.instruction) || "指示がありません"}</small>
                </span>
                <span className="es-tag">{EDITOR_SETTINGS_TEXT.profile[step.profile] ?? EDITOR_SETTINGS_TEXT.profile.standard}</span>
                <Icon name="chev" className="es-chev" />
              </button>
              <MenuButton label={`段階 ${index + 1} のメニュー`} items={stepMenuItems(index, steps.length, fixed, maxSteps)} busy={busy} onSelect={(id) => onStepMenu(index, id)} />
            </div>
          ))}
          {fixed ? (
            <div className="es-row es-row--note">
              <span>{EDITOR_SETTINGS_TEXT.fixedSteps}</span>
              <button type="button" className="es-btn es-btn--quiet es-btn--sm" {...busyProps(busy || !props.canDuplicate)} onClick={() => !busy && props.canDuplicate && props.onDuplicate()}>
                複製して足す
              </button>
            </div>
          ) : (
            steps.length < maxSteps && (
              <button type="button" className="es-row es-row--add" onClick={() => props.onSheet({ kind: "step", index: null, draft: blankStep(props.newStepId(), steps) })}>
                <Icon name="plus" />
                <span>段階を追加</span>
              </button>
            )
          )}
        </div>
      </Group>

      <Group title="文書ガイド" aside={guideInfo.button} info={guideInfo.panel(<p>{EDITOR_SETTINGS_TEXT.guideInfo}</p>)}>
        <button type="button" className="es-gcard" aria-label="文書ガイドを開く" onClick={() => props.onSheet({ kind: "guide", draft: recipe.guide })}>
          <span className={recipe.guide.trim() ? "es-gcard-t" : "es-gcard-t es-row-v--none"}>{recipe.guide.trim() ? recipe.guide : EDITOR_SETTINGS_TEXT.guideEmpty}</span>
          <span className="es-gcard-f">
            <span>{fmt(charCount(recipe.guide))} 字</span>
            <b>
              開く
              <Icon name="chev" />
            </b>
          </span>
        </button>
      </Group>

      <Group
        title="お手本の文書"
        aside={
          recipe.samples.length > 0 && (
            <button type="button" className="es-sect-act" {...busyProps(busy)} onClick={() => !busy && props.onExtract()}>
              <Icon name="spark" />
              文書ガイドを抽出
            </button>
          )
        }
      >
        <div className="es-grp">
          {recipe.samples.map((sample) => (
            <div key={sample.id} className="es-row es-row--sample">
              <Icon name={sample.sourceUrl ? "link" : "doc"} />
              <span className="es-row-t">
                <b>{sample.name}</b>
                <small>
                  {fmt(sample.chars)} 字{sample.truncatedFrom !== undefined ? ` · 元の文書は ${fmt(sample.truncatedFrom)} 字` : ""}
                  {sample.sourceUrl ? " · URL から" : ""}
                </small>
              </span>
              <button type="button" className="es-ib es-ib--sm" aria-label={`${sample.name} を外す`} {...busyProps(busy)} onClick={() => !busy && props.onRemoveSample(sample.id)}>
                <Icon name="x" />
              </button>
            </div>
          ))}
          {props.extraction && (
            <div className="es-row es-row--note">
              <span>抽出した案があります</span>
              <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-label="抽出した案を見る" onClick={() => props.onSheet({ kind: "extract" })}>
                見る
              </button>
            </div>
          )}
          {recipe.samples.length === 0 && <div className="es-row es-row--note">{EDITOR_SETTINGS_TEXT.empty}</div>}
          {recipe.samples.length < maxSamples && (
            <button type="button" className="es-row es-row--add" aria-label="お手本の文書を取り込む" onClick={() => props.onSheet({ kind: "import", file: null, url: "" })}>
              <Icon name="plus" />
              <span>
                取り込む<small className="es-row-more">ファイル・URL</small>
              </span>
            </button>
          )}
        </div>
      </Group>

      <Group title="この手順だけの固有名詞" aside={termsInfo.button} info={termsInfo.panel(<p>{EDITOR_SETTINGS_TEXT.recipeTermsInfo}</p>)}>
        <EditorTermRows {...props.terms} label="この手順だけの固有名詞" addRow />
      </Group>

      {sheet?.kind === "step" && <StepSheet props={props} sheet={sheet} />}
      {sheet?.kind === "guide" && <GuideSheet props={props} sheet={sheet} />}
      {sheet?.kind === "import" && <ImportSheet props={props} sheet={sheet} />}
      {sheet?.kind === "extract" && <ExtractSheet props={props} />}
    </SubPage>
  );
}
