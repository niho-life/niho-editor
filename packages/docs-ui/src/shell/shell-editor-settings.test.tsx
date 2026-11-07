import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EDITOR_SETTINGS_TEXT,
  EditorSettingsAboutPage,
  EditorSettingsAuthorPage,
  EditorSettingsHub,
  EditorSettingsRecipePage,
  EditorSettingsTermsPage,
  recipeMenuItems,
  stepMenuItems,
  type EditorRecipeSheet,
  type EditorSettingsAboutPageProps,
  type EditorSettingsAuthorPageProps,
  type EditorSettingsHubProps,
  type EditorSettingsRecipe,
  type EditorSettingsRecipePageProps,
  type EditorTermRowsProps,
} from "./index";

/** editor.niho.life の設定（オーナー決定 2026-11-05）。一覧 → 詳細ページ → 集中編集のシートの 3 層。値はすべて合成。 */

const noop = () => undefined;

const RECIPES: EditorSettingsRecipe[] = [
  { id: "tpl-1", name: "記事制作", guide: "## 構成\n見出しを 4〜6 本。\n本文は 2,000 字。\n4 行目", steps: [
    { id: "k7m2q9xa", name: "文字起こし修正", instruction: "- 読みやすく整える。\n次の行", profile: "light" },
    { id: "r4t8wz3c", name: "記事方針", instruction: "方針を立てる。", profile: "advanced" },
  ], terms: [], samples: [], isDefault: true, modified: false },
  { id: "tpl-2", name: "議事録", guide: "", steps: [{ id: "d9c3x7mf", name: "議事録", instruction: "", profile: "standard" }], terms: [], samples: [], isDefault: true, modified: true, unusableReason: "「議事録」の指示が空です。" },
  { id: "r-talk", name: "対談", guide: "", steps: [{ id: "s-1", name: "まとめ", instruction: "まとめる。", profile: "advanced" }], terms: [{ term: "鎌倉ひとはこ", reading: "かまくらひとはこ", variants: ["鎌倉一箱"], note: "" }], samples: [
    { id: "sample-1", name: "朝市レポート.md", chars: 8200 },
    { id: "sample-2", name: "ひとはこ通信", chars: 30000, truncatedFrom: 41000, sourceUrl: "https://example.invalid/a" },
  ], isDefault: false, modified: false },
];

function hubProps(patch: Partial<EditorSettingsHubProps> = {}): EditorSettingsHubProps {
  return {
    status: "",
    busy: false,
    aiLang: "same",
    onAiLang: noop,
    aboutName: "合成の呼び名",
    about: "合成の自己紹介です。\n二行目",
    glossary: ["北鎌倉", "円覚寺", "材木座", "由比ヶ浜", "長谷", "極楽寺"].map((term) => ({ term, reading: "", variants: [], note: "" })),
    recipes: RECIPES,
    canAddRecipe: true,
    onAddRecipe: noop,
    usage: { month: "2026-10", inputTokens: 128400, outputTokens: 12900, costUsd: 0.42, limitUsd: 5, nearLimit: false },
    usageNote: null,
    storageUsage: { imageBytes: "1073741824", audioBytes: "4096", totalBytes: "1073745920" },
    storageUsageNote: null,
    audio: { maxBytes: 2 * 1024 ** 3, maxDurationSec: 6 * 3600, retentionDays: 30 },
    account: { name: "合成の名前", caption: "synthetic@example.invalid", initial: "合" },
    destinations: {
      faces: [{ id: "exp", label: "NIHO Experience", available: false, reason: "role" }],
      sites: [{ id: "11111111-2222-4333-8444-555555555555", label: "synthetic.example" }],
    },
    onLogout: noop,
    onNavigate: noop,
    ...patch,
  };
}

function termRows(patch: Partial<Omit<EditorTermRowsProps, "label" | "addRow">> = {}): Omit<EditorTermRowsProps, "label" | "addRow"> {
  return {
    terms: [
      { term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌", "きた鎌倉"], note: "" },
      { term: "円覚寺", reading: "", variants: [], note: "" },
    ],
    max: 200,
    busy: false,
    editing: null,
    onOpen: noop,
    onAdd: noop,
    onDraft: noop,
    onCancel: noop,
    onSave: noop,
    onRemove: noop,
    ...patch,
  };
}

function recipeProps(recipe: EditorSettingsRecipe, patch: Partial<EditorSettingsRecipePageProps> = {}): EditorSettingsRecipePageProps {
  return {
    status: "",
    busy: false,
    recipe,
    canDuplicate: true,
    maxSteps: 12,
    nameDraft: recipe.name,
    nameError: null,
    onNameDraft: noop,
    onCommitName: noop,
    onDuplicate: noop,
    onReset: noop,
    onRemove: noop,
    onSteps: noop,
    newStepId: () => "s-new",
    sheet: null,
    onSheet: noop,
    stepErrors: null,
    onSaveStep: noop,
    onSaveGuide: noop,
    onImport: noop,
    onExtract: noop,
    extraction: null,
    selectedExtractionTerms: [],
    onToggleExtractionTerm: noop,
    onApplyExtractedGuide: noop,
    onApplyExtractedTerms: noop,
    onRemoveSample: noop,
    terms: termRows({ terms: recipe.terms }),
    onNavigate: noop,
    ...patch,
  };
}

function aboutProps(patch: Partial<EditorSettingsAboutPageProps> = {}): EditorSettingsAboutPageProps {
  return { status: "", busy: false, value: { name: "みか", text: "短い文で書きます。" }, onChange: noop, limits: { aboutChars: 2_000, aboutNameChars: 80 }, onSave: noop, onNavigate: noop, ...patch };
}

function authorProps(patch: Partial<EditorSettingsAuthorPageProps> = {}): EditorSettingsAuthorPageProps {
  return { status: "", busy: false, value: { role: "合成の案内人", bio: "海辺の朝を書きます。" }, onChange: noop, limits: { authorRoleChars: 120, authorBioChars: 600 }, onSave: noop, onNavigate: noop, ...patch };
}

const hub = (patch: Partial<EditorSettingsHubProps> = {}) => renderToStaticMarkup(<EditorSettingsHub {...hubProps(patch)} />);
const authorPage = (patch: Partial<EditorSettingsAuthorPageProps> = {}) => renderToStaticMarkup(<EditorSettingsAuthorPage {...authorProps(patch)} />);
const recipePage = (recipe: EditorSettingsRecipe, patch: Partial<EditorSettingsRecipePageProps> = {}) => renderToStaticMarkup(<EditorSettingsRecipePage {...recipeProps(recipe, patch)} />);
const aboutPage = (patch: Partial<EditorSettingsAboutPageProps> = {}) => renderToStaticMarkup(<EditorSettingsAboutPage {...aboutProps(patch)} />);
const termsPage = (patch: Partial<Omit<EditorTermRowsProps, "label" | "addRow">> = {}) => renderToStaticMarkup(<EditorSettingsTermsPage status="" rows={termRows(patch)} onNavigate={noop} />);
const textOf = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

/** ボタンはすべて、aria-label か見える文字を持つ。 */
function unlabeledButtons(markup: string): string[] {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attrs, inner]) => !/aria-label="[^"]+"/.test(attrs ?? "") && (inner ?? "").replace(/<[^>]*>/g, "").trim() === "")
    .map(([whole]) => whole.slice(0, 80));
}

/** 入力は、for が結ばれた label か aria-label を持つ。 */
function unlabeledInputs(markup: string): string[] {
  return [...markup.matchAll(/<(input|textarea)\b([^>]*?)>/g)]
    .filter(([, , attrs]) => {
      if (/aria-label="[^"]+"/.test(attrs ?? "")) return false;
      const id = /\bid="([^"]+)"/.exec(attrs ?? "")?.[1];
      return !id || !new RegExp(`<label[^>]*for="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(markup);
    })
    .map(([whole]) => whole.slice(0, 80));
}

/** 押せない見た目のボタン（busy）を、名前（aria-label か文字）で探す。 */
function buttonAttrs(markup: string, name: string): string | undefined {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(([, attrs, inner]) => (/aria-label="([^"]+)"/.exec(attrs ?? "")?.[1] ?? (inner ?? "").replace(/<[^>]*>/g, "").trim()) === name)?.[1];
}

describe("EditorSettingsHub（/settings）", () => {
  it("has the groups アカウント / AI / 手順 / データ, a status line, and no 「編集」 button anywhere", () => {
    const markup = hub();
    for (const id of ["es-s-account", "es-s-destinations", "es-s-ai", "es-s-steps", "es-s-data"]) expect(markup).toContain(`id="${id}"`);
    const titles = [...markup.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map(([, title]) => title);
    expect(titles).toEqual(["アカウント", "発信先", "AI", "手順", "データ"]);
    expect(markup).toContain('role="status"');
    expect([...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(([, inner]) => (inner ?? "").replace(/<[^>]*>/g, "").trim())).not.toContain("編集");
    // 事実は一覧から外した（エンジン・時間切れ・受け付ける形式・保存の節）
    const shown = textOf(markup);
    for (const gone of ["Deepgram", "時間切れ", "受け付ける形式", "文字起こし</h2>"]) expect(markup.includes(gone) || shown.includes(gone)).toBe(false);
  });

  it("puts session 本人 first and destinations in their own group, and ログアウト last", () => {
    const markup = hub();
    const account = markup.slice(markup.indexOf('id="es-s-account"'), markup.indexOf('id="es-s-ai"'));
    expect(account).toContain('<div class="es-row es-row--me">');
    expect(markup).not.toContain('href="/account"');
    expect(markup).not.toContain("名前を再取得");
    expect(account).toContain('<span class="es-av" aria-hidden="true">合</span>');
    expect(account).toContain("<b>合成の名前</b><small>synthetic@example.invalid</small>");
    const destinations = markup.slice(markup.indexOf('id="es-s-destinations"'), markup.indexOf('id="es-s-ai"'));
    expect(destinations).toMatch(/href="\/destinations\/experience"[^>]*>[\s\S]*?NIHO Experience[\s\S]*?未接続/);
    expect(destinations).toMatch(/href="\/destinations\/11111111-2222-4333-8444-555555555555"[^>]*>[\s\S]*?synthetic.example[\s\S]*?接続済み/);
    expect(destinations).toMatch(/href="\/destinations"[^>]*>[\s\S]*?発信先を追加・管理/);
    const nameless = hub({ account: { name: " ", caption: "", initial: "?" } });
    expect(nameless).toContain("<b>名前を取得できません</b></span>");
    // ログアウトはデータの群の後ろ（いちばん下）
    expect(markup.indexOf('class="es-logout"')).toBeGreaterThan(markup.indexOf('id="es-s-data"'));
    expect(textOf(markup.slice(markup.indexOf('class="es-logout"')))).toContain("ログアウト");
  });

  it("shows role as disconnected and only unavailable as a connection error", () => {
    expect(textOf(hub())).toContain("NIHO Experience 未接続");
    const failed = hub({ destinations: { faces: [{ id: "exp", label: "NIHO Experience", available: false, reason: "unavailable" }], sites: [] } });
    expect(textOf(failed)).toContain("NIHO Experience 接続を確認できません");
    expect(textOf(failed)).not.toContain("NIHO Experience 未接続");
  });

  it("links the rows to the detail pages", () => {
    const markup = hub();
    expect(markup).toContain('href="/settings/about"');
    expect(markup).toContain('href="/settings/terms"');
    for (const recipe of RECIPES) expect(markup).toContain(`href="/settings/recipes/${recipe.id}"`);
  });

  it("summarises あなたについて and the first four 固有名詞 with the rest counted", () => {
    const shown = textOf(hub());
    expect(shown).toContain("合成の呼び名 · 合成の自己紹介です。");
    expect(shown).not.toContain("二行目");
    expect(shown).toContain("北鎌倉 · 円覚寺 · 材木座 · 由比ヶ浜");
    expect(shown).toContain("＋2");
    const empty = textOf(hub({ aboutName: "", about: "", glossary: [] }));
    expect(empty).toContain(EDITOR_SETTINGS_TEXT.aboutEmpty);
    expect(empty).toContain(EDITOR_SETTINGS_TEXT.empty);
  });

  it("saves the 提案の言語 in place with a pressed state", () => {
    const markup = hub({ aiLang: "en" });
    expect(markup).toContain('aria-label="提案の言語"');
    expect(markup).toMatch(/aria-pressed="true"[^>]*>English</);
    expect(markup).toMatch(/aria-pressed="false"[^>]*>書いた言語のまま</);
  });

  it("tags an edited default and a recipe the owner made, and says why a recipe cannot run", () => {
    const shown = textOf(hub());
    expect(shown).toContain("文字起こし › 文字起こし修正 › 記事方針");
    expect(shown).toContain("変更あり");
    expect(shown).toContain("自分で作成");
    expect(shown).toContain("実行できません: 「議事録」の指示が空です。");
  });

  it("offers 手順を追加 only under the limit", () => {
    expect(hub()).toContain("手順を追加");
    expect(hub({ canAddRecipe: false })).not.toContain("手順を追加");
    expect(hub()).not.toContain("20 つまで");
  });

  it("shows the month's usage with a bar, and keeps the warning visible in the row (never only inside ⓘ)", () => {
    const markup = hub();
    const shown = textOf(markup);
    expect(shown).toContain("$0.42 / $5.00");
    expect(markup).toContain('class="es-bar"');
    expect(markup).toContain("width:8%");
    expect(shown).toContain("2026-10");
    expect(shown).not.toContain(EDITOR_SETTINGS_TEXT.nearLimit);
    const near = hub({ usage: { ...hubProps().usage!, costUsd: 4.2, nearLimit: true } });
    expect(near).toMatch(/role="alert"[^>]*>今月の上限に近づいています/);
    expect(near.indexOf(EDITOR_SETTINGS_TEXT.nearLimit)).toBeLessThan(near.indexOf("送った 128,400"));
    expect(textOf(hub({ usage: { ...hubProps().usage!, costUsd: 5, nearLimit: true } }))).toContain(EDITOR_SETTINGS_TEXT.overLimit);
    // 上限が無いときは棒を出さない。小さい額を 0 にしない
    const unlimited = hub({ usage: { ...hubProps().usage!, costUsd: 0.0004, limitUsd: null } });
    expect(unlimited).not.toContain('class="es-bar"');
    expect(textOf(unlimited)).toContain("$0.0004");
    expect(textOf(hub({ usage: null, usageNote: "使用量を読めませんでした" }))).toContain("使用量を読めませんでした");
  });

  it("shows the media capacity, and puts the storage facts in the ⓘ disclosure", () => {
    const markup = hub();
    const shown = textOf(markup);
    expect(shown).toContain("1 GiB");
    expect(shown).toContain("画像 1 GiB · 音声 4 KiB");
    expect(shown).toContain("30 日で消えます（文字起こしとページは残ります）");
    expect(shown).toContain("2 GiB・6 時間まで");
    expect(shown).toContain(EDITOR_SETTINGS_TEXT.cloud);
    expect(shown).toContain(EDITOR_SETTINGS_TEXT.counted);
    const stale = textOf(hub({ storageUsage: null, storageUsageNote: "メディア容量を読み込めませんでした" }));
    expect(stale).toContain("メディア容量を読み込めませんでした");
    expect(stale).not.toContain("画像 1 GiB");
  });

  it("opens the ⓘ disclosures under the row (aria-expanded + aria-controls, closed at first)", () => {
    const markup = hub();
    for (const label of ["使用量の内訳", "保存とデータについて"]) {
      const attrs = buttonAttrs(markup, label);
      expect(attrs).toContain('aria-expanded="false"');
      const controls = /aria-controls="([^"]+)"/.exec(attrs ?? "")?.[1];
      expect(controls).toBeTruthy();
      expect(markup).toMatch(new RegExp(`id="${controls!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*hidden`));
    }
  });

  it("names every button and dims (never disables) while saving", () => {
    expect(unlabeledButtons(hub())).toEqual([]);
    expect(unlabeledInputs(hub())).toEqual([]);
    const busy = hub({ busy: true });
    expect(buttonAttrs(busy, "手順を追加")).toContain('aria-disabled="true"');
    expect(busy).not.toMatch(/<button[^>]*\sdisabled=""/);
  });
});

describe("設定内の名前の再取得", () => {
  it("returns to settings through a same-account login when recovery is available", () => {
    const markup = hub({ account: { name: "名前を取得できません", caption: "", initial: "?" }, refreshIdentity: true });
    expect(markup).toMatch(/href="\/auth\/login\/start\?next=%2Fsettings&amp;sameAccount=1"[\s\S]*?名前を再取得/);
    expect(markup).not.toContain('href="/account"');
    expect(hub({ account: { name: "名前を取得できません", caption: "", initial: "?" } })).not.toContain("名前を再取得");
  });

  it("keeps the identity mismatch explanation on settings", () => {
    expect(hub({ identityMismatch: true })).toMatch(/role="alert">NIHO で選んだアカウントが現在の原稿のアカウントと異なるため、接続を変更しませんでした。/);
  });
});

describe("EditorSettingsAboutPage（/settings/about）", () => {
  it("has the back link, the two fields with counters, and やめる / 保存", () => {
    const markup = aboutPage();
    const shown = textOf(markup);
    expect(markup).toContain('href="/settings"');
    expect(markup).toContain(">あなたについて</h1>");
    expect(shown).toContain(EDITOR_SETTINGS_TEXT.aboutSub);
    expect(markup).toMatch(/<label[^>]*>呼び名<\/label>/);
    expect(markup).toMatch(/<label[^>]*>説明と書き方の希望<\/label>/);
    expect(shown).toContain("9 / 2,000 字");
    expect(markup).toContain('aria-label="あなたについてを保存"');
    expect(unlabeledInputs(markup)).toEqual([]);
    expect(unlabeledButtons(markup)).toEqual([]);
  });

  it("does not let a text over the limit be saved", () => {
    const over = aboutPage({ value: { name: "", text: "あ".repeat(2_001) } });
    expect(textOf(over)).toContain("説明と書き方の希望が長すぎるので保存できません");
    expect(buttonAttrs(over, "あなたについてを保存")).toContain('aria-disabled="true"');
    expect(buttonAttrs(aboutPage(), "あなたについてを保存")).not.toContain("aria-disabled");
  });
});

describe("公開用の著者紹介（/settings/author）", () => {
  it("adds a row to アカウント only when the host passes the profile, summarising it or saying it is empty", () => {
    expect(hub()).not.toContain('href="/settings/author"');
    const markup = hub({ author: { role: "合成の案内人", bio: "海辺の朝を書きます。\n二行目" } });
    const account = markup.slice(markup.indexOf('id="es-s-account"'), markup.indexOf('id="es-s-ai"'));
    expect(account).toMatch(/href="\/settings\/author"[^>]*>[\s\S]*?公開用の著者紹介/);
    expect(textOf(account)).toContain("合成の案内人 · 海辺の朝を書きます。");
    expect(textOf(account)).not.toContain("二行目");
    expect(textOf(hub({ author: { role: null, bio: null } }))).toContain(EDITOR_SETTINGS_TEXT.authorEmpty);
  });

  it("has the back link, two labelled fields with counters, and やめる / 保存", () => {
    const markup = authorPage();
    const shown = textOf(markup);
    expect(markup).toContain('href="/settings"');
    expect(markup).toContain(">公開用の著者紹介</h1>");
    expect(shown).toContain(EDITOR_SETTINGS_TEXT.authorSub);
    expect(markup).toMatch(/<label[^>]*>肩書<\/label>/);
    expect(markup).toMatch(/<label[^>]*>紹介文<\/label>/);
    expect(shown).toContain("6 / 120 字");
    expect(shown).toContain("10 / 600 字");
    expect(markup).toContain('aria-label="公開用の著者紹介を保存"');
    expect(unlabeledInputs(markup)).toEqual([]);
    expect(unlabeledButtons(markup)).toEqual([]);
  });

  it("does not let a role or bio over the limit be saved, and says why in words", () => {
    const role = authorPage({ value: { role: "あ".repeat(121), bio: "" } });
    expect(textOf(role)).toContain("肩書が長すぎるので保存できません");
    expect(buttonAttrs(role, "公開用の著者紹介を保存")).toContain('aria-disabled="true"');
    const bio = authorPage({ value: { role: "", bio: "あ".repeat(601) } });
    expect(textOf(bio)).toContain("紹介文が長すぎるので保存できません");
    expect(buttonAttrs(authorPage(), "公開用の著者紹介を保存")).not.toContain("aria-disabled");
  });
});

describe("EditorSettingsTermsPage（/settings/terms）", () => {
  it("lists 表記 | よみ | 誤りやすい表記 as rows that open in place", () => {
    const markup = termsPage();
    const shown = textOf(markup);
    expect(markup).toContain(">固有名詞</h1>");
    expect(shown).toContain(`${EDITOR_SETTINGS_TEXT.termsSub} · 2 語 / 200 語`);
    // 行の名前は見える文字＋見えない「を編集」（aria-label で短くしない。WCAG 2.5.3）
    expect(markup).toMatch(/<button type="button" class="es-row es-row--term"><span class="es-tm-t">北鎌倉<\/span>/);
    expect(markup).toContain('<span class="es-vh">を編集</span>');
    expect(shown).toContain("北鎌 · きた鎌倉");
    expect(markup).toContain('aria-label="固有名詞を追加"');
    expect(unlabeledButtons(markup)).toEqual([]);
  });

  it("turns one row into labelled fields with やめる / 削除 / 保存, and refuses an empty 表記", () => {
    const markup = termsPage({ editing: { index: 0, draft: { term: "北鎌倉", reading: "きたかまくら", variants: "北鎌・", note: "" } } });
    for (const label of ["表記", "よみ", "誤りやすい表記（「・」で区切る）", "補足"]) expect(markup).toMatch(new RegExp(`<label[^>]*>${label.replace(/[()]/g, "\\$&")}</label>`));
    // 打ったままの文字列（区切りが残る）
    expect(markup).toContain('value="北鎌・"');
    expect(markup).toContain('aria-label="固有名詞の編集をやめる"');
    expect(markup).toContain('aria-label="北鎌倉を削除"');
    expect(markup).not.toContain('<span class="es-tm-t">北鎌倉</span>');
    expect(unlabeledInputs(markup)).toEqual([]);
    expect(unlabeledButtons(markup)).toEqual([]);
    const empty = termsPage({ editing: { index: null, draft: { term: "", reading: "", variants: "", note: "" } } });
    expect(textOf(empty)).toContain(EDITOR_SETTINGS_TEXT.termEmpty);
    expect(buttonAttrs(empty, "固有名詞を保存")).toContain('aria-disabled="true"');
    // 足している行には削除が無い
    expect(empty).not.toMatch(/aria-label="[^"]*を削除"/);
  });
});

describe("EditorSettingsRecipePage（/settings/recipes/{id}）", () => {
  const [article, minutes, talk] = RECIPES as [EditorSettingsRecipe, EditorSettingsRecipe, EditorSettingsRecipe];

  it("has the back link, the name as the heading input, the ⋯ menu, and the kind of recipe", () => {
    const markup = recipePage(minutes);
    expect(markup).toContain('href="/settings"');
    expect(markup).toMatch(/<h1><input[^>]*aria-label="手順の名前"[^>]*value="議事録"/);
    expect(markup).toContain('aria-label="手順のメニュー"');
    const shown = textOf(markup);
    expect(shown).toContain("既定の手順");
    expect(shown).toContain("変更あり");
    expect(shown).toContain("実行できません: 「議事録」の指示が空です。");
    expect(textOf(recipePage(talk))).toContain("自分で作成");
    expect(textOf(recipePage(minutes, { nameError: "この手順名はほかの手順と重複しています。" }))).toContain("重複しています");
  });

  it("offers 複製 / 既定に戻す / 削除 in the menu by kind (a default cannot be removed)", () => {
    const ids = (items: ReturnType<typeof recipeMenuItems>) => items.map((item) => `${item.id}${item.disabled ? "(off)" : ""}`);
    expect(ids(recipeMenuItems(article, true))).toEqual(["duplicate", "remove(off)"]);
    expect(ids(recipeMenuItems(minutes, true))).toEqual(["duplicate", "reset", "remove(off)"]);
    expect(recipeMenuItems(minutes, true).find((item) => item.id === "remove")?.hint).toBe("既定の手順");
    expect(ids(recipeMenuItems(talk, true))).toEqual(["duplicate", "remove"]);
    expect(ids(recipeMenuItems(talk, false))).toEqual(["duplicate(off)", "remove"]);
  });

  it("lists the stages with their first line and weight, and a ⋯ per stage that only reorders a default", () => {
    const markup = recipePage(article);
    const shown = textOf(markup);
    expect(markup).toMatch(/<button type="button" class="es-row-main">.*?<span class="es-vh">段階 1<\/span><b>文字起こし修正<\/b>.*?<span class="es-vh">を開く<\/span><\/button>/);
    expect(markup).toContain('aria-label="段階 2 のメニュー"');
    expect(shown).toContain("読みやすく整える。");
    expect(shown).not.toContain("次の行");
    expect(shown).toContain("軽量");
    expect(shown).toContain("高性能");
    const ids = (items: ReturnType<typeof stepMenuItems>) => items.map((item) => `${item.id}${item.disabled ? "(off)" : ""}`);
    expect(ids(stepMenuItems(0, 2, true, 12))).toEqual(["up(off)", "down"]);
    expect(ids(stepMenuItems(1, 2, true, 12))).toEqual(["up", "down(off)"]);
    expect(ids(stepMenuItems(0, 2, false, 12))).toEqual(["up(off)", "down", "duplicate", "remove"]);
    expect(ids(stepMenuItems(0, 1, false, 12))).toEqual(["up(off)", "down(off)", "duplicate"]);
    expect(ids(stepMenuItems(0, 12, false, 12))).toEqual(["up(off)", "down", "duplicate(off)", "remove"]);
  });

  it("says a default cannot change its number of stages and offers 複製して足す; a custom one offers 段階を追加", () => {
    const fixed = textOf(recipePage(article));
    expect(fixed).toContain(EDITOR_SETTINGS_TEXT.fixedSteps);
    expect(fixed).toContain("複製して足す");
    expect(fixed).not.toContain("段階を追加");
    const custom = textOf(recipePage(talk));
    expect(custom).toContain("段階を追加");
    expect(custom).not.toContain("複製して足す");
    expect(textOf(recipePage(talk, { maxSteps: 1 }))).not.toContain("段階を追加");
  });

  it("shows the 文書ガイド as a card with its length, with an ⓘ disclosure", () => {
    const markup = recipePage(article);
    expect(markup).toContain('<button type="button" class="es-gcard"><span class="es-vh">文書ガイド</span>');
    expect(markup).toContain("es-gcard-t");
    expect(textOf(markup)).toContain(`${Array.from(article.guide).length} 字`);
    expect(buttonAttrs(markup, "文書ガイドとは")).toContain('aria-expanded="false"');
    expect(textOf(recipePage(talk))).toContain(EDITOR_SETTINGS_TEXT.guideEmpty);
  });

  it("lists the お手本 with their size, truncation and source, each removable, and 取り込む last", () => {
    const markup = recipePage(talk, { extraction: { sampleIds: ["sample-1"], guide: "## 抽出", candidates: [] } });
    const shown = textOf(markup);
    expect(shown).toContain("8,200 字");
    expect(shown).toContain("30,000 字 · 元の文書は 41,000 字 · URL から");
    expect(markup).toContain('aria-label="朝市レポート.md を外す"');
    expect(shown).toContain("文書ガイドを抽出");
    expect(shown).toContain("抽出した案があります");
    expect(markup).toContain('aria-label="抽出した案を見る"');
    expect(shown).toContain("取り込む");
    // お手本が無ければ抽出は出さない
    expect(textOf(recipePage(article))).not.toContain("文書ガイドを抽出");
    // お手本の名前は変えられない（ファイル名・URL から決まる）
    expect(markup).not.toMatch(/<input[^>]*value="朝市レポート.md"/);
  });

  it("uses the same term rows for この手順だけの固有名詞, with 追加 at the end", () => {
    const markup = recipePage(talk);
    expect(markup).toContain('aria-label="この手順だけの固有名詞"');
    expect(markup).toContain('<span class="es-tm-t">鎌倉ひとはこ</span>');
    expect(markup).toContain('aria-label="この手順だけの固有名詞とは"');
    expect(textOf(markup)).toContain("追加");
  });

  const sheets: [string, EditorRecipeSheet, string[]][] = [
    ["段階", { kind: "step", index: 0, draft: { ...article.steps[0]! } }, ["名前", "指示"]],
    ["新しい段階", { kind: "step", index: null, draft: { id: "s-new", name: "新しい段階", instruction: "", profile: "standard" } }, ["名前", "指示"]],
    ["文書ガイド", { kind: "guide", draft: article.guide }, ["文書ガイド"]],
    ["取り込み", { kind: "import", file: null, url: "" }, ["ファイル（Markdown・テキスト・Word・PDF）", "公開 Web ページの URL"]],
    ["抽出", { kind: "extract" }, ["抽出された文書ガイド"]],
  ];
  for (const [name, sheet, labels] of sheets) {
    it(`renders the ${name} sheet as a labelled dialog with named controls`, () => {
      const markup = recipePage(talk, {
        sheet,
        extraction: { sampleIds: ["sample-1"], guide: "## 抽出", candidates: [{ term: "朝市", reading: "あさいち", variants: [], note: "" }] },
        selectedExtractionTerms: ["朝市:0"],
      });
      expect(markup).toMatch(/role="dialog" aria-modal="true" aria-label="[^"]+"/);
      for (const label of labels) expect(markup).toMatch(new RegExp(`<label[^>]*>${label.replace(/[()]/g, "\\$&")}</label>`));
      expect(unlabeledInputs(markup)).toEqual([]);
      expect(unlabeledButtons(markup)).toEqual([]);
    });
  }

  it("the stage sheet: position, weight, live counter, hint and validation that blocks 保存", () => {
    const sheet: EditorRecipeSheet = { kind: "step", index: 1, draft: { ...article.steps[1]! } };
    const markup = recipePage(article, { sheet });
    const shown = textOf(markup);
    expect(shown).toContain("段階 2 / 2 · 記事制作");
    expect(markup).toContain("es-sheet--edit");
    expect(markup).toContain("es-veil--edit");
    expect(markup).toContain('aria-label="重さ"');
    expect(markup).toMatch(/aria-pressed="true"[^>]*>高性能</);
    expect(shown).toContain("7 字");
    expect(shown).toContain(EDITOR_SETTINGS_TEXT.stepHint);
    expect(buttonAttrs(markup, "段階を保存")).not.toContain("aria-disabled");
    const invalid = recipePage(article, { sheet, stepErrors: { instruction: "指示を書いてください。" } });
    expect(textOf(invalid)).toContain("指示を書いてください。");
    expect(buttonAttrs(invalid, "段階を保存")).toContain('aria-disabled="true"');
  });

  it("the import sheet: accept list, the one sentence, and 取り込む only with a file or URL", () => {
    const markup = recipePage(talk, { sheet: { kind: "import", file: null, url: "" } });
    expect(markup).toContain('accept=".md,.txt,.docx,.pdf"');
    expect(textOf(markup)).toContain(EDITOR_SETTINGS_TEXT.importNote);
    expect(buttonAttrs(markup, "取り込む")).toContain('aria-disabled="true"');
    expect(buttonAttrs(recipePage(talk, { sheet: { kind: "import", file: null, url: "https://example.invalid" } }), "取り込む")).not.toContain("aria-disabled");
  });

  it("the extraction sheet: replace the guide and add chosen terms, nothing applied by itself", () => {
    const markup = recipePage(talk, {
      sheet: { kind: "extract" },
      extraction: { sampleIds: ["sample-1"], guide: "## 抽出", candidates: [{ term: "朝市", reading: "あさいち", variants: [], note: "" }] },
      selectedExtractionTerms: [],
    });
    const shown = textOf(markup);
    expect(shown).toContain("文書ガイドに置き換える");
    expect(shown).toContain("朝市（あさいち）");
    expect(shown).toContain(EDITOR_SETTINGS_TEXT.extractNote);
    expect(buttonAttrs(markup, "選んだ固有名詞を追加")).toContain('aria-disabled="true"');
  });

  it("names every button and labels every field, and dims while saving", () => {
    for (const recipe of RECIPES) {
      const markup = recipePage(recipe);
      expect(unlabeledButtons(markup)).toEqual([]);
      expect(unlabeledInputs(markup)).toEqual([]);
    }
    const busy = recipePage(talk, { busy: true });
    expect(buttonAttrs(busy, "朝市レポート.md を外す")).toContain('aria-disabled="true"');
    expect(buttonAttrs(busy, "文書ガイドを抽出")).toContain('aria-disabled="true"');
    expect(busy).not.toMatch(/<button[^>]*\sdisabled=""/);
  });
});
