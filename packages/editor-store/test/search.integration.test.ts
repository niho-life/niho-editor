import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pool as PgPool } from "pg";
import { applyMigrations, defaultMigrationsDir } from "../src/migrate.ts";
import { QueryTooLongError, SEARCH_SNIPPET_CHARS, searchPages, type SearchHit } from "../src/search.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID と合成の本文だけを使う（実在の人の値を入れない）
const OWNER = "synthetic-search-owner-a";
const OTHER = "synthetic-search-owner-b";

type Node = { readonly [key: string]: unknown };
const text = (value: string, marks?: Node[]): Node => (marks ? { type: "text", text: value, marks } : { type: "text", text: value });
const paragraph = (...content: Node[]): Node => ({ type: "paragraph", content });
const heading = (value: string): Node => ({ type: "heading", attrs: { level: 2 }, content: [text(value)] });
const bulletList = (...items: Node[][]): Node => ({ type: "bulletList", content: items.map((content) => ({ type: "listItem", content })) });
const blockquote = (...content: Node[]): Node => ({ type: "blockquote", content });

const BASE_TIME = Date.UTC(2026, 0, 1);

type PageSeed = { owner?: string; title?: string; blocks?: Node[]; at: number; deleted?: boolean; kind?: string };

async function newPool(schema: string): Promise<PgPool> {
  const { Pool } = await import("pg");
  return new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
}

/** store を通さずに行を入れる（更新時刻を決めて入れるため。0002 以降の列は既定値に任せる）。 */
async function insertPage(pool: PgPool, seed: PageSeed): Promise<string> {
  const at = new Date(BASE_TIME + seed.at * 1000);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO pages (owner, kind, title, blocks, created_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $5, CASE WHEN $6::boolean THEN $5::timestamptz END)
     RETURNING id`,
    [seed.owner ?? OWNER, seed.kind ?? "note", seed.title ?? "", JSON.stringify(seed.blocks ?? []), at, seed.deleted ?? false],
  );
  const id = result.rows[0]?.id;
  assert.ok(id);
  return id;
}

async function withSchema(label: string): Promise<{ pool: PgPool; drop: () => Promise<void> }> {
  const schema = `editor_store_${label}_${randomUUID().replaceAll("-", "")}`;
  const pool = await newPool(schema);
  await pool.query(`CREATE SCHEMA "${schema}"`);
  return {
    pool,
    drop: async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    },
  };
}

async function migrateAll(pool: PgPool): Promise<void> {
  const client = await pool.connect();
  try {
    await applyMigrations(client);
  } finally {
    client.release();
  }
}

const ids = (hits: SearchHit[]) => hits.map((hit) => hit.id);

describe("search_text on a database that only has 0001", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;
  let dir: string;

  before(async () => {
    ({ pool, drop } = await withSchema("search0003"));
    dir = await mkdtemp(join(tmpdir(), "editor-store-0003-"));
  });

  after(async () => {
    await drop();
    await rm(dir, { recursive: true, force: true });
  });

  it("fills search_text for rows written before 0003 and keeps it current afterwards", async () => {
    const migrations = fileURLToPath(defaultMigrationsDir);
    const dirUrl = pathToFileURL(`${dir}/`);
    await copyFile(join(migrations, "0001_editor_store.sql"), join(dir, "0001_editor_store.sql"));
    const client = await pool.connect();
    try {
      assert.deepEqual((await applyMigrations(client, dirUrl)).applied, ["0001_editor_store.sql"]);
      const nested = [
        paragraph(text("重要", [{ type: "bold" }]), text("な会議")),
        bulletList([paragraph(text("項目一"), { type: "hardBreak" }, text("次の行"))], [paragraph(text("項目二"))]),
        blockquote(paragraph(text("引用の文"))),
        { type: "horizontalRule" },
      ];
      const page = await insertPage(pool, { title: "合成の題名", blocks: nested, at: 1 });
      const empty = await insertPage(pool, { at: 2 });
      const removed = await insertPage(pool, { title: "削除した", blocks: [paragraph(text("ゴミ箱"))], at: 3, deleted: true });

      await copyFile(join(migrations, "0003_search_text.sql"), join(dir, "0003_search_text.sql"));
      const second = await applyMigrations(client, dirUrl);
      assert.deepEqual(second.applied, ["0003_search_text.sql"]);
      assert.deepEqual(second.skipped, ["0001_editor_store.sql"]);

      const rows = new Map(
        (await pool.query<{ id: string; search_text: string }>("SELECT id, search_text FROM pages")).rows.map((row) => [row.id, row.search_text]),
      );
      assert.equal(rows.get(page), "合成の題名\n重要な会議\n項目一\n次の行\n項目二\n引用の文");
      assert.equal(rows.get(empty), "\n");
      assert.equal(rows.get(removed), "削除した\nゴミ箱", "rows in the trash get a value too (the index and the search skip them)");

      // 保存のたびに新しくなる（保存のコードは search_text を知らない）
      await pool.query("UPDATE pages SET title = $2, blocks = $3::jsonb WHERE id = $1", [page, "新しい題名", JSON.stringify([paragraph(text("新しい本文"))])]);
      const updated = await pool.query<{ search_text: string }>("SELECT search_text FROM pages WHERE id = $1", [page]);
      assert.equal(updated.rows[0]?.search_text, "新しい題名\n新しい本文");
      // 直接は書けない
      await assert.rejects(() => pool.query("UPDATE pages SET search_text = 'x' WHERE id = $1", [page]), { code: "428C9" });

      const index = await pool.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'pages_search_text_trgm_idx' AND schemaname = current_schema()");
      assert.match(index.rows[0]?.indexdef ?? "", /USING gin \(search_text \S*gin_trgm_ops\) WHERE \(deleted_at IS NULL\)/);
      // 検索の SQL は今の schema（タブの列。#307 #308）を読むので、残りの migration を当ててから探す
      await applyMigrations(client);
      assert.deepEqual(ids(await searchPages(pool, OWNER, "新しい")), [page]);
    } finally {
      client.release();
    }
  });
});

describe("searchPages on PostgreSQL", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;
  const page: Record<string, string> = {};

  before(async () => {
    ({ pool, drop } = await withSchema("search"));
    await migrateAll(pool);
    // 更新時刻は at（秒）の順。大きいほど新しい
    const seeds: Record<string, PageSeed> = {
      titleOnly: { title: "Quokka の観察", blocks: [paragraph(text("本文はふつうのことば"))], at: 10 },
      bodyOnly: { title: "別の題名", blocks: [paragraph(text("今日は quokka を見た"))], at: 11 },
      both: { title: "QUOKKA 両方", blocks: [heading("見出し"), paragraph(text("本文にも QuOkKa がいる"))], at: 12, kind: "article" },
      deleted: { title: "Quokka ゴミ箱", blocks: [paragraph(text("quokka"))], at: 13, deleted: true },
      theirs: { owner: OTHER, title: "Quokka 他人", blocks: [paragraph(text("quokka ペンギン 鰻 100%"))], at: 14 },
      eel: { title: "夕飯", blocks: [paragraph(text("鰻を食べた"))], at: 15 },
      soba: { title: "昼", blocks: [paragraph(text("蕎麦屋に寄った"))], at: 16 },
      fruitBoth: { title: "買い物", blocks: [paragraph(text("りんご と みかん"))], at: 17 },
      fruitOne: { title: "買い物 2", blocks: [paragraph(text("りんご だけ"))], at: 18 },
      percent: { title: "達成", blocks: [paragraph(text("達成率 100% になった"))], at: 19 },
      thousand: { title: "件数", blocks: [paragraph(text("件数は 1000 になった"))], at: 20 },
      underscore: { title: "命名", blocks: [paragraph(text("snake_case で書く"))], at: 21 },
      noUnderscore: { title: "命名 2", blocks: [paragraph(text("snakeXcase で書く"))], at: 22 },
      backslash: { title: "道", blocks: [paragraph(text("C:\\temp に置く"))], at: 23 },
      noBackslash: { title: "道 2", blocks: [paragraph(text("C:temp に置く"))], at: 24 },
      nested: {
        title: "入れ子",
        blocks: [
          bulletList([paragraph(text("入れ子の項目ペンギン"))], [bulletList([paragraph(text("さらに深いアザラシ"))])]),
          blockquote(paragraph(text("引用のカワウソ"))),
          paragraph(text("重要", [{ type: "bold" }]), text("な会議"), text("のリンク", [{ type: "link", attrs: { href: "https://example.com/hidden-attr-value" } }])),
        ],
        at: 25,
      },
      long: {
        title: "長い本文",
        blocks: [paragraph(text("あ".repeat(300))), paragraph(text(`${"い".repeat(50)}ハリネズミ${"う".repeat(250)}`))],
        at: 26,
      },
      longTitleHit: { title: "題名にだけキリン", blocks: [paragraph(text("本文".repeat(100)))], at: 27 },
    };
    for (const [name, seed] of Object.entries(seeds)) page[name] = await insertPage(pool, seed);
  });

  after(async () => {
    await drop();
  });

  it("finds pages by title only, body only, and both, newest first, ignoring case", async () => {
    const hits = await searchPages(pool, OWNER, "quokka");
    assert.deepEqual(ids(hits), [page.both, page.bodyOnly, page.titleOnly]);
    for (const query of ["QUOKKA", "Quokka", "qUoKkA"]) assert.deepEqual(ids(await searchPages(pool, OWNER, query)), ids(hits), query);
    const both = hits[0];
    assert.ok(both);
    assert.deepEqual(Object.keys(both).sort(), ["id", "kind", "snippet", "tab", "title", "updatedAt"], "no search_text or owner in the result");
    assert.equal(both.tab, null, "タブが 1 つだけのページに札は無い（#308）");
    assert.equal(both.kind, "article");
    assert.equal(both.title, "QUOKKA 両方");
    assert.equal(both.updatedAt, new Date(BASE_TIME + 12_000).toISOString());
    assert.equal(both.snippet, "見出し 本文にも QuOkKa がいる");
    assert.equal(hits[2]?.snippet, "本文はふつうのことば", "a title-only hit shows the head of the body");
  });

  it("never returns another owner's pages or pages in the trash", async () => {
    for (const query of ["quokka", "ペンギン", "鰻", "100%", "ゴミ箱"]) {
      const found = ids(await searchPages(pool, OWNER, query));
      assert.ok(!found.includes(page.theirs!), query);
      assert.ok(!found.includes(page.deleted!), query);
    }
    assert.deepEqual(ids(await searchPages(pool, OTHER, "quokka")), [page.theirs]);
    assert.deepEqual(await searchPages(pool, "synthetic-nobody", "quokka"), []);
  });

  it("matches one- and two-character Japanese terms", async () => {
    assert.deepEqual(ids(await searchPages(pool, OWNER, "鰻")), [page.eel]);
    assert.deepEqual(ids(await searchPages(pool, OWNER, "蕎麦")), [page.soba]);
  });

  it("requires every space-separated term (AND), with half- or full-width spaces", async () => {
    assert.deepEqual(ids(await searchPages(pool, OWNER, "りんご")), [page.fruitOne, page.fruitBoth]);
    assert.deepEqual(ids(await searchPages(pool, OWNER, "りんご みかん")), [page.fruitBoth]);
    assert.deepEqual(ids(await searchPages(pool, OWNER, "  みかん\u3000りんご ")), [page.fruitBoth]);
    assert.deepEqual(ids(await searchPages(pool, OWNER, "りんご 存在しない語")), []);
    assert.deepEqual(ids(await searchPages(pool, OWNER, "買い物 みかん")), [page.fruitBoth], "a term in the title and a term in the body");
  });

  it("treats %, _ and \\ in the query literally", async () => {
    assert.deepEqual(ids(await searchPages(pool, OWNER, "100%")), [page.percent]);
    assert.deepEqual(ids(await searchPages(pool, OWNER, "%")), [page.percent]);
    assert.deepEqual(ids(await searchPages(pool, OWNER, "snake_case")), [page.underscore]);
    assert.deepEqual(ids(await searchPages(pool, OWNER, "_")), [page.underscore]);
    assert.deepEqual(ids(await searchPages(pool, OWNER, "C:\\t")), [page.backslash]);
    assert.deepEqual(ids(await searchPages(pool, OWNER, "\\")), [page.backslash]);
  });

  it("does not match JSON keys, node type names, or attribute values", async () => {
    for (const query of ["paragraph", "type", "text", "content", "marks", "bold", "attrs", "level", "heading", "bulletList", "listItem", "blockquote", "href", "hidden-attr-value", "example.com", "{", "\""]) {
      assert.deepEqual(await searchPages(pool, OWNER, query), [], query);
    }
  });

  it("finds text nested in lists and quotes, and words split by marks", async () => {
    for (const query of ["ペンギン", "アザラシ", "カワウソ", "重要な会議のリンク"]) {
      assert.deepEqual(ids(await searchPages(pool, OWNER, query)), [page.nested], query);
    }
  });

  it("limits the number of results to the newest ones", async () => {
    const all = await searchPages(pool, OWNER, "に");
    assert.ok(all.length >= 4);
    for (let index = 1; index < all.length; index++) {
      assert.ok(all[index - 1]!.updatedAt >= all[index]!.updatedAt, "newest first");
    }
    assert.deepEqual(ids(await searchPages(pool, OWNER, "に", { limit: 2 })), ids(all).slice(0, 2));
    assert.equal((await searchPages(pool, OWNER, "に", { limit: 1 })).length, 1);
    await assert.rejects(() => searchPages(pool, OWNER, "に", { limit: 101 }), RangeError);
  });

  it("builds a short snippet around the first hit in the body", async () => {
    const [hit] = await searchPages(pool, OWNER, "ハリネズミ");
    assert.ok(hit);
    assert.equal(hit.id, page.long);
    assert.ok(hit.snippet.startsWith("…") && hit.snippet.endsWith("…"), hit.snippet);
    assert.ok(hit.snippet.includes("ハリネズミ"));
    assert.ok(!/[\n\r\t]/.test(hit.snippet));
    assert.ok(Array.from(hit.snippet).length <= SEARCH_SNIPPET_CHARS + 2);
    // 段落の境目（改行）は空白になる
    const [boundary] = await searchPages(pool, OWNER, "あい");
    assert.equal(boundary, undefined, "paragraphs are separated, so a term does not run across them");
    const [across] = await searchPages(pool, OWNER, "ハリネズミ あ");
    assert.ok(across?.snippet.includes("ハリネズミ"), "the snippet follows the first term of the query");

    const [titleHit] = await searchPages(pool, OWNER, "キリン");
    assert.ok(titleHit);
    assert.equal(titleHit.snippet, `${"本文".repeat(SEARCH_SNIPPET_CHARS / 2)}…`, "title-only hit: the head of the body");
  });

  it("answers [] for an empty query and refuses a query longer than 100 characters", async () => {
    assert.deepEqual(await searchPages(pool, OWNER, ""), []);
    assert.deepEqual(await searchPages(pool, OWNER, "ぬ".repeat(100)), [], "100 characters is still allowed");
    await assert.rejects(() => searchPages(pool, OWNER, "あ".repeat(101)), QueryTooLongError);
  });
});

/** 決まった種から同じ列を出す擬似乱数（合成の本文を毎回同じにする）。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const WORDS = [
  "今日", "会議", "記録", "打ち合わせ", "予定", "メモ", "確認", "資料", "共有", "進捗", "課題", "対応", "連絡", "調整", "整理",
  "散歩", "天気", "晴れ", "雨", "朝ごはん", "読書", "映画", "音楽", "写真", "旅行", "電車", "駅", "公園", "図書館", "台所",
  "meeting", "notes", "draft", "review", "plan", "summary", "idea", "todo", "release", "design",
  "、", "。", "について", "を", "に", "で", "と", "は", "が", "した", "する", "ための", "あとで",
];

describe("searchPages with 1,000 pages", { skip: databaseUrl === undefined }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;
  const mine = new Set<string>();

  before(async () => {
    ({ pool, drop } = await withSchema("searchperf"));
    await migrateAll(pool);
    // 入れるもの: 自分のページ 1,000 件と別の owner のページ 1,000 件（同じ語彙）。本文は 300〜1,000 字の合成の文を
    // 段落・箇条書きに分けたもの。それぞれの owner の 100 件に 1 件だけ「ハヤブサ」を入れる（当たりの少ない語）。
    const random = mulberry32(35);
    const owners: string[] = [];
    const titles: string[] = [];
    const bodies: string[] = [];
    const times: Date[] = [];
    for (let index = 0; index < 2000; index++) {
      const owner = index % 2 === 0 ? OWNER : OTHER;
      const target = 300 + Math.floor(random() * 700);
      const blocks: Node[] = [];
      let length = 0;
      while (length < target) {
        let sentence = "";
        while (sentence.length < 60) sentence += WORDS[Math.floor(random() * WORDS.length)];
        if (index % 200 < 2 && blocks.length === 1) sentence += "ハヤブサ";
        blocks.push(random() < 0.3 ? bulletList([paragraph(text(sentence))]) : paragraph(text(sentence)));
        length += sentence.length;
      }
      owners.push(owner);
      titles.push(`合成ページ ${index}`);
      bodies.push(JSON.stringify(blocks));
      times.push(new Date(BASE_TIME + index * 1000));
    }
    const inserted = await pool.query<{ id: string; owner: string }>(
      `INSERT INTO pages (owner, title, blocks, created_at, updated_at)
       SELECT owner, title, body::jsonb, at, at
         FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[]) AS seed (owner, title, body, at)
       RETURNING id, owner`,
      [owners, titles, bodies, times],
    );
    for (const row of inserted.rows) if (row.owner === OWNER) mine.add(row.id);
    assert.equal(mine.size, 1000);
    await pool.query("ANALYZE pages");
  });

  after(async () => {
    await drop();
  });

  it("answers each query within 300 ms and only with the owner's pages", async (t) => {
    // 測り方: searchPages（SQL の実行と snippet の組み立て。接続は温めた Pool）を 1 回空打ちしてから 5 回呼び、
    // それぞれの経過時間（performance.now）の最大を 300 ms と比べる。
    const queries = ["記録", "会議 記録", "ハヤブサ", "存在しない語", "の", "meeting notes", "朝ごはん 散歩 図書館"];
    const report: string[] = [];
    for (const query of queries) {
      await searchPages(pool, OWNER, query);
      let worst = 0;
      let hits: SearchHit[] = [];
      for (let run = 0; run < 5; run++) {
        const started = performance.now();
        hits = await searchPages(pool, OWNER, query, { limit: 100 });
        worst = Math.max(worst, performance.now() - started);
      }
      for (const hit of hits) assert.ok(mine.has(hit.id), `${query}: only the owner's pages`);
      report.push(`${query}: ${hits.length} hits, worst ${worst.toFixed(1)} ms`);
      assert.ok(worst < 300, `${query} took ${worst.toFixed(1)} ms`);
    }
    t.diagnostic(report.join(" / "));
    assert.equal((await searchPages(pool, OWNER, "ハヤブサ", { limit: 100 })).length, 10, "the rare term is in 10 of the owner's pages");
  });
});
