import { useMemo, useState } from "react";
import {
  EditorShell,
  RecordingStart,
  ShellAddRow,
  ShellBody,
  ShellChat,
  ShellHeader,
  ShellMakeFrom,
  ShellMobileToolbar,
  ShellPage,
  ShellPageSettings,
  ShellProposal,
  ShellRail,
  ShellRailSection,
  ShellSidebar,
  ShellSteps,
  ShellTools,
  shellAccountItems,
  shellMoreItems,
  shellPublishButton,
  shellStatus,
  type RecordingHow,
  type RecordingNext,
  type ShellBodyBlock,
  type ShellChatMessage,
  type ShellDest,
  type ShellProposalBlock,
  type ShellStep,
  type ShellToolAction,
} from "../src/shell";
import { DEST, EXPERIENCES, ME, byId, isPublished, missingFor, publicationOf, urlOf, PAGES, type GalleryPage } from "./data";
import { PublishFlow, type SheetKind } from "./publish-flow";
import { findScreen } from "./screens";
import { isNarrow, listItems, navigate } from "./shared";
import { TranscriptDemo, type TranscriptForced } from "./transcript-demo";

/** 文字を選んだとき: 3つ目の段落の頭 22 文字を選択に置き換える（モックの withSelection と同じ）。 */
function withSelection(blocks: ShellBodyBlock[]): ShellBodyBlock[] {
  let seen = 0;
  return blocks.map((block) => {
    if (block.type !== "p" || typeof block.text !== "string" || block.text.length < 26) return block;
    seen += 1;
    if (seen !== 3) return block;
    return { type: "p", text: [{ kind: "sel", text: block.text.slice(0, 22) }, block.text.slice(22)] };
  });
}

const MEMO_PROPOSAL: ShellProposalBlock[] = [
  {
    id: "b1",
    parts: ["記事が増えない理由は", { del: "たぶん" }, "3つ", { ins: "ある" }, "。書く場所が遠い", { del: "、" }, { ins: "こと、" }, "何を書けばいいか分からない", { del: "、" }, { ins: "こと、" }, "公開が怖い", { ins: "こと" }, "。"],
  },
  {
    id: "b2",
    parts: [
      "場所の問題は、自分の日記と同じところで書けるようにすれば消える。",
      { del: "日記のつもりで書いて、あとから「これ出せるかも」と思ったら出す、の順番。" },
      { ins: "まず日記のつもりで書き、あとから「これは出せる」と思ったものだけを公開する。その順番が大切だ。" },
    ],
  },
  { id: "b3", parts: ["何を書くかは、ホストとの会話から拾えばいい。録音して、文字にして、整えてもらう。"], done: true, note: "変更なし" },
];

const SEED_CHAT: ShellChatMessage[] = [
  { id: "m1", who: "me", text: "整える" },
  {
    id: "m2",
    who: "ai",
    text: "読んで、直すところをまとめました。",
    card: {
      title: "整える の提案",
      note: "消す文は赤、足す文は緑。段落ごとに採用できます",
      actions: [
        { id: "view", label: "ページで見る", tone: "primary" },
        { id: "redo", label: "やり直す", tone: "outline" },
      ],
    },
  },
];

function stepsFor(page: GalleryPage): { root: GalleryPage; steps: ShellStep[] } | null {
  const root = page.parent ? byId(page.parent) : page;
  if (!root || root.kind !== "rec" || !root.recipe) return null;
  const kids = (root.children ?? []).flatMap((id) => {
    const kid = byId(id);
    return kid ? [kid] : [];
  });
  return {
    root,
    steps: [
      { id: root.id, label: "文字起こし", state: "done" },
      ...kids.map((kid) => ({ id: kid.id, label: kid.kind === "article" ? "記事本文" : kid.title, state: kid.st ?? ("done" as const) })),
    ],
  };
}

/**
 * web: editor-web が今つないでいる形の情報パネル（#34 第 3 段。肩書なし・書き出しは Markdown だけ・ページを削除。
 * 手順と AI の節は出さない）。note: 言語を保存できなかったときの一言を出す。
 * newrec で web: editor-web の「録音から」（#36 段 3b-1。取り込める形式の長い一言と、音声を選んだときの「取り込む」）。
 */
export type ScreenForced = { sidebar?: boolean; rail?: boolean; pick?: ShellDest; conn?: boolean; page?: string; web?: boolean; note?: boolean; terms?: boolean; about?: boolean; recipe?: string; add?: boolean; url?: boolean; confirm?: string; issuedKey?: boolean } & TranscriptForced;

const noop = () => undefined;

export function Screen({ id, forced }: { id: string; forced: ScreenForced }) {
  const [name = "", arg = ""] = id.split(":");
  const def = findScreen(id);
  const isNew = name === "new";
  const isStart = name === "newrec";
  /** 公開のシートを開いた状態（sheet:publish / sheet:done）。page:kita の上に開く（?page= で別のページにできる）。 */
  const initialSheet: SheetKind | null = name === "sheet" && (arg === "publish" || arg === "done") ? arg : null;
  const pageId = name === "sheet" ? (forced.page ?? "kita") : arg;
  const [sheet, setSheet] = useState<SheetKind | null>(initialSheet);
  // 公開したあとのページ（モックは page.pub を書き換える）。sheet:done は「いま公開した」状態から始める
  const [published, setPublished] = useState<GalleryPage["pub"] | undefined>(initialSheet === "done" ? { dest: "exp", range: "live", date: "2026-10-30" } : undefined);
  const page = useMemo<GalleryPage>(() => {
    if (isNew) return { id: "new", title: "", kind: "note", lang: "ja", cover: false, pub: null, saved: "たった今", xs: [], body: [] };
    const base = byId(pageId) ?? PAGES[0]!;
    return published === undefined ? base : { ...base, kind: "article", pub: published, saved: published ? "たった今" : base.saved };
  }, [isNew, pageId, published]);

  const [sidebarOpen, setSidebarOpen] = useState(forced.sidebar ?? !isNarrow());
  const [railOpen, setRailOpen] = useState(forced.rail ?? def?.rail ?? false);
  const [newMenu, setNewMenu] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  const [blockMenu, setBlockMenu] = useState(false);
  const [search, setSearch] = useState({ open: false, value: "" });
  const [cards, setCards] = useState({ steps: true, page: true });
  const [chat, setChat] = useState<ShellChatMessage[]>(def?.proposal ? SEED_CHAT : []);
  const [draft, setDraft] = useState("");
  const [proposalOpen, setProposalOpen] = useState(Boolean(def?.proposal));
  const [proposalDone, setProposalDone] = useState<string[]>([]);
  const [how, setHow] = useState<RecordingHow>("mic");
  const [next, setNext] = useState<RecordingNext>("article");
  const [background, setBackground] = useState("NIHO kamakura のコミュニティディナーのはじまりについて、ホストの Takuya さんに聞いた。旅行者向けの英語記事にする。");
  const [lang, setLang] = useState(page.lang);
  const [category, setCategory] = useState(page.cat ?? "");

  const items = useMemo(() => listItems(isNew), [isNew]);
  const query = search.value.trim();
  const shown = query ? items.filter((item) => item.title.includes(query)) : items;
  const pub = publicationOf(page);
  const planned = false;
  const status = shellStatus(pub);
  const publish = isNew || isStart ? null : shellPublishButton({ pub, planned, isArticle: page.kind === "article" });
  const steps = stepsFor(page);
  const dest = pub && pub.range !== "stopped" ? pub.dest : undefined;
  const hasRail = !isStart;

  const sidebar = (
    <ShellSidebar
      items={shown}
      currentId={isStart ? undefined : page.id}
      onSelect={(itemId) => navigate(itemId === "new" ? "new" : `page:${itemId}`)}
      onCollapse={() => setSidebarOpen(false)}
      // 右に並べる（設計 §5.5。editor-web と同じくデスクトップでページを開いているときだけ）。行の「…」を axe・はみ出しの確認に載せる
      side={!isStart && !isNarrow() ? { onOpen: () => undefined, onClose: () => undefined } : undefined}
      newMenu={{
        open: newMenu,
        onToggle: () => setNewMenu((v) => !v),
        onClose: () => setNewMenu(false),
        onPick: (kind) => navigate(kind === "recording" ? "newrec" : "new"),
      }}
      search={{
        open: search.open,
        value: search.value,
        onOpen: () => setSearch({ open: true, value: "" }),
        onClose: () => setSearch({ open: false, value: "" }),
        onChange: (value) => setSearch({ open: true, value }),
      }}
      me={{
        name: ME.name,
        initial: ME.initial,
        badge: 1,
        open: accountMenu,
        items: shellAccountItems(1),
        onToggle: () => setAccountMenu((v) => !v),
        onClose: () => setAccountMenu(false),
        onSelect: (itemId) => {
          setAccountMenu(false);
          navigate(itemId === "logout" ? "login" : itemId);
        },
      }}
    />
  );

  const onTool = (action: ShellToolAction) => {
    if (action === "add-block") setBlockMenu((v) => !v);
  };
  const tools = <ShellTools onAction={onTool} blockMenuOpen={blockMenu} />;

  const header = isStart ? (
    <ShellHeader
      title="録音から"
      showListButton={!sidebarOpen}
      onToggleList={() => setSidebarOpen(true)}
      trailing={
        <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={() => navigate("new")}>
          やめる
        </button>
      }
    />
  ) : (
    <ShellHeader
      title={page.title}
      showListButton={!sidebarOpen}
      onToggleList={() => setSidebarOpen(true)}
      tools={tools}
      status={status}
      // web: editor-web と同じく公開ボタンを出さない（公開の配線が無い間）
      publish={publish && !forced.web ? { label: publish.label, tone: publish.tone, menu: publish.menu, onClick: () => setSheet("publish") } : null}
      railOpen={railOpen}
      onToggleRail={() => setRailOpen((v) => !v)}
      more={{ open: moreMenu, items: shellMoreItems(false), onToggle: () => setMoreMenu((v) => !v), onClose: () => setMoreMenu(false), onSelect: () => setMoreMenu(false) }}
    />
  );

  const pageSummary = !pub ? "自分だけ" : DEST[pub.dest].label;
  const settings = forced.web ? (
    <ShellPageSettings
      lang={lang}
      onLang={setLang}
      langNote={forced.note ? "言語を保存できませんでした" : undefined}
      author={{ name: ME.name, title: "", initial: ME.initial }}
      info={[
        { label: "作成", value: "2026-10-28" },
        { label: "更新", value: "2026-10-30" },
        ...(page.kind === "rec" ? [{ label: "録音", value: "14:38" }] : []),
        { label: "文字数", value: lang === "ja" ? "412" : "1,180 words" },
      ]}
      onExportMarkdown={noop}
      onDelete={noop}
    />
  ) : (
    <ShellPageSettings
      destination={
        dest && pub
          ? { dest, label: DEST[dest].label, url: urlOf(page, dest), updated: pub.updated, missing: missingFor(page, dest) }
          : undefined
      }
      category={dest && DEST[dest].cats.length ? { options: DEST[dest].cats, value: category, onPick: setCategory } : undefined}
      related={dest === "exp" ? { items: page.xs.flatMap((key) => (EXPERIENCES[key] ? [{ id: key, title: EXPERIENCES[key].title, by: EXPERIENCES[key].by }] : [])), max: 3 } : undefined}
      lang={lang}
      onLang={setLang}
      author={{ name: ME.name, title: lang === "ja" ? ME.titleJa : ME.titleEn, initial: ME.initial }}
      info={[
        { label: "作成", value: page.id === "j1030" ? "2026-10-30" : "2026-10-28" },
        { label: "更新", value: page.saved },
        ...(page.kind === "rec" ? [{ label: "録音", value: "14:38 · 2026-10-29" }] : []),
        { label: "文字数", value: lang === "ja" ? "412" : "1,180 words" },
      ]}
      onExportMarkdown={noop}
      onExportGoogle={noop}
    />
  );
  const rail = !hasRail ? undefined : forced.web ? (
    <ShellRail label="このページの設定" onClose={() => setRailOpen(false)}>
      <ShellRailSection title="ページ設定" summary="自分だけ" open={cards.page} onToggle={() => setCards((c) => ({ ...c, page: !c.page }))}>
        {settings}
      </ShellRailSection>
    </ShellRail>
  ) : (
    <ShellRail onClose={() => setRailOpen(false)}>
      {steps && (
        <ShellRailSection title={steps.root.recipe ?? "手順"} icon="spark" summary={steps.steps.find((s) => s.id === page.id)?.label ?? ""} open={cards.steps} onToggle={() => setCards((c) => ({ ...c, steps: !c.steps }))}>
          <ShellSteps steps={steps.steps} currentId={page.id} onSelect={(stepId) => navigate(`page:${stepId}`)} onRedo={page.parent ? () => undefined : undefined} />
        </ShellRailSection>
      )}
      <ShellRailSection title="ページ設定" summary={pageSummary} open={cards.page} onToggle={() => setCards((c) => ({ ...c, page: !c.page }))}>
        {settings}
      </ShellRailSection>
      <ShellRailSection title="AIと作る" icon="spark" fill>
        <ShellChat
          messages={chat}
          recording={page.kind === "rec"}
          value={draft}
          onChange={setDraft}
          onSend={() => {
            const text = draft.trim();
            if (!text) return;
            setChat((messages) => [...messages, { id: `m${messages.length + 1}`, who: "me", text }, { id: `m${messages.length + 2}`, who: "ai", text: "読んで、直すところをまとめました。" }]);
            setDraft("");
          }}
          onAction={(_message, action) => {
            if (action === "view") setProposalOpen(true);
          }}
        />
      </ShellRailSection>
    </ShellRail>
  );

  let canvas;
  if (isStart) {
    canvas = (
      <RecordingStart
        how={how}
        onHow={setHow}
        // web: まだ選んでいない状態で、editor-web が出す取り込める形式の一言（長い方）を見せる
        file={forced.web ? undefined : { name: "dinner-1029.m4a", detail: "14:38 · 32 MB · 別のファイルを選ぶ" }}
        fileHint={forced.web ? ".m4a .mp3 .wav .aac .ogg .flac .webm、文字起こし済みの .vtt も" : undefined}
        background={background}
        onBackground={setBackground}
        people={[
          { name: "Takuya", tone: "a" },
          { name: "Mika", tone: "b" },
        ]}
        terms="北鎌倉 · 円覚寺 · 材木座 · NIHO kamakura"
        next={next}
        onNext={setNext}
        onStart={() => navigate("page:rec")}
      />
    );
  } else {
    const blocks = def?.sel ? withSelection(page.body) : page.body;
    const started = Boolean(page.children?.length);
    const meta =
      page.id === "j1030"
        ? [{ text: "木曜日" }, { text: "晴れ" }]
        : page.kind === "rec"
          ? [{ text: "14:38", icon: "mic" as const }, { text: "2026-10-29" }]
          : isNew
            ? []
            : [{ author: ME.name, initial: ME.initial, text: page.saved }];
    canvas = (
      <ShellPage
        kind={page.kind}
        lang={page.lang}
        title={page.title}
        cover={page.kind === "article" ? (page.cover ? "set" : "none") : undefined}
        kicker={dest && page.cat ? page.cat : undefined}
        meta={meta}
        lead={page.kind === "article" ? (page.lead ?? "") : undefined}
        band={
          steps ? (
            <ShellSteps
              band
              title={`${steps.root.recipe ?? "手順"}の手順`}
              steps={steps.steps}
              currentId={page.id}
              note={`「${steps.steps.find((step) => step.state === "run")?.label ?? steps.steps[0]!.label}」を作成中です。画面を閉じても進みます。`}
              actions={[
                { id: "redo", label: "この手順を作り直す", tone: "primary" },
                { id: "restart", label: "はじめから作り直す", tone: "outline" },
              ]}
              onAction={noop}
              onSelect={(stepId) => navigate(`page:${stepId}`)}
            />
          ) : undefined
        }
        bodyPlaceholder={page.st === "run" ? "作成中…" : page.st === "wait" ? "前の手順が終わると作成します" : undefined}
        media={
          page.kind === "rec" ? (
            <>
              <TranscriptDemo forced={forced} />
              {!started && <ShellMakeFrom />}
            </>
          ) : undefined
        }
        footer={<ShellAddRow hint={isNew} menuOpen={blockMenu} onToggle={() => setBlockMenu(true)} onPick={() => setBlockMenu(false)} onClose={() => setBlockMenu(false)} />}
        proposal={
          proposalOpen ? (
            <ShellProposal
              label="整える"
              blocks={MEMO_PROPOSAL.map((block) => (proposalDone.includes(block.id) ? { ...block, done: true } : block))}
              onAccept={(blockId) => setProposalDone((done) => [...done, blockId])}
              onKeep={(blockId) => setProposalDone((done) => [...done, blockId])}
              onAcceptAll={() => setProposalOpen(false)}
              onClose={() => setProposalOpen(false)}
            />
          ) : undefined
        }
      >
        <ShellBody blocks={blocks} />
      </ShellPage>
    );
  }

  return (
    <EditorShell
      sidebar={sidebar}
      header={header}
      rail={rail}
      toolbar={isStart ? undefined : <ShellMobileToolbar onAction={onTool} blockMenuOpen={blockMenu} />}
      sidebarOpen={sidebarOpen}
      railOpen={railOpen && hasRail}
      overlay={
        sheet && (
          <PublishFlow
            key={`${sheet}:${page.id}`}
            page={page}
            kind={sheet}
            pick={initialSheet === "publish" ? forced.pick : undefined}
            conn={forced.conn}
            onClose={() => setSheet(null)}
            onFix={(fixId) => {
              setSheet(null);
              if (fixId === "cat" || fixId === "lang") {
                setRailOpen(true);
                setCards((c) => ({ ...c, page: true }));
              }
            }}
            onPublished={(dest, range) => setPublished({ dest, range, date: "2026-10-30" })}
            onUnpublish={() => {
              setPublished(page.pub ? { ...page.pub, range: "stopped", updated: false } : undefined);
              setSheet(null);
            }}
          />
        )
      }
    >
      {canvas}
    </EditorShell>
  );
}
