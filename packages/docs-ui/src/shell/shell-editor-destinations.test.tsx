import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EDITOR_DESTINATIONS_TEXT,
  EditorDestinationsPage,
  EditorSitePage,
  type EditorDestinationFace,
  type EditorDestinationSite,
  type EditorDestinationsPageProps,
  type EditorSitePageProps,
  type EditorSitePublished,
} from "./index";

/** editor-web の発信先の設定（#41）。鍵は 1 回だけ出し、ほかの場所には伏せ字しか出さない。 */

const noop = () => undefined;
// 合成の値だけを使う（鍵の形だけが要るところは、鍵でない文字列を使う）
const PLAINTEXT = "ek_synthetic-plaintext-key-value-not-a-real-key";
const MASKED = "ek_••••••••3f9a";

const FACES: EditorDestinationFace[] = [
  { id: "exp", label: "NIHO Experience", host: "experience.niho.life", path: "guides", who: "旅行者向け · 英語", role: "ライター", available: true, reason: null, published: 2 },
  { id: "niho", label: "NIHO", host: null, path: null, who: "鎌倉の人向け", role: "NIHO アカウント", available: false, reason: "role", published: 0 },
];

const SITES: EditorDestinationSite[] = [
  { id: "11111111-2222-4333-8444-555555555555", handle: "mika-sato", host: "mika-sato.example", path: "posts", mode: "api", published: 1 },
  { id: "22222222-3333-4444-8555-666666666666", handle: "mika-note", host: "note.mika-sato.example", path: "", mode: "wordpress", published: 0 },
];

function destProps(patch: Partial<EditorDestinationsPageProps> = {}): EditorDestinationsPageProps {
  return {
    status: "",
    busy: false,
    faces: FACES,
    sites: SITES,
    onOpenFace: noop,
    onOpenSite: noop,
    draft: null,
    onAdd: noop,
    onDraft: noop,
    onCancelAdd: noop,
    onCreate: noop,
    issuedKey: null,
    onCopyKey: noop,
    onCloseKey: noop,
    onNavigate: noop,
    ...patch,
  };
}

const PUBLISHED: EditorSitePublished[] = [
  { pageId: "p1", title: "Kamakura morning walk", url: "https://mika-sato.example/posts/kamakura-morning-walk", status: "published" },
  { pageId: "p2", title: "Asaichi", url: "https://mika-sato.example/posts/asaichi", status: "stopped" },
];

function siteProps(patch: Partial<EditorSitePageProps> = {}): EditorSitePageProps {
  return {
    status: "",
    busy: false,
    handle: "mika-sato",
    host: "mika-sato.example",
    path: "posts",
    mode: "api",
    apiUrl: "https://api.editor.niho.life/v1/mika-sato/published.json",
    articleUrl: "https://mika-sato.example/posts/{slug}",
    keys: [{ id: "k2", masked: MASKED, createdAt: "2026-10-30T00:00:00.000Z", active: true }],
    published: PUBLISHED,
    urlDraft: null,
    onBack: noop,
    onCopyApi: noop,
    onEditUrl: noop,
    onUrlDraft: noop,
    onCancelUrl: noop,
    onSaveUrl: noop,
    onMode: noop,
    onExport: noop,
    confirmingKey: false,
    onAskKey: noop,
    onCancelKey: noop,
    onRotateKey: noop,
    issuedKey: null,
    onCopyKey: noop,
    onCloseKey: noop,
    confirmingDisconnect: false,
    onAskDisconnect: noop,
    onCancelDisconnect: noop,
    onDisconnect: noop,
    ...patch,
  };
}

const destHtml = (patch: Partial<EditorDestinationsPageProps> = {}) => renderToStaticMarkup(<EditorDestinationsPage {...destProps(patch)} />);
const siteHtml = (patch: Partial<EditorSitePageProps> = {}) => renderToStaticMarkup(<EditorSitePage {...siteProps(patch)} />);
const plain = (markup: string) => markup.replace(/<[^>]*>/g, " ");

function unlabeledButtons(markup: string): string[] {
  return [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attrs, inner]) => !/aria-label="[^"]+"/.test(attrs ?? "") && (inner ?? "").replace(/<[^>]*>/g, "").trim() === "")
    .map(([whole]) => whole.slice(0, 80));
}

function unlabeledInputs(markup: string): string[] {
  return [...markup.matchAll(/<(input|textarea)\b([^>]*?)>/g)]
    .filter(([, , attrs]) => {
      const id = /\bid="([^"]+)"/.exec(attrs ?? "")?.[1];
      return !id || !new RegExp(`<label[^>]*for="${id}"`).test(markup);
    })
    .map(([whole]) => whole.slice(0, 80));
}

describe("EditorDestinationsPage", () => {
  it("has 「← 設定」 above the heading (a link to /settings)", () => {
    const markup = destHtml();
    expect(markup).toMatch(/<a class="es-back" href="\/settings">[\s\S]*?設定<\/a><h1>発信先<\/h1>/);
  });

  it("lists faces and sites with only their normal connection state", () => {
    const shown = plain(destHtml());
    expect(shown).toContain("NIHO Experience");
    expect(shown).toContain("接続済み");
    expect(shown).toContain("未接続");
    expect(shown).not.toContain("experience.niho.life/guides");
    expect(shown).not.toContain("公開中 2");
    expect(shown).not.toContain(EDITOR_DESTINATIONS_TEXT.noRole);
    expect(shown).not.toContain("mika-sato.example/posts");
    expect(shown).toContain("note.mika-sato.example");
    expect(destHtml()).toContain('aria-label="NIHO Experience の詳細"');
    expect(destHtml()).toContain('aria-label="mika-sato.example の設定"');
  });

  it("says いまは公開できません for a face whose conditions cannot be read", () => {
    const shown = plain(destHtml({ faces: [{ ...FACES[0]!, available: false, reason: "unavailable", host: null, path: null }] }));
    expect(shown).toContain("接続を確認できません");
    expect(shown).not.toContain("未接続");
  });

  it("offers 発信先を追加 until the form is open, and then the form instead", () => {
    expect(destHtml()).toContain(EDITOR_DESTINATIONS_TEXT.addTitle);
    const open = destHtml({ draft: { mode: "api", handle: "", siteUrl: "https://", path: "" } });
    expect(open).toContain("handle（公開 API の URL に入る）");
    expect(open).toContain("サイトの URL（https）");
    expect(open).toContain(EDITOR_DESTINATIONS_TEXT.handleFixed);
    expect(open).toContain('aria-label="この発信先を追加"');
    expect(open).not.toContain("es-dcard--add");
  });

  it("says that WordPress and Ghost cannot push yet, only when one is chosen", () => {
    expect(plain(destHtml({ draft: { mode: "api", handle: "x", siteUrl: "https://x.example", path: "" } }))).not.toContain(EDITOR_DESTINATIONS_TEXT.pushLater);
    expect(plain(destHtml({ draft: { mode: "ghost", handle: "x", siteUrl: "https://x.example", path: "" } }))).toContain(EDITOR_DESTINATIONS_TEXT.pushLater);
  });

  it("shows a new key once, with its own copy and close", () => {
    const markup = destHtml({ issuedKey: { masked: MASKED, plaintext: PLAINTEXT } });
    expect(markup).toContain(PLAINTEXT);
    expect(plain(markup)).toContain(EDITOR_DESTINATIONS_TEXT.keyOnce);
    expect(markup).toContain('aria-label="新しい鍵をコピー"');
    expect(markup).toContain('aria-label="新しい鍵を閉じる"');
    // 閉じたら平文はどこにも残らない
    expect(destHtml()).not.toContain(PLAINTEXT);
  });
});

describe("EditorSitePage", () => {
  it("shows the 公開API URL, the masked key and the handle, never a plaintext key", () => {
    const markup = siteHtml();
    expect(markup).toContain("https://api.editor.niho.life/v1/mika-sato/published.json");
    expect(markup).toContain(MASKED);
    expect(markup).not.toContain(PLAINTEXT);
    expect(markup).toContain('aria-label="公開APIの URL をコピー"');
    expect(markup).toContain('aria-label="鍵を再発行"');
    expect(plain(markup)).toContain(EDITOR_DESTINATIONS_TEXT.handleFixed);
  });

  it("asks before re-issuing the key, and says what it costs", () => {
    const markup = siteHtml({ confirmingKey: true });
    expect(plain(markup)).toContain(EDITOR_DESTINATIONS_TEXT.keyConfirm);
    expect(markup).toContain('aria-label="鍵を再発行する"');
    expect(markup).toContain('aria-label="鍵の再発行をやめる"');
    // 確かめている間は「再発行」を出さない（二度押しを作らない）
    expect(markup).not.toContain('aria-label="鍵を再発行"');
  });

  it("counts the revoked keys without showing them", () => {
    const markup = siteHtml({
      keys: [
        { id: "k3", masked: MASKED, createdAt: "2026-10-31T00:00:00.000Z", active: true },
        { id: "k2", masked: "ek_••••••••1111", createdAt: "2026-10-30T00:00:00.000Z", active: false },
      ],
    });
    expect(plain(markup)).toContain("失効した鍵 1");
  });

  it("shows the URL shape, the photo rule, and the export", () => {
    const shown = plain(siteHtml());
    expect(shown).toContain("https://mika-sato.example/posts/{slug}");
    expect(shown).toContain(EDITOR_DESTINATIONS_TEXT.photos);
    expect(shown).toContain("Markdown + 写真（zip）");
    expect(shown).toContain(EDITOR_DESTINATIONS_TEXT.exportHint);
  });

  it("edits the URL shape in the page and says when it starts to count", () => {
    const markup = siteHtml({ urlDraft: { host: "mika-sato.example", path: "journal" } });
    expect(markup).toContain("ホスト");
    expect(markup).toContain('aria-label="URL の形を保存"');
    expect(plain(markup)).toContain("次の「更新を公開」から");
    expect(markup).not.toContain('aria-label="URL の形を編集"');
  });

  it("lists the pages on the site with their state, and says so when there are none", () => {
    const shown = plain(siteHtml());
    expect(shown).toContain("Kamakura morning walk");
    expect(shown).toContain("公開中");
    expect(shown).toContain("公開をやめた");
    expect(plain(siteHtml({ published: [] }))).toContain(EDITOR_DESTINATIONS_TEXT.noPublished);
  });

  it("asks before disconnecting, and says that the live pages stop", () => {
    expect(siteHtml()).toContain("接続を解除");
    const markup = siteHtml({ confirmingDisconnect: true });
    expect(plain(markup)).toContain(EDITOR_DESTINATIONS_TEXT.disconnectConfirm);
    expect(markup).toContain('aria-label="接続を解除する"');
    expect(markup).toContain('aria-label="接続の解除をやめる"');
  });

  it("names every button and labels every field, in every state", () => {
    for (const patch of [
      {},
      { confirmingKey: true },
      { confirmingDisconnect: true },
      { urlDraft: { host: "h", path: "p" } },
      { issuedKey: { masked: MASKED, plaintext: PLAINTEXT } },
      { published: [] },
      { mode: "ghost" as const },
    ] satisfies Partial<EditorSitePageProps>[]) {
      const markup = siteHtml(patch);
      expect(unlabeledButtons(markup), JSON.stringify(Object.keys(patch))).toEqual([]);
      expect(unlabeledInputs(markup), JSON.stringify(Object.keys(patch))).toEqual([]);
    }
    for (const patch of [{}, { draft: { mode: "api" as const, handle: "", siteUrl: "", path: "" } }, { issuedKey: { masked: MASKED, plaintext: PLAINTEXT } }] satisfies Partial<EditorDestinationsPageProps>[]) {
      const markup = destHtml(patch);
      expect(unlabeledButtons(markup), JSON.stringify(Object.keys(patch))).toEqual([]);
      expect(unlabeledInputs(markup), JSON.stringify(Object.keys(patch))).toEqual([]);
    }
  });

  it("does nothing while busy, without disabling the buttons", () => {
    const markup = siteHtml({ busy: true, status: "送っています…" });
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("送っています…");
    expect(markup).not.toMatch(/<button[^>]*\sdisabled/);
  });
});
