import { useState, type ReactNode } from "react";
import {
  AccountPage,
  DestinationsPage,
  EditorDestinationsPage,
  EditorSettingsPage,
  EditorShell,
  EditorSitePage,
  LoginScreen,
  PublishPreview,
  PublishSheet,
  SettingsPage,
  ShellHeader,
  SitePage,
  type AccountLink,
  type EditorAddSiteDraft,
  type EditorDestinationMode,
  type EditorSettingsAiLang,
  type EditorSettingsRecipe,
  type EditorSettingsTermDraft,
  type SettingsAiLang,
  type SettingsEngine,
  type SettingsSaveTo,
  type ShellBodyBlock,
  type ShellDest,
} from "../src/shell";
import { DEST, EXPERIENCES, ME, PAGES, STEP_NAMES, byId, isPublished, slug, urlOf, type GalleryPage } from "./data";
import { navigate, useSettingsSidebar } from "./shared";

/* フェーズ2の画面のギャラリー側の組み立て（モックの V.login / V.preview / V.dest / V.site / V.account / V.settings）。状態はこのファイルの useState。 */

export type PagesForced = { sidebar?: boolean };

export function LoginDemo() {
  return <LoginScreen onLogin={() => navigate("page:j1030")} />;
}

/** 本文の未確認の印（CONFIRM）は、公開版では確かめ済みの文字になる（モックは「8:00」に置き換える）。 */
function resolveConfirm(blocks: ShellBodyBlock[]): ShellBodyBlock[] {
  return blocks.map((block) =>
    block.type === "p" && typeof block.text !== "string" ? { type: "p", text: block.text.map((part) => (typeof part !== "string" && part.kind === "confirm" ? "8:00" : part)) } : block,
  );
}

export function PreviewDemo({ id }: { id: string }) {
  const page: GalleryPage = byId(id) ?? PAGES[0]!;
  const [to, setTo] = useState<ShellDest>(page.pub ? page.pub.dest : page.lang === "ja" ? "niho" : "exp");
  const live = isPublished(page) && Boolean(page.pub) && !page.pub?.updated && to === page.pub?.dest;
  const xp = page.xs[0] ? EXPERIENCES[page.xs[0]] : undefined;
  return (
    <PublishPreview
      title={page.title}
      lead={page.lead}
      category={page.cat}
      lang={page.lang}
      body={resolveConfirm(page.body)}
      slug={slug(page)}
      date={page.pub?.date ?? "2026-10-30"}
      author={{ name: ME.name, title: page.lang === "ja" ? ME.titleJa : ME.titleEn, initial: ME.initial }}
      to={to}
      dests={(Object.keys(DEST) as ShellDest[]).map((key) => ({ id: key, host: DEST[key].host, path: DEST[key].path }))}
      live={live}
      siteHost={ME.site}
      experience={xp ? { title: xp.title, price: xp.price, from: xp.from } : undefined}
      onBack={() => navigate(`page:${page.id}`)}
      onTo={setTo}
    />
  );
}

/** 設定系ページの枠（左の一覧＋ヘッダー＋ページ）。ページは選ばれていない。 */
function SettingsFrame({ current, title, sidebar: forcedSidebar, pendingInvites = 0, overlay, children }: { current: "dest" | "account" | "settings"; title: string; sidebar?: boolean; pendingInvites?: number; overlay?: ReactNode; children: ReactNode }) {
  const { sidebar, sidebarOpen, setSidebarOpen } = useSettingsSidebar(current, forcedSidebar, pendingInvites);
  return (
    <EditorShell
      sidebar={sidebar}
      header={<ShellHeader plain title={title} showListButton={!sidebarOpen} onToggleList={() => setSidebarOpen(true)} />}
      sidebarOpen={sidebarOpen}
      railOpen={false}
      overlay={overlay}
    >
      {children}
    </EditorShell>
  );
}

const connectedSite = (forced: { conn?: boolean }) => forced.conn ?? true;

export function DestDemo({ forced, addDest }: { forced: PagesForced & { conn?: boolean }; addDest?: boolean }) {
  const [sheet, setSheet] = useState(Boolean(addDest));
  const rows = (Object.keys(DEST) as ShellDest[]).map((key) => ({
    id: key,
    label: DEST[key].label,
    host: DEST[key].host,
    path: DEST[key].path,
    who: DEST[key].who,
    role: DEST[key].role,
    connected: key !== "site" || connectedSite(forced),
    published: PAGES.filter((page) => isPublished(page) && page.pub?.dest === key).length,
  }));
  return (
    <SettingsFrame
      current="dest"
      title="発信先"
      sidebar={forced.sidebar}
      pendingInvites={1}
      overlay={sheet ? <PublishSheet kind="addDest" onPick={() => navigate("site")} onClose={() => setSheet(false)} /> : undefined}
    >
      <DestinationsPage dests={rows} onOpenSite={() => navigate("site")} onAdd={() => setSheet(true)} />
    </SettingsFrame>
  );
}

export function SiteDemo({ forced }: { forced: PagesForced }) {
  const [wordpress, setWordpress] = useState(false);
  return (
    <SettingsFrame current="dest" title={ME.site} sidebar={forced.sidebar} pendingInvites={1}>
      <SitePage
        host={ME.site}
        apiUrl="https://api.editor.niho.life/v1/mika/published.json"
        maskedKey="pk_site_•••••••••••3f9a"
        wordpress={{ on: wordpress }}
        articleUrl={`${ME.site}/posts/{slug}`}
        published={PAGES.filter((page) => isPublished(page) && page.pub?.dest === "site").map((page) => ({ id: page.id, title: page.title, url: urlOf(page, "site") }))}
        onBack={() => navigate("dest")}
        onWordpress={setWordpress}
      />
    </SettingsFrame>
  );
}

export function AccountDemo({ forced }: { forced: PagesForced }) {
  const [pending, setPending] = useState(true);
  const links: AccountLink[] = [
    { id: "sora", provider: "Sora's Zen Mornings", initial: "S", experience: EXPERIENCES.zazen!.title, pages: 1 },
    ...(pending ? [] : [{ id: "niho-kamakura", provider: "NIHO kamakura", initial: "N", experience: EXPERIENCES.dinner!.title, pages: 1 }]),
  ];
  return (
    <SettingsFrame current="account" title="役割とつながり" sidebar={forced.sidebar} pendingInvites={pending ? 1 : 0}>
      <AccountPage
        account={{ name: ME.name, initial: ME.initial, email: ME.email }}
        roles={[
          { id: "writer", name: "ライター", detail: "NIHO Experience · NIHO 事務局の招待 · 2026-10-29", dest: "exp" },
          { id: "local", name: "鎌倉の人", detail: "NIHO", dest: "niho" },
          { id: "host", name: "体験ホスト", detail: "体験を掲載するには NIHO Experience で申し込み", off: { action: "申し込む" } },
        ]}
        invite={pending ? { initial: "N", name: "NIHO kamakura", detail: "Takuya · 公開中の体験を記事に関連付け" } : null}
        links={links}
        onAccept={() => setPending(false)}
        onDecline={() => setPending(false)}
      />
    </SettingsFrame>
  );
}

/** 既定の 3 つの手順（editor-web の DEFAULT_RECIPES と同じ並び。中身は短い合成の値）。 */
const WEB_RECIPES: EditorSettingsRecipe[] = [
  { id: "tpl-1", name: "記事制作", guide: "## 構成\n見出しを 4〜6 本。", steps: [
    { id: "k7m2q9xa", name: "文字起こし修正", instruction: "読みやすい文字起こし修正版に整える。" },
    { id: "r4t8wz3c", name: "記事方針", instruction: "論点ごとの見出しを立てる。" },
    { id: "h2n6v5pe", name: "記事本文", instruction: "方針のとおりに本文を書く。" },
  ], isDefault: true, modified: false },
  { id: "tpl-2", name: "議事録", guide: "", steps: [
    { id: "d9c3x7mf", name: "議事録", instruction: "決まったことと宿題を並べる。" },
    { id: "w5q1j8ks", name: "共有用の要約", instruction: "3 行にまとめる。" },
  ], isDefault: true, modified: true },
  { id: "tpl-3", name: "インサイト整理", guide: "", steps: [{ id: "u3e7z6rh", name: "インサイト", instruction: "気づきを並べる。" }], isDefault: true, modified: false },
  { id: "r-talk", name: "対談", guide: "二人の声を残す。", steps: [{ id: "s-1", name: "まとめ", instruction: "まとめる。" }], isDefault: false, modified: false },
];

const WEB_TERMS = [
  { term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌"], note: "駅名は「北鎌倉」" },
  { term: "円覚寺", reading: "えんがくじ", variants: [], note: "" },
];

/** 編集の下書きは、誤りやすい表記を打ったままの文字列で持つ（配列に分けるのは保存のとき）。 */
const webTermDrafts = (): EditorSettingsTermDraft[] => WEB_TERMS.map((entry) => ({ ...entry, variants: entry.variants.join("・") }));

/** editor-web の設定（#108）。開いている編集は `?terms=1` / `?recipe=tpl-1` で決める。 */
export function WebSettingsDemo({ forced }: { forced: PagesForced & { terms?: boolean; recipe?: string; about?: boolean } }) {
  const [aiLang, setAiLang] = useState<EditorSettingsAiLang>("same");
  const [glossary, setGlossary] = useState(WEB_TERMS);
  const [recipes, setRecipes] = useState(WEB_RECIPES);
  const [termsDraft, setTermsDraft] = useState<EditorSettingsTermDraft[] | null>(forced.terms ? webTermDrafts() : null);
  const [about, setAbout] = useState("鎌倉で小さな宿を営んでいます。読んだ人が歩きたくなるように、短い文で書きます。");
  const [aboutDraft, setAboutDraft] = useState<string | null>(forced.about ? about : null);
  const opened = forced.recipe ? (WEB_RECIPES.find((recipe) => recipe.id === forced.recipe) ?? null) : null;
  const [recipeDraft, setRecipeDraft] = useState<EditorSettingsRecipe | null>(opened);
  let serial = 0;
  return (
    <SettingsFrame current="settings" title="設定" sidebar={forced.sidebar} pendingInvites={1}>
      <EditorSettingsPage
        status=""
        busy={false}
        aiLang={aiLang}
        onAiLang={setAiLang}
        glossary={glossary}
        termsDraft={termsDraft}
        onEditTerms={() => setTermsDraft(glossary.map((entry) => ({ ...entry, variants: entry.variants.join("・") })))}
        onTermsDraft={setTermsDraft}
        onCancelTerms={() => setTermsDraft(null)}
        onSaveTerms={() => {
          if (termsDraft) {
            setGlossary(termsDraft.map((entry) => ({ ...entry, variants: entry.variants.split("・").map((part) => part.trim()).filter((part) => part.length > 0) })));
          }
          setTermsDraft(null);
        }}
        about={about}
        aboutDraft={aboutDraft}
        onEditAbout={() => setAboutDraft(about)}
        onAboutDraft={setAboutDraft}
        onCancelAbout={() => setAboutDraft(null)}
        onSaveAbout={() => {
          if (aboutDraft !== null) setAbout(aboutDraft);
          setAboutDraft(null);
        }}
        recipes={recipes}
        recipeDraft={recipeDraft}
        onEditRecipe={(id) => setRecipeDraft(recipes.find((recipe) => recipe.id === id) ?? null)}
        onRecipeDraft={setRecipeDraft}
        onCancelRecipe={() => setRecipeDraft(null)}
        onSaveRecipe={() => {
          if (recipeDraft) setRecipes(recipes.map((recipe) => (recipe.id === recipeDraft.id ? { ...recipeDraft, modified: recipe.isDefault } : recipe)));
          setRecipeDraft(null);
        }}
        onDuplicateRecipe={(id) => {
          const base = recipes.find((recipe) => recipe.id === id);
          if (base) setRecipes([...recipes, { ...base, id: `r-copy-${recipes.length}`, name: `${base.name}のコピー`, isDefault: false, modified: false }]);
        }}
        onResetRecipe={(id) => setRecipes(recipes.map((recipe) => (recipe.id === id ? { ...recipe, modified: false } : recipe)))}
        onRemoveRecipe={(id) => setRecipes(recipes.filter((recipe) => recipe.id !== id))}
        onAddRecipe={() => setRecipes([...recipes, { id: `r-new-${recipes.length}`, name: "新しい手順", guide: "", steps: [{ id: "s-new", name: "まとめ", instruction: "" }], isDefault: false, modified: false }])}
        newStepId={() => `s-${(serial += 1)}`}
        usage={{ month: "2026-10", inputTokens: 128_400, outputTokens: 12_900, costUsd: 4.21, limitUsd: 5, nearLimit: true }}
        usageNote={null}
        transcription={{ engine: "deepgram", timeoutSec: 1200, maxBytes: 2 * 1024 ** 3, maxDurationSec: 6 * 3600, retentionDays: 30, extensions: ["m4a", "mp3", "wav", "aac", "ogg", "flac"] }}
        storageUsage={{ totalBytes: "0", imageBytes: "0", audioBytes: "0" }}
        storageUsageNote={null}
        limits={{ glossary: 200, recipes: 20, steps: 12, aboutChars: 2_000 }}
      />
    </SettingsFrame>
  );
}

/** editor-web の発信先（#41）。開いている追加の下書きは `?add=1`、鍵は `?key=1` で出す。 */
export function WebDestDemo({ forced }: { forced: PagesForced & { add?: boolean; issuedKey?: boolean } }) {
  const [draft, setDraft] = useState<EditorAddSiteDraft | null>(forced.add ? { mode: "api", handle: "mika-note", siteUrl: "https://note.mika-sato.example", path: "posts" } : null);
  const [issued, setIssued] = useState(Boolean(forced.issuedKey));
  return (
    <SettingsFrame current="dest" title="発信先" sidebar={forced.sidebar} pendingInvites={1}>
      <EditorDestinationsPage
        status={issued ? "新しい鍵はこの 1 回だけ出ます" : ""}
        busy={false}
        faces={[
          { id: "exp", label: DEST.exp.label, host: DEST.exp.host, path: DEST.exp.path, who: DEST.exp.who, role: DEST.exp.role, available: true, reason: null, published: 1 },
          { id: "niho", label: DEST.niho.label, host: null, path: null, who: DEST.niho.who, role: DEST.niho.role, available: false, reason: "role", published: 0 },
        ]}
        sites={[
          { id: "site-1", handle: "mika-sato", host: ME.site, path: "posts", mode: "api", published: 1 },
          { id: "site-2", handle: "mika-note", host: `note.${ME.site}`, path: "", mode: "wordpress", published: 0 },
        ]}
        onOpenSite={() => navigate("site-web")}
        draft={draft}
        onAdd={() => setDraft({ mode: "api", handle: "", siteUrl: "https://", path: "" })}
        onDraft={setDraft}
        onCancelAdd={() => setDraft(null)}
        onCreate={() => {
          setDraft(null);
          setIssued(true);
        }}
        issuedKey={issued ? { masked: "ek_••••••••3f9a", plaintext: "ek_this-is-a-synthetic-key-shown-once-only-0" } : null}
        onCopyKey={() => undefined}
        onCloseKey={() => setIssued(false)}
      />
    </SettingsFrame>
  );
}

/** editor-web の自分のサイト（#41）。`?url=1`（URL の編集）・`?confirm=key|disconnect`・`?key=1`（新しい鍵）。 */
export function WebSiteDemo({ forced }: { forced: PagesForced & { url?: boolean; confirm?: string; issuedKey?: boolean } }) {
  const [mode, setMode] = useState<EditorDestinationMode>("api");
  const [urlDraft, setUrlDraft] = useState<{ host: string; path: string } | null>(forced.url ? { host: ME.site, path: "posts" } : null);
  const [confirmingKey, setConfirmingKey] = useState(forced.confirm === "key");
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(forced.confirm === "disconnect");
  const [issued, setIssued] = useState(Boolean(forced.issuedKey));
  return (
    <SettingsFrame current="dest" title={ME.site} sidebar={forced.sidebar} pendingInvites={1}>
      <EditorSitePage
        status=""
        busy={false}
        handle="mika-sato"
        host={ME.site}
        path="posts"
        mode={mode}
        apiUrl="https://api.editor.niho.life/v1/mika-sato/published.json"
        articleUrl={`https://${ME.site}/posts/{slug}`}
        keys={[
          { id: "k2", masked: "ek_••••••••3f9a", createdAt: "2026-10-30T00:00:00.000Z", active: true },
          { id: "k1", masked: "ek_••••••••1111", createdAt: "2026-10-01T00:00:00.000Z", active: false },
        ]}
        published={PAGES.filter((page) => isPublished(page) && page.pub?.dest === "site").map((page) => ({ pageId: page.id, title: page.title, url: urlOf(page, "site"), status: "published" as const }))}
        urlDraft={urlDraft}
        onBack={() => navigate("dest-web")}
        onCopyApi={() => undefined}
        onEditUrl={() => setUrlDraft({ host: ME.site, path: "posts" })}
        onUrlDraft={setUrlDraft}
        onCancelUrl={() => setUrlDraft(null)}
        onSaveUrl={() => setUrlDraft(null)}
        onMode={setMode}
        onExport={() => undefined}
        confirmingKey={confirmingKey}
        onAskKey={() => setConfirmingKey(true)}
        onCancelKey={() => setConfirmingKey(false)}
        onRotateKey={() => {
          setConfirmingKey(false);
          setIssued(true);
        }}
        issuedKey={issued ? { masked: "ek_••••••••7b2c", plaintext: "ek_this-is-a-synthetic-key-shown-once-only-1" } : null}
        onCopyKey={() => undefined}
        onCloseKey={() => setIssued(false)}
        confirmingDisconnect={confirmingDisconnect}
        onAskDisconnect={() => setConfirmingDisconnect(true)}
        onCancelDisconnect={() => setConfirmingDisconnect(false)}
        onDisconnect={() => setConfirmingDisconnect(false)}
      />
    </SettingsFrame>
  );
}

export function SettingsDemo({ forced }: { forced: PagesForced }) {
  const [profile, setProfile] = useState({ name: ME.name, titleJa: ME.titleJa, titleEn: ME.titleEn, bio: "2019年に鎌倉へ。毎朝、北鎌倉の寺の道を歩いています。" });
  const [aiLang, setAiLang] = useState<SettingsAiLang>("same");
  const [engine, setEngine] = useState<SettingsEngine>("mac");
  const [speakers, setSpeakers] = useState(true);
  const [saveTo, setSaveTo] = useState<SettingsSaveTo>("cloud");
  return (
    <SettingsFrame current="settings" title="設定" sidebar={forced.sidebar} pendingInvites={1}>
      <SettingsPage
        profile={{ initial: ME.initial, ...profile }}
        onProfile={(field, value) => setProfile((current) => ({ ...current, [field]: value }))}
        aiLang={aiLang}
        onAiLang={setAiLang}
        terms="北鎌倉 · 円覚寺 · 材木座 · NIHO kamakura"
        recipes={Object.entries(STEP_NAMES).map(([name, steps]) => ({ id: name, name, steps }))}
        engine={engine}
        onEngine={setEngine}
        speakers={speakers}
        onSpeakers={setSpeakers}
        saveTo={saveTo}
        onSaveTo={setSaveTo}
        onLogout={() => navigate("login")}
      />
    </SettingsFrame>
  );
}
