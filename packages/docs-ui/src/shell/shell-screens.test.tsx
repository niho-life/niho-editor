import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AccountPage,
  DestinationsPage,
  EditorShell,
  LoginScreen,
  PublishPreview,
  PublishSheet,
  SettingsPage,
  ShellHeader,
  SitePage,
  type DestinationRow,
  type PublishDestOption,
  type PublishFormProps,
} from "./index";

const noop = () => undefined;

/** ボタンはすべて、aria-label か見える文字を持つ。 */
function unlabeledButtons(html: string): string[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attrs, inner]) => !/aria-label="[^"]+"/.test(attrs ?? "") && (inner ?? "").replace(/<[^>]*>/g, "").trim() === "")
    .map(([whole]) => whole.slice(0, 80));
}

/** 入力は、for が結ばれた label を持つ。 */
function unlabeledInputs(html: string): string[] {
  return [...html.matchAll(/<(input|textarea)\b([^>]*?)>/g)]
    .filter(([, , attrs]) => {
      const id = /\bid="([^"]+)"/.exec(attrs ?? "")?.[1];
      return !id || !new RegExp(`<label[^>]*for="${id}"`).test(html);
    })
    .map(([whole]) => whole.slice(0, 80));
}

const DESTS: PublishDestOption[] = [
  { id: "exp", label: "NIHO Experience", who: "旅行者向け · 英語", url: "experience.niho.life/guides/x", role: "ライター", connected: true },
  { id: "niho", label: "NIHO", who: "鎌倉の人向け", url: "niho.life/article/x", role: "NIHO アカウント", connected: true },
  { id: "site", label: "自分のサイト", who: "本人のサイト", url: "mika-sato.example/posts/x", role: "接続済み", connected: true },
];

function form(over: Partial<PublishFormProps> = {}) {
  return renderToStaticMarkup(
    <PublishSheet
      kind="publish"
      dests={DESTS}
      missing={[]}
      range="live"
      extras={{ app: true, news: false, xp: true }}
      onPick={noop}
      onRange={noop}
      onExtra={noop}
      onFix={noop}
      onPublish={noop}
      onClose={noop}
      {...over}
    />,
  );
}

describe("LoginScreen", () => {
  const html = renderToStaticMarkup(<LoginScreen onLogin={noop} />);
  it("「書く」と NIHO アカウントで続けるボタン。パスワード欄は持たない", () => {
    for (const text of ["書く", "NIHO アカウントで続けます。", "NIHOでログイン", "アカウントを作る", "ヘルプ", "© NIHO", "niho.life"]) expect(html).toContain(text);
    expect(html).not.toMatch(/<input|type="password"/);
    expect(html).toContain('<main class="es-split-box">');
    // 名前（ロゴ）も header（banner）に入れ、ランドマークの外に中身を置かない（#43）
    expect(html).toContain('<header class="es-lg-brand">');
    expect(html).toContain('class="es-root es-root--scroll"');
    expect(unlabeledButtons(html)).toEqual([]);
  });
  it("写真は持ち込まない（左は飾りの面で、読み上げない）", () => {
    expect(html).toContain('<div class="es-split-ph" aria-hidden="true">');
    expect(html).not.toMatch(/<img|background-image|url\(/);
  });
});

describe("PublishSheet（publish）", () => {
  it("role=dialog・aria-modal・aria-label=公開。発信先は radiogroup で、選んだものが aria-checked", () => {
    const html = form({ picked: "exp" });
    expect(html).toContain('role="dialog" aria-modal="true" aria-label="公開"');
    expect(html).toMatch(/role="radiogroup" aria-labelledby=/);
    expect([...html.matchAll(/role="radio"/g)]).toHaveLength(3 + 2); // 発信先 3 つ＋範囲 2 つ
    expect(html).toMatch(/aria-checked="true" class="es-dst es-dst--exp es-dst--on"/);
    for (const text of ["どこに出すか", "NIHO Experience", "旅行者向け · 英語", "experience.niho.life/guides/x", "ライター", "発信先を追加"]) expect(html).toContain(text);
    expect(unlabeledButtons(html)).toEqual([]);
  });

  it("発信先を選ぶ前は、条件も範囲も出さず、公開は押せない", () => {
    const html = form();
    expect(html).toContain("発信先を選ぶと条件が出ます");
    expect(html).not.toContain("範囲");
    expect(html).not.toContain("あわせて");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>公開する<\/button>/);
    expect(html).toContain("<h2>公開</h2>");
  });

  it("足りないものがあれば「直す」を出し、あと N つ。公開は押せない", () => {
    const html = form({ picked: "exp", missing: [{ id: "cat", label: "カテゴリ" }, { id: "confirm", label: "CONFIRM 開門時間" }] });
    expect(html).toContain("NIHO Experience に出すには");
    expect(html).toContain('aria-label="カテゴリ を直す"');
    expect(html).toContain("CONFIRM 開門時間");
    expect(html).toContain("あと 2 つ");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>公開する<\/button>/);
    expect(html).not.toContain("条件はそろっています");
  });

  it("条件がそろえば「条件はそろっています」と URL。公開が押せる。範囲・あわせてが出る", () => {
    const html = form({ picked: "exp" });
    expect(html).toContain("NIHO Experience の条件はそろっています");
    expect(html).toContain("<code");
    expect(html).toContain("experience.niho.life/guides/x</code>");
    expect(html).not.toMatch(/disabled=""[^>]*>公開する/);
    for (const text of ["範囲", "公開", "一覧・検索に出る", "限定公開", "URLを知っている人だけ", "あわせて", "NIHOアプリに載せる", "ニュースレター", "次号", "体験ページに載せる", "関連する体験の末尾"]) expect(html).toContain(text);
    expect(html).toContain('role="checkbox" aria-checked="true"');
  });

  it("本人のサイトは範囲を持たず、「体験ページに載せる」は NIHO Experience のときだけ（無効）", () => {
    const html = form({ picked: "site" });
    expect(html).not.toContain("一覧・検索に出る");
    expect(html).toContain("NIHO Experience のときだけ");
    expect(html).toMatch(/aria-disabled="true" class="es-chk es-chk--on es-chk--off"/);
  });

  it("接続していない発信先は選べず「接続する ›」。名前は見えている文字そのもの（aria-label で置き換えない。WCAG 2.5.3・#43）", () => {
    const html = form({ dests: DESTS.map((dest) => (dest.id === "site" ? { ...dest, connected: false } : dest)) });
    // 矢印（›）だけは読み上げない
    expect(html).toContain('<span class="es-tag-no">接続する<span aria-hidden="true"> ›</span></span>');
    const button = /<button type="button" class="es-dst es-dst--site"([^>]*)>([\s\S]*?)<\/button>/.exec(html);
    expect(button).not.toBeNull();
    // aria-label を持たず、見えている発信先・説明・URL・「接続する」が名前になる
    expect(button![1]).not.toContain("aria-label");
    const name = button![2]!.replace(/<span aria-hidden="true">[^<]*<\/span>/g, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    expect(name).toBe("自分のサイト 本人のサイト mika-sato.example/posts/x 接続する");
    expect([...html.matchAll(/role="radio"/g)]).toHaveLength(2);
  });

  it("選んだ発信先の接続が切れているときは、条件が空でも公開できない（接続を促す）", () => {
    const dests = DESTS.map((dest) => (dest.id === "site" ? { ...dest, connected: false } : dest));
    const html = form({ dests, picked: "site", missing: [] });
    expect(html).toMatch(/<button type="button" class="es-btn es-btn--primary" disabled=""/);
    expect(html).toContain("自分のサイト に接続すると公開できます");
    const connected = form({ picked: "site", missing: [] });
    expect(connected).not.toMatch(/es-btn--primary" disabled/);
  });

  it("公開中は「公開の設定」「公開をやめる」「保存」、更新ありは「更新を公開」", () => {
    const live = form({ picked: "exp", current: {} });
    expect(live).toContain("<h2>公開の設定</h2>");
    expect(live).toContain("公開をやめる");
    expect(live).toMatch(/>保存<\/button>/);
    const updated = form({ picked: "exp", current: { updated: true } });
    expect(updated).toContain("<h2>更新を公開</h2>");
    expect(updated).toMatch(/>更新を公開<\/button>/);
  });
});

describe("PublishSheet（done / addDest）", () => {
  it("公開しました: dialog の名前、公開先と URL、見る・リンクをコピー・閉じる", () => {
    const html = renderToStaticMarkup(<PublishSheet kind="done" host="experience.niho.life" url="experience.niho.life/guides/x" onView={noop} onCopy={noop} onClose={noop} />);
    expect(html).toContain('role="dialog" aria-modal="true" aria-label="公開しました"');
    expect(html).toContain("experience.niho.life に公開しました");
    expect(html).toContain("<code>experience.niho.life/guides/x</code>");
    for (const text of ["見る", "リンクをコピー", "閉じる"]) expect(html).toContain(text);
    expect(unlabeledButtons(html)).toEqual([]);
  });

  it("発信先を追加: 既定の 3 つ（公開APIで受け取る・WordPress・Ghost）", () => {
    const html = renderToStaticMarkup(<PublishSheet kind="addDest" onPick={noop} onClose={noop} />);
    expect(html).toContain('aria-label="発信先を追加"');
    for (const text of ["公開APIで受け取る", "どのサイトでも · JSON と Markdown", "WordPress", "サイトのURLとアプリケーションパスワード", "Ghost", "Admin API キー"]) expect(html).toContain(text);
    expect(unlabeledButtons(html)).toEqual([]);
  });
});

describe("EditorShell の overlay", () => {
  it("シートは .es-root の中（枠の外ではなく、共通 UI の root の中のスタイルが効く場所）に出る", () => {
    const html = renderToStaticMarkup(
      <EditorShell sidebar={null} header={null} sidebarOpen={false} railOpen={false} overlay={<PublishSheet kind="addDest" onPick={noop} onClose={noop} />}>
        x
      </EditorShell>,
    );
    expect(html.startsWith('<div class="es-root"')).toBe(true);
    expect(html.indexOf("es-veil")).toBeGreaterThan(html.indexOf("es-ws"));
    expect(html.trimEnd().endsWith("</div>")).toBe(true);
  });
});

describe("PublishPreview", () => {
  const base = {
    title: "Riding the Enoden Like You Live Here",
    lead: "Which stops are worth getting off at.",
    category: "Travel",
    lang: "en" as const,
    body: [{ type: "h2" as const, text: "Get off at Hase" }, { type: "p" as const, text: "Skip the queue." }, { type: "ul" as const, items: ["a", "b"] }],
    slug: "riding-the-enoden",
    date: "2026-10-27",
    author: { name: "Mika Sato", title: "Writer, lives in Kita-Kamakura", initial: "M" },
    dests: [
      { id: "exp" as const, host: "experience.niho.life", path: "guides/" },
      { id: "niho" as const, host: "niho.life", path: "article/" },
      { id: "site" as const, host: "mika-sato.example", path: "posts/" },
    ],
    siteHost: "mika-sato.example",
    live: false,
    onBack: noop,
    onTo: noop,
  };
  const render = (over: Partial<Parameters<typeof PublishPreview>[0]> = {}) => renderToStaticMarkup(<PublishPreview {...base} to="exp" experience={{ title: "Kamakura Community Dinner with Locals", price: "15,000", from: true }} {...over} />);

  it("上のバー: ページへ戻る・状態の言葉（aria-live）・発信先の切り替え（沈めたトラック＋aria-pressed）", () => {
    const html = render();
    expect(html).toContain('<header class="es-pvbar">');
    expect(html).toContain("ページ</button>");
    expect(html).toContain('aria-live="polite">公開するとこう見えます');
    expect(html).toContain('<div class="es-track" role="group" aria-label="発信先ごとの見え方">');
    expect(html).toMatch(/<button type="button" aria-pressed="true">experience\.niho\.life<\/button>/);
    expect(html).toMatch(/<button type="button" aria-pressed="false">niho\.life<\/button>/);
    expect(html).toContain("mika-sato.example</button>");
    expect(render({ live: true })).toContain('aria-live="polite">公開中');
    expect(unlabeledButtons(html)).toEqual([]);
  });

  it("NIHO Experience: 見出し・リード・カテゴリ・本文・関連する体験（From ¥15,000 / adult）。写真は持ち込まない", () => {
    const html = render();
    expect(html).toContain('<main class="es-pv es-pv--exp"');
    for (const text of ["Experiences", "Journal", "Host with NIHO", "<h1>Riding the Enoden Like You Live Here</h1>", "Travel", "Which stops are worth getting off at.", "By <b>Mika Sato</b>", "2026-10-27", "<h2>Get off at Hase</h2>", "<li>a</li>", "Kamakura Community Dinner with Locals", "From ¥15,000 / adult"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toMatch(/<img|background-image|url\(/);
  });

  it("NIHO と自分のサイトでは見え方が替わり、関連する体験は出ない。日本語は「By」を付けない", () => {
    const niho = render({ to: "niho", lang: "ja" });
    expect(niho).toContain("es-pv--niho");
    for (const text of ["リビング", "コミュニティ", "es-pv-wrap"]) expect(niho).toContain(text);
    expect(niho).not.toContain("From ¥");
    expect(niho).not.toContain("By <b>");
    const site = render({ to: "site" });
    expect(site).toContain("es-pv--site");
    expect(site).toContain("Posts · About");
    expect(site).toContain("mika-sato.example");
  });
});

describe("DestinationsPage", () => {
  const rows: DestinationRow[] = [
    { id: "exp", label: "NIHO Experience", host: "experience.niho.life", path: "guides/", who: "旅行者向け · 英語", role: "ライター", connected: true, published: 2 },
    { id: "niho", label: "NIHO", host: "niho.life", path: "article/", who: "鎌倉の人向け", role: "NIHO アカウント", connected: true, published: 1 },
    { id: "site", label: "自分のサイト", host: "mika-sato.example", path: "posts/", who: "本人のサイト", role: "接続済み", connected: false, published: 0 },
  ];
  const html = renderToStaticMarkup(<DestinationsPage dests={rows} onOpenSite={noop} onAdd={noop} />);
  it("発信先ごとのカード（出せる理由・公開中の数）と、本人のサイトの「設定」、「発信先を追加」", () => {
    expect(html).toContain("<h1>発信先</h1>");
    expect(html).toContain("✓ ライター");
    expect(html).toContain("公開中 2");
    expect(html).toContain("未接続");
    expect(html).toContain("experience.niho.life/guides/");
    expect(html).toMatch(/aria-label="mika-sato.example の設定"[^>]*>設定</);
    expect(html).toContain("発信先を追加");
    expect(html).toContain("自分のサイト · WordPress · Ghost");
    expect(html).toContain('<a class="es-btn es-btn--quiet es-btn--sm" href="https://experience.niho.life" target="_blank" rel="noopener noreferrer">');
    expect(unlabeledButtons(html)).toEqual([]);
  });
});

describe("SitePage", () => {
  const html = renderToStaticMarkup(
    <SitePage
      host="mika-sato.example"
      apiUrl="https://api.editor.niho.life/v1/mika/published.json"
      maskedKey="pk_site_•••••••••••3f9a"
      wordpress={{ on: false }}
      articleUrl="mika-sato.example/posts/{slug}"
      published={[{ id: "a", title: "材木座の朝市に出店するまで", url: "mika-sato.example/posts/asaichi" }]}
      onBack={noop}
    />,
  );
  it("受け取り方の kvs（公開API・鍵・WordPress・書き出し）と URL の kvs", () => {
    expect(html).toContain('<dl class="es-kvs">');
    for (const label of ["公開API", "鍵", "WordPress に送る", "書き出し", "記事", "写真"]) expect(html).toContain(`<dt>${label}</dt>`);
    expect(html).toContain("https://api.editor.niho.life/v1/mika/published.json");
    expect(html).toContain("Markdown + 写真（zip）");
    expect(html).toContain("mika-sato.example/wp-json");
    expect(html).toContain("公開のときに mika-sato.example へ複製");
  });
  it("見出しは本人のサイト＋印。戻るボタンに名前。WordPress はスイッチ（aria-checked）", () => {
    expect(html).toContain("<h1>mika-sato.example</h1>");
    expect(html).toContain('aria-label="発信先に戻る"');
    expect(html).toContain("es-pill es-pill--site");
    expect(html).toContain('role="switch" aria-checked="false" aria-label="WordPress に送る"');
  });
  it("公開中の表は role を持ち、見出しの行は画面に出さない。接続の解除は危険色", () => {
    expect(html).toContain('<table class="es-tbl es-tbl--nohead" role="table"');
    expect(html).toContain('role="columnheader"');
    expect(html).toContain("材木座の朝市に出店するまで");
    expect(html).toContain('class="es-danger"');
    expect(html).toContain("接続を解除");
    expect(unlabeledButtons(html)).toEqual([]);
  });
});

describe("AccountPage", () => {
  const props = {
    account: { name: "Mika Sato", initial: "M", email: "mika@example.com" },
    roles: [
      { id: "writer", name: "ライター", detail: "NIHO Experience · NIHO 事務局の招待 · 2026-10-29", dest: "exp" as const },
      { id: "host", name: "体験ホスト", detail: "体験を掲載するには NIHO Experience で申し込み", off: { action: "申し込む" } },
    ],
    links: [{ id: "sora", provider: "Sora's Zen Mornings", initial: "S", experience: "Morning Zazen and a Quiet Temple Walk", pages: 1 }],
  };
  it("NIHO アカウント・役割（持っている／いない）・記事連携の表", () => {
    const html = renderToStaticMarkup(<AccountPage {...props} />);
    for (const text of ["役割とつながり", "NIHO アカウント", "mika@example.com", "NIHOで管理", "ライター", "experience.niho.life", "es-role es-role--off", "申し込む", "記事連携", "提供者", "使える体験", "関連付けたページ", "Sora&#x27;s Zen Mornings"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('data-label="使える体験"');
    expect(html).not.toContain("es-inv");
    expect(unlabeledButtons(html)).toEqual([]);
  });
  it("未処理の招待があれば、受ける／辞退", () => {
    const html = renderToStaticMarkup(<AccountPage {...props} invite={{ initial: "N", name: "NIHO kamakura", detail: "Takuya · 公開中の体験を記事に関連付け" }} />);
    expect(html).toContain("es-inv");
    expect(html).toContain('aria-label="NIHO kamakura の招待を受ける"');
    expect(html).toContain('aria-label="NIHO kamakura の招待を辞退"');
    expect(html).toContain(">受ける<");
    expect(html).toContain(">辞退<");
  });
});

describe("SettingsPage", () => {
  const html = renderToStaticMarkup(
    <SettingsPage
      profile={{ initial: "M", name: "Mika Sato", titleJa: "ライター・北鎌倉在住", titleEn: "Writer, lives in Kita-Kamakura", bio: "2019年に鎌倉へ。" }}
      aiLang="same"
      terms="北鎌倉 · 円覚寺"
      recipes={[{ id: "r", name: "記事制作", steps: ["文字起こし修正", "記事方針", "記事本文"] }]}
      engine="mac"
      speakers
      saveTo="cloud"
    />,
  );
  it("5 つの節（プロフィール・AI・手順・文字起こし・保存）と、節へ飛ぶ項目帯", () => {
    expect(html).toContain("<h1>設定</h1>");
    for (const id of ["es-s-prof", "es-s-ai", "es-s-steps", "es-s-tr", "es-s-save"]) expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(/<nav class="es-secnav" aria-label="設定の項目">(<button type="button">[^<]+<\/button>){5}<\/nav>/);
    for (const label of ["プロフィール", "AI", "手順", "文字起こし", "保存"]) expect(html).toMatch(new RegExp(`<h2[^>]*>${label}</h2>`));
  });
  it("kvs: 提案の言語・固有名詞・手順の名前・エンジン・話者の推定・保存先・書き出し", () => {
    for (const label of ["提案の言語", "固有名詞", "記事制作", "エンジン", "話者の推定", "保存先", "書き出し"]) expect(html).toContain(`<dt>${label}</dt>`);
    for (const text of ["書いた言語のまま", "日本語", "English", "この Mac", "Gemini", "Deepgram", "NIHO クラウド", "この Mac だけ", "文字起こし › 文字起こし修正 › 記事方針 › 記事本文", "手順を追加", "すべてのページを書き出す", "ログアウト", "写真を変更"]) expect(html).toContain(text);
  });
  it("選択チップは aria-pressed、スイッチは aria-checked、入力は label と結ばれる", () => {
    expect(html).toMatch(/class="es-on" aria-pressed="true">書いた言語のまま</);
    expect(html).toMatch(/aria-pressed="false">日本語</);
    expect(html).toContain('role="switch" aria-checked="true" aria-label="話者の推定"');
    expect(unlabeledInputs(html)).toEqual([]);
    expect([...html.matchAll(/<label for=/g)]).toHaveLength(4);
    expect(unlabeledButtons(html)).toEqual([]);
  });
});

describe("設定系ページの枠（EditorShell に入れる）", () => {
  it("ヘッダーは plain（罫線なし）にできる", () => {
    expect(renderToStaticMarkup(<ShellHeader plain title="設定" />)).toContain('<header class="es-dt es-dt--plain">');
    expect(renderToStaticMarkup(<ShellHeader title="設定" />)).toContain('<header class="es-dt">');
  });
});
