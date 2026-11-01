import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EDITOR_SETTINGS_TEXT, EditorSettingsPage, type EditorSettingsPageProps, type EditorSettingsRecipe } from "./index";

/** editor-web の設定（#108）。モック v6 の V.settings の語彙で、Web で本当に出せる項目だけを出す。 */

const noop = () => undefined;

const RECIPES: EditorSettingsRecipe[] = [
  { id: "tpl-1", name: "記事制作", guide: "## 構成", steps: [{ id: "k7m2q9xa", name: "文字起こし修正", instruction: "整える。" }], isDefault: true, modified: false },
  { id: "tpl-2", name: "議事録", guide: "", steps: [{ id: "d9c3x7mf", name: "議事録", instruction: "" }], isDefault: true, modified: true },
  { id: "r-talk", name: "対談", guide: "", steps: [{ id: "s-1", name: "まとめ", instruction: "" }], isDefault: false, modified: false },
];

function props(patch: Partial<EditorSettingsPageProps> = {}): EditorSettingsPageProps {
  return {
    status: "",
    busy: false,
    aiLang: "same",
    onAiLang: noop,
    glossary: [{ term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌"], note: "" }],
    termsDraft: null,
    onEditTerms: noop,
    onTermsDraft: noop,
    onCancelTerms: noop,
    onSaveTerms: noop,
    about: "合成の自己紹介です。",
    aboutDraft: null,
    onEditAbout: noop,
    onAboutDraft: noop,
    onCancelAbout: noop,
    onSaveAbout: noop,
    recipes: RECIPES,
    recipeDraft: null,
    onEditRecipe: noop,
    onRecipeDraft: noop,
    onCancelRecipe: noop,
    onSaveRecipe: noop,
    onDuplicateRecipe: noop,
    onResetRecipe: noop,
    onRemoveRecipe: noop,
    onAddRecipe: noop,
    newStepId: () => "s-new",
    usage: { month: "2026-10", inputTokens: 128400, outputTokens: 12900, costUsd: 0.42, limitUsd: 5, nearLimit: false },
    usageNote: null,
    transcription: { engine: "deepgram", timeoutSec: 1200, maxBytes: 2 * 1024 ** 3, maxDurationSec: 6 * 3600, retentionDays: 30, extensions: ["m4a", "mp3"] },
    storageUsage: { imageBytes: "1073741824", audioBytes: "4096", totalBytes: "1073745920" },
    storageUsageNote: null,
    limits: { glossary: 200, recipes: 20, steps: 12, aboutChars: 2_000 },
    ...patch,
  };
}

const html = (patch: Partial<EditorSettingsPageProps> = {}) => renderToStaticMarkup(<EditorSettingsPage {...props(patch)} />);
const text = (patch: Partial<EditorSettingsPageProps> = {}) => html(patch).replace(/<[^>]*>/g, " ");

/** ボタンはすべて、aria-label か見える文字を持つ。 */
function unlabeledButtons(markup: string): string[] {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attrs, inner]) => !/aria-label="[^"]+"/.test(attrs ?? "") && (inner ?? "").replace(/<[^>]*>/g, "").trim() === "")
    .map(([whole]) => whole.slice(0, 80));
}

/** 入力は、for が結ばれた label を持つ。 */
function unlabeledInputs(markup: string): string[] {
  return [...markup.matchAll(/<(input|textarea)\b([^>]*?)>/g)]
    .filter(([, , attrs]) => {
      const id = /\bid="([^"]+)"/.exec(attrs ?? "")?.[1];
      return !id || !new RegExp(`<label[^>]*for="${id}"`).test(markup);
    })
    .map(([whole]) => whole.slice(0, 80));
}

describe("EditorSettingsPage", () => {
  it("has the four sections of #108 and a status line", () => {
    const markup = html();
    for (const id of ["es-s-ai", "es-s-steps", "es-s-tr", "es-s-save"]) expect(markup).toContain(`id="${id}"`);
    expect(markup).toContain('role="status"');
    // モック v6 のプロフィールの節は持たない（NIHO アカウントの値）
    expect(markup).not.toContain("写真を変更");
  });

  it("shows the 文字起こし facts that 設計 §12 asks to spell out, and says the engine cannot be chosen here", () => {
    const shown = text();
    expect(shown).toContain("Deepgram");
    expect(shown).toContain(EDITOR_SETTINGS_TEXT.engineFixed);
    expect(shown).toContain("2 GiB");
    expect(shown).toContain("6 時間");
    expect(shown).toContain("20 分");
    expect(shown).toContain("30 日で消えます");
    expect(shown).toContain(EDITOR_SETTINGS_TEXT.geminiLater);
    expect(text({ transcription: { ...props().transcription, engine: "fake" } })).toContain(EDITOR_SETTINGS_TEXT.engineFake);
    expect(text({ transcription: { ...props().transcription, engine: "off", timeoutSec: null } })).toContain(EDITOR_SETTINGS_TEXT.engineOff);
  });

  it("shows the fixed NIHO cloud destination and media capacity with no quota", () => {
    const shown = text();
    expect(shown).toContain("NIHO クラウド");
    expect(shown).toContain("Web と Mac アプリで共通");
    expect(shown).toContain("1 GiB");
    expect(shown).toContain("画像 1 GiB・音声 4 KiB");
    expect(shown).toContain(EDITOR_SETTINGS_TEXT.cloudStorageFixed);
    expect(shown).toContain("容量上限は未設定です");
    expect(shown).not.toContain("この Mac だけ");
  });

  it("shows an error instead of retaining a stale storage value", () => {
    const shown = text({ storageUsage: null, storageUsageNote: "メディア容量を読み込めませんでした" });
    expect(shown).toContain("メディア容量を読み込めませんでした");
    expect(shown).not.toContain("画像 1 GiB");
  });

  it("shows the month's usage, and warns only when it is close to or past the limit", () => {
    const shown = text();
    expect(shown).toContain("$0.42 / $5.00");
    expect(shown).toContain("2026-10");
    expect(shown).not.toContain(EDITOR_SETTINGS_TEXT.nearLimit);
    expect(text({ usage: { ...props().usage!, costUsd: 4.2, nearLimit: true } })).toContain(EDITOR_SETTINGS_TEXT.nearLimit);
    expect(text({ usage: { ...props().usage!, costUsd: 5, nearLimit: true } })).toContain(EDITOR_SETTINGS_TEXT.overLimit);
    // 小さい額を 0 にしない
    expect(text({ usage: { ...props().usage!, costUsd: 0.0004, limitUsd: null } })).toContain("$0.0004");
    expect(text({ usage: null, usageNote: "使用量を読めませんでした" })).toContain("使用量を読めませんでした");
  });

  it("lists every 手順 with its 段階, marks an edited default, and offers 既定に戻す / 削除 accordingly", () => {
    const markup = html();
    expect(markup).toContain("文字起こし › 文字起こし修正");
    expect(markup).toContain("手を入れています");
    expect(markup).toContain('aria-label="記事制作を複製"');
    expect(markup).toContain('aria-label="議事録を既定に戻す"');
    expect(markup).toContain('aria-label="対談を削除"');
    // 手を入れていない既定は「既定に戻す」を出さない
    expect(markup).not.toContain('aria-label="記事制作を既定に戻す"');
    expect(markup).not.toContain('aria-label="記事制作を削除"');
  });

  it("hides 手順を追加 and 複製 once the limit is reached", () => {
    const markup = html({ limits: { glossary: 200, recipes: RECIPES.length, steps: 12, aboutChars: 2_000 } });
    expect(markup).not.toContain("手順を追加");
    expect(markup).not.toContain('aria-label="記事制作を複製"');
  });

  it("opens the 固有名詞 editor in the page, with a labelled field per column", () => {
    const markup = html({ termsDraft: [{ term: "北鎌倉", reading: "きたかまくら", variants: "北鎌・きた鎌倉", note: "駅名" }] });
    expect(markup).toContain("1 行目の表記");
    expect(markup).toContain("1 行目のよみ");
    expect(markup).toContain("1 行目の補足");
    // 誤りやすい表記は 1 欄に「・」で並ぶ（打ったままの文字列を出す）
    expect(markup).toContain('value="北鎌・きた鎌倉"');
    expect(markup).toContain('aria-label="固有名詞を保存"');
    expect(markup).toContain('aria-label="この行を削除（1 行目）"');
    // 編集しているあいだ、まとめの「編集」は出さない
    expect(markup).not.toContain('aria-label="固有名詞を編集"');
    expect(html({ termsDraft: [] })).toContain(EDITOR_SETTINGS_TEXT.empty);
  });

  it("keeps the 誤りやすい表記 field exactly as it was typed, separator and all", () => {
    // 区切りを打った途中・末尾の区切り・空白つきも、打ったまま出す（配列にして描き直すと「・」が消えて続きが前の語に繋がる）
    for (const typed of ["北鎌", "北鎌・", "北鎌・き", "北鎌 ・ きた鎌倉", "・"]) {
      expect(html({ termsDraft: [{ term: "北鎌倉", reading: "", variants: typed, note: "" }] }), typed).toContain(`value="${typed}"`);
    }
  });

  it("opens the 手順 editor, and lets a default change only its words (not the number of 段階)", () => {
    const base = RECIPES[0]!;
    const fixed = html({ recipeDraft: { ...base } });
    expect(fixed).toContain("手順の名前");
    expect(fixed).toContain("お手本（全部の段階に渡す文書ガイド）");
    expect(fixed).toContain("段階 1 の指示");
    expect(fixed).toContain(EDITOR_SETTINGS_TEXT.fixedSteps);
    expect(fixed).not.toContain("段階を追加");
    expect(fixed).not.toContain('aria-label="この段階を削除（段階 1）"');

    const added = html({ recipeDraft: { ...RECIPES[2]! } });
    expect(added).toContain("段階を追加");
    expect(added).not.toContain(EDITOR_SETTINGS_TEXT.fixedSteps);
    // 段階が 1 つだけのときは消させない（段階のない手順は実行できない）
    expect(added).not.toContain('aria-label="この段階を削除（段階 1）"');
    const two = { ...RECIPES[2]!, steps: [...RECIPES[2]!.steps, { id: "s-2", name: "下書き", instruction: "" }] };
    expect(html({ recipeDraft: two })).toContain('aria-label="この段階を削除（段階 1）"');
  });

  it("names every button and labels every field, in every state", () => {
    for (const patch of [
      {},
      { termsDraft: [{ term: "", reading: "", variants: "", note: "" }] },
      { recipeDraft: { ...RECIPES[0]! } },
      { recipeDraft: { ...RECIPES[2]! } },
      { usage: null, usageNote: "読めません" },
    ] satisfies Partial<EditorSettingsPageProps>[]) {
      const markup = html(patch);
      expect(unlabeledButtons(markup), JSON.stringify(Object.keys(patch))).toEqual([]);
      expect(unlabeledInputs(markup), JSON.stringify(Object.keys(patch))).toEqual([]);
    }
  });

  it("does nothing while busy, and says so on the buttons", () => {
    const onAddRecipe = vi.fn();
    const busy = html({ busy: true, status: "保存しています…", onAddRecipe });
    expect(busy).toContain('aria-disabled="true"');
    expect(busy).toContain("保存しています…");
    // disabled にはしない（フォーカスが外れる）
    expect(busy).not.toMatch(/<button[^>]*\sdisabled/);
  });
});

describe("「あなたについて」", () => {
  it("shows the summary and the editor, and says it is not the author information of a published page", () => {
    expect(text()).toContain("あなたについて");
    expect(text()).toContain("合成の自己紹介です。");
    const editing = text({ aboutDraft: "合成の自己紹介です。" });
    expect(editing).toContain(EDITOR_SETTINGS_TEXT.aboutHelp);
    expect(editing).toContain("2,000 字");
  });

  it("says when it is empty, and marks the save as not allowed when it is too long", () => {
    expect(text({ about: "" })).toContain(EDITOR_SETTINGS_TEXT.empty);
    const over = html({ aboutDraft: "あ".repeat(2_001) });
    expect(over).toContain("長すぎるので保存できません");
    expect(over).toMatch(/aria-label="あなたについてを保存"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*aria-label="あなたについてを保存"/);
  });

  it("keeps every button and input labelled", () => {
    const markup = html({ aboutDraft: "合成の自己紹介です。" });
    expect(unlabeledButtons(markup)).toEqual([]);
    expect(unlabeledInputs(markup)).toEqual([]);
  });

  /** gallery は型で守られていない（どの tsconfig にも入っていない）ので、渡し忘れても画面が落ちないこと。 */
  it("still renders when the caller does not pass it at all", () => {
    const without = props();
    for (const key of ["about", "aboutDraft", "onEditAbout", "onAboutDraft", "onCancelAbout", "onSaveAbout"]) {
      delete (without as unknown as Record<string, unknown>)[key];
    }
    delete (without.limits as unknown as Record<string, unknown>).aboutChars;
    const markup = renderToStaticMarkup(<EditorSettingsPage {...without} />);
    expect(markup).toContain("あなたについて");
    expect(markup).toContain(EDITOR_SETTINGS_TEXT.empty);
  });
});
