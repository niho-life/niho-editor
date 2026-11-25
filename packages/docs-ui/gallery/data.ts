import type { ShellBodyBlock, ShellDest, ShellLang, ShellPageKind, ShellPublication, ShellStepState } from "../src/shell";

/* モック v6 の合成データ（実在の個人情報・連絡先は入れない。写真は持ち込まない）。 */

export const ME = {
  name: "Mika Sato",
  initial: "M",
  email: "mika@example.com",
  titleJa: "ライター・北鎌倉在住",
  titleEn: "Writer, lives in Kita-Kamakura",
  site: "mika-sato.example",
};

export const DEST: Record<ShellDest, { label: string; host: string; path: string; who: string; role: string; cats: string[] }> = {
  exp: { label: "NIHO Travel", host: "travel.example.test", path: "guides/", who: "旅行者向け · 英語", role: "ライター", cats: ["Food", "Culture", "Travel"] },
  niho: { label: "NIHO", host: "niho.life", path: "article/", who: "鎌倉の人向け", role: "NIHO アカウント", cats: ["暮らし", "お知らせ", "コラム"] },
  site: { label: "自分のサイト", host: ME.site, path: "posts/", who: "本人のサイト", role: "接続済み", cats: [] },
};

export const EXPERIENCES: Record<string, { title: string; by: string; price: string; from?: boolean }> = {
  zazen: { title: "Morning Zazen and a Quiet Temple Walk", by: "Sora's Zen Mornings", price: "9,800" },
  dinner: { title: "Kamakura Community Dinner with Locals", by: "NIHO kamakura", price: "15,000", from: true },
};

/** 録音から作る手順（設定の「手順」）。文字起こしのあとの名前。 */
export const STEP_NAMES: Record<string, string[]> = {
  記事制作: ["文字起こし修正", "記事方針", "記事本文"],
  議事録: ["議事録", "共有用の要約"],
  インサイト整理: ["インサイト"],
};

/** 公開のシートの「あわせて」の初期値（モックの page.extra）。 */
export type PublishExtrasState = { app: boolean; news: boolean; xp: boolean };
const EXTRA_BY_ID: Record<string, PublishExtrasState> = {
  "rec-body": { app: true, news: false, xp: true },
  kita: { app: true, news: false, xp: true },
  enoden: { app: true, news: false, xp: true },
  coffee: { app: true, news: true, xp: false },
  rainy: { app: false, news: false, xp: false },
};
export const extrasOf = (page: { id: string }): PublishExtrasState => EXTRA_BY_ID[page.id] ?? { app: true, news: false, xp: false };

export type GalleryPage = {
  id: string;
  title: string;
  kind: ShellPageKind;
  lang: ShellLang;
  /** カバー写真があるか（写真は持ち込まず、仮の面で描く）。 */
  cover: boolean;
  pub: { dest: ShellDest; range: "live" | "unlisted" | "stopped"; updated?: boolean; date: string } | null;
  saved: string;
  lead?: string;
  cat?: string;
  xs: string[];
  parent?: string;
  children?: string[];
  recipe?: string;
  st?: ShellStepState;
  /** 公開の前に確かめる印（CONFIRM）が本文に残っている。 */
  confirm?: boolean;
  body: ShellBodyBlock[];
};

const strong = (text: string) => ({ kind: "strong" as const, text });

export const PAGES: GalleryPage[] = [
  {
    id: "j1030", title: "10月30日（木）", kind: "note", lang: "ja", cover: false, pub: null, saved: "たった今", xs: [],
    body: [
      { type: "p", text: "朝、北鎌倉まで歩いた。寺の門が開く前の道は、まだ空気が冷たくて静か。" },
      { type: "p", text: "体験サイトの記事をどう増やすか、歩きながらずっと考えていた。書く人を増やすより、書きたくなる場所を作る方が先かもしれない。" },
      { type: "p", text: "夜は Takuya さんのディナー。6人。" },
    ],
  },
  {
    id: "memo", title: "体験サイトの記事をどう増やすか", kind: "note", lang: "ja", cover: false, pub: null, saved: "2時間前", xs: [],
    body: [
      { type: "p", text: "記事が増えない理由はたぶん3つ。書く場所が遠い、何を書けばいいか分からない、公開が怖い。" },
      { type: "p", text: "場所の問題は、自分の日記と同じところで書けるようにすれば消える。日記のつもりで書いて、あとから「これ出せるかも」と思ったら出す、の順番。" },
      { type: "p", text: "何を書くかは、ホストとの会話から拾えばいい。録音して、文字にして、整えてもらう。" },
      { type: "p", text: "公開の怖さは、どこに出るか・いつでも戻せるかが見えれば減る。" },
    ],
  },
  {
    id: "rec", title: "Takuya さんと話したこと", kind: "rec", lang: "ja", cover: false, pub: null, saved: "昨日", xs: [], recipe: "記事制作",
    children: ["rec-fix", "rec-plan", "rec-body"],
    body: [{ type: "p", text: "ディナーのはじまりについて。10月29日、リビングで。" }],
  },
  {
    id: "rec-fix", title: "文字起こし修正", kind: "step", lang: "ja", cover: false, pub: null, saved: "昨日", xs: [], parent: "rec", st: "done",
    body: [
      { type: "p", text: [strong("Takuya"), "　最初は、泊まりに来た人と一緒にご飯を作るだけだった。テーブルは一つしかなかった。"] },
      { type: "p", text: [strong("Mika"), "　それが今の形になったのはいつ頃？"] },
      { type: "p", text: [strong("Takuya"), "　去年の秋。近所の人が「私も座っていい？」と言って、それから毎回誰かが来るようになった。今は8人まで。それ以上だと一つのテーブルで話せなくなる。"] },
    ],
  },
  {
    id: "rec-plan", title: "記事方針", kind: "step", lang: "ja", cover: false, pub: null, saved: "昨日", xs: [], parent: "rec", st: "done",
    body: [
      { type: "p", text: [strong("読者"), "　鎌倉に来る前の旅行者。コミュニティディナーが何か知らない。"] },
      { type: "p", text: [strong("切り口"), "　「一つのテーブル」から始まった話を、はじまりの夜の描写から入る。"] },
      { type: "ul", items: ["泊まりに来た人と作る夕食 → 近所の人が座る → 8人という上限", "Takuya の言葉をそのまま2か所使う", "最後に次の開催日へ"] },
      { type: "p", text: [strong("長さ"), "　900〜1,200 words、英語。"] },
    ],
  },
  {
    id: "rec-body", title: "One Long Table: How the Community Dinner Began", kind: "article", lang: "en", cover: true, pub: null, saved: "昨日", xs: ["dinner"], parent: "rec", st: "done",
    lead: "It started with one table, a few guests and whoever was home. Then a neighbor asked if she could sit down.",
    body: [
      { type: "p", text: "The first dinners were nothing planned. Guests staying at the house cooked with whoever was home, and everyone ate at the only table in the living room." },
      { type: "h2", text: "“Can I sit too?”" },
      { type: "p", text: "Last autumn a neighbor stopped by, looked at the table and asked if she could join. After that, someone from the neighborhood came every time." },
      { type: "p", text: "Today the limit is eight. “Any more than that,” Takuya says, “and you can’t talk across one table.”" },
    ],
  },
  {
    id: "rec2", title: "Sora さんの座禅の話", kind: "rec", lang: "ja", cover: false, pub: null, saved: "3日前", xs: [], children: [],
    body: [{ type: "p", text: "朝の座禅会のあと、本堂の前で。" }],
  },
  {
    id: "kita", title: "A Slow Morning in Kita-Kamakura", kind: "article", lang: "en", cover: true, pub: null, saved: "昨日", xs: ["zazen"], confirm: true,
    lead: "Three temples, one tea house and a back path over the hill. Start at eight and you will have it nearly to yourself.",
    body: [
      { type: "p", text: "Kita-Kamakura wakes up early. Take the 7:52 train and you reach the first gate before the tour groups, with the moss garden almost to yourself." },
      { type: "h2", text: "Engaku-ji before eight" },
      { type: "p", text: ["The gate opens at ", { kind: "confirm", text: "CONFIRM 開門時間" }, ". Walk past the main hall and take the stone steps on the left."] },
    ],
  },
  {
    id: "enoden", title: "Riding the Enoden Like You Live Here", kind: "article", lang: "en", cover: true, saved: "昨日", xs: ["dinner"], cat: "Travel",
    pub: { dest: "exp", range: "live", updated: true, date: "2026-10-27" },
    lead: "Which stops are worth getting off at, when the trains are quiet, and the crossing everyone photographs.",
    body: [
      { type: "p", text: "The Enoden is ten kilometers of single track between Fujisawa and Kamakura. Most people ride it once, to the Great Buddha. Here is how to ride it like you live here." },
      { type: "h2", text: "Get off at Hase, walk to Yuigahama" },
      { type: "p", text: "Skip the queue at the station. The back streets of Hase reach the beach in twelve minutes." },
    ],
  },
  {
    id: "gomi", title: "鎌倉のごみ出し、はじめての一週間", kind: "article", lang: "ja", cover: true, saved: "10月24日", xs: [], cat: "暮らし",
    pub: { dest: "niho", range: "live", date: "2026-10-24" },
    lead: "引っ越してきて最初に困るのがこれ。曜日と袋と、ご近所の暗黙のルールをまとめました。",
    body: [
      { type: "p", text: "引っ越した翌朝、袋を持って外に出て、はたと止まった。どこに置くのか、何曜日なのか、誰に聞けばいいのか。" },
      { type: "h2", text: "曜日と袋" },
      { type: "p", text: "燃やすごみは月・木、資源は水曜。袋は市の指定袋で、駅前のコンビニにもある。" },
    ],
  },
  {
    id: "coffee", title: "Where Neighbors Get Coffee Near the Station", kind: "article", lang: "en", cover: true, saved: "10月22日", xs: [], cat: "Food",
    pub: { dest: "exp", range: "live", date: "2026-10-22" },
    lead: "Five small roasters and kissaten within ten minutes of the West Exit.",
    body: [{ type: "p", text: "Start at the West Exit, walk five minutes, and the town changes pace." }],
  },
  {
    id: "asaichi", title: "材木座の朝市に出店するまで", kind: "article", lang: "ja", cover: true, saved: "10月12日", xs: [],
    pub: { dest: "site", range: "live", date: "2026-10-12" },
    lead: "申し込みから当日の搬入まで。小さく始めた記録。",
    body: [
      { type: "p", text: "朝市の申し込みは2か月前。はじめは友人の店の隅を借りるところから始めた。" },
      { type: "h2", text: "搬入の朝" },
      { type: "p", text: "6時に材木座の駐車場へ。机と布、釣り銭、それから値札を忘れずに。" },
    ],
  },
  {
    id: "idea", title: "来年やりたいこと", kind: "note", lang: "ja", cover: false, pub: null, saved: "10月9日", xs: [],
    body: [{ type: "ul", items: ["北鎌倉の朝の散歩を、月に一度、体験にする", "ごみ出しの記事を英語にもする", "朝市にもう一度出る"] }],
  },
  {
    id: "rainy", title: "A Rainy Day in Kamakura", kind: "article", lang: "en", cover: false, saved: "10月2日", xs: [], cat: "Travel",
    pub: { dest: "exp", range: "stopped", date: "2026-10-02" },
    lead: "Temples are better in the rain.",
    body: [{ type: "p", text: "Temples are better in the rain." }],
  },
];

export const byId = (id: string): GalleryPage | undefined => PAGES.find((page) => page.id === id);

export const slug = (page: GalleryPage): string =>
  page.lang === "ja" ? page.id : page.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const urlOf = (page: GalleryPage, dest: ShellDest): string => `${DEST[dest].host}/${DEST[dest].path}${slug(page)}`;

export const publicationOf = (page: GalleryPage): ShellPublication | null =>
  page.pub ? { dest: page.pub.dest, range: page.pub.range, updated: page.pub.updated, url: urlOf(page, page.pub.dest) } : null;

/** 公開中（やめていない）か。 */
export const isPublished = (page: GalleryPage): boolean => Boolean(page.pub && page.pub.range !== "stopped");

/** 公開する条件で足りないもの（モックの missing と同じ）。 */
export function missingFor(page: GalleryPage, to: ShellDest): { id: string; label: string }[] {
  const missing: { id: string; label: string }[] = [];
  if (to === "exp" && page.lang !== "en") missing.push({ id: "lang", label: "英語で書く" });
  if (to !== "site" && !page.cover) missing.push({ id: "cover", label: "カバー写真" });
  if (to !== "site" && !page.lead) missing.push({ id: "lead", label: "リード" });
  if (DEST[to].cats.length && !page.cat) missing.push({ id: "cat", label: "カテゴリ" });
  if (page.confirm) missing.push({ id: "confirm", label: "CONFIRM 開門時間" });
  return missing;
}

export const TRANSCRIPT = [
  { id: "s1", who: "Takuya", tone: "a" as const, time: "00:12", text: "最初は、泊まりに来た人と一緒にご飯を作るだけだったんです。テーブルが一つしかなくて。" },
  { id: "s2", who: "Mika", tone: "b" as const, time: "00:41", text: "それが今の形になったのはいつ頃ですか。" },
  { id: "s3", who: "Takuya", tone: "a" as const, time: "00:48", text: "去年の秋かな。近所の人が「私も座っていい？」って言って、それから毎回誰かが来るようになって。", current: true },
  { id: "s4", who: "Takuya", tone: "a" as const, time: "01:20", text: "今は8人まで。それ以上だと一つのテーブルで話せなくなる。" },
];
