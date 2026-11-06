import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import {
  CONVERSATION_MESSAGE_LIMIT,
  MESSAGE_JSON_MAX_BYTES,
  appendChatTurn,
  appendTurn,
  getChatChanges,
  listChatWorkspace,
  markChangesUndone,
  getAssistantMessage,
  getConversation,
  listConversations,
  recordAdoption,
  type AiTurnInput,
} from "../src/ai-conversations.ts";
import { applyMigrations } from "../src/migrate.ts";
import { EditorStore } from "../src/store.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID・文だけを使う（実在の人・実際の会話を入れない）
const OWNER = "synthetic-chat-owner-a";
const OTHER = "synthetic-chat-owner-b";

const proposal = {
  label: "整える",
  baseRevision: 1,
  changes: [{ index: 0, before: "合成のまえ", after: "合成のあと", parts: [{ ins: "合成のあと" }] }],
  inserts: [],
  unchanged: 1,
};

function turn(pageId: string, extra: Partial<AiTurnInput> = {}): AiTurnInput {
  return {
    pageId,
    request: { text: "整える", preset: "tidy" },
    result: { text: "提案が 1 件あります", proposal },
    ...extra,
  };
}

async function withSchema(label: string): Promise<{ pool: PgPool; drop: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const schema = `editor_store_${label}_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema}` });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  return {
    pool,
    drop: async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    },
  };
}

describe("AI conversations", { skip: databaseUrl ? false : "TEST_DATABASE_URL is not set" }, () => {
  let pool: PgPool;
  let drop: () => Promise<void>;
  let store: EditorStore;

  before(async () => {
    ({ pool, drop } = await withSchema("chat"));
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
    store = new EditorStore(pool);
  });

  after(async () => {
    await drop();
  });

  const newPage = async (owner = OWNER): Promise<string> => {
    const page = await store.createPage(owner, { title: "合成のページ", blocks: [{ type: "paragraph", content: [{ type: "text", text: "合成のまえ" }] }] });
    return page.id;
  };

  it("starts a conversation on the first turn and keeps the two messages in order", async () => {
    const pageId = await newPage();
    const first = await appendTurn(pool, OWNER, turn(pageId));
    assert.ok(first);
    assert.equal(first.request.role, "user");
    assert.equal(first.request.text, "整える");
    assert.equal(first.request.preset, "tidy");
    assert.equal(first.result.role, "assistant");
    assert.deepEqual(first.result.proposal, proposal);
    assert.equal(first.result.preset, null);
    assert.equal(first.request.seq, 1);
    assert.equal(first.result.seq, 2);
    assert.equal(first.conversation.messages, 2);
    assert.equal(first.conversation.lastText, "提案が 1 件あります");

    const second = await appendTurn(pool, OWNER, turn(pageId, { conversationId: first.conversation.id, request: { text: "もっと短く" } }));
    assert.ok(second);
    assert.equal(second.conversation.id, first.conversation.id);
    assert.equal(second.request.seq, 3);
    assert.equal(second.request.preset, null);
    assert.equal(second.conversation.messages, 4);

    const opened = await getConversation(pool, OWNER, pageId, first.conversation.id);
    assert.ok(opened);
    assert.deepEqual(
      opened.messages.map((message) => [message.seq, message.role, message.text]),
      [
        [1, "user", "整える"],
        [2, "assistant", "提案が 1 件あります"],
        [3, "user", "もっと短く"],
        [4, "assistant", "提案が 1 件あります"],
      ],
    );
  });

  it("answers only the owner's own conversations (another owner and a missing page are both null)", async () => {
    const pageId = await newPage();
    const mine = await appendTurn(pool, OWNER, turn(pageId));
    assert.ok(mine);

    // 他人のページには足せない・読めない（無いページと同じ null）
    assert.equal(await appendTurn(pool, OTHER, turn(pageId)), null);
    assert.equal(await appendTurn(pool, OWNER, turn(randomUUID())), null);
    assert.equal(await getConversation(pool, OTHER, pageId, mine.conversation.id), null);
    assert.equal(await listConversations(pool, OTHER, pageId), null);
    assert.equal(await listConversations(pool, OWNER, randomUUID()), null);
    assert.equal(await getAssistantMessage(pool, OTHER, pageId, mine.result.id), null);

    // 他人の会話の id を自分のページに持ち込んでも続けられない
    const theirPage = await newPage(OTHER);
    const theirs = await appendTurn(pool, OTHER, turn(theirPage));
    assert.ok(theirs);
    assert.equal(await appendTurn(pool, OWNER, turn(pageId, { conversationId: theirs.conversation.id })), null);
    // 自分の別のページの会話も、このページの会話ではない
    const otherPageOfMine = await newPage();
    assert.equal(await appendTurn(pool, OWNER, turn(otherPageOfMine, { conversationId: mine.conversation.id })), null);
  });

  it("lists the conversations of one page, newest first", async () => {
    const pageId = await newPage();
    const first = await appendTurn(pool, OWNER, turn(pageId));
    const second = await appendTurn(pool, OWNER, turn(pageId));
    assert.ok(first && second);
    const list = await listConversations(pool, OWNER, pageId);
    assert.deepEqual(list?.map((item) => item.id), [second.conversation.id, first.conversation.id]);
    assert.equal(list?.[0]?.pageId, pageId);
    assert.equal(list?.[0]?.messages, 2);
  });

  it("writes the adoption on the proposal that was adopted, once", async () => {
    const pageId = await newPage();
    const added = await appendTurn(pool, OWNER, turn(pageId));
    assert.ok(added);
    const adopted = { changes: [{ index: 0, text: "合成のあと" }], inserts: [] };
    assert.equal(await recordAdoption(pool, OWNER, { pageId, messageId: added.result.id, version: 3, adopted }), true);

    const message = await getAssistantMessage(pool, OWNER, pageId, added.result.id);
    assert.deepEqual(message?.adopted, adopted);
    assert.equal(message?.version, 3);
    assert.ok(message?.adoptedAt);

    // 2 回目は書かない（採用は 1 度だけ）
    assert.equal(await recordAdoption(pool, OWNER, { pageId, messageId: added.result.id, version: 4, adopted }), false);
    assert.equal((await getAssistantMessage(pool, OWNER, pageId, added.result.id))?.version, 3);

    // 他人は書けない。人の発言にも書けない
    const other = await appendTurn(pool, OWNER, turn(pageId));
    assert.ok(other);
    assert.equal(await recordAdoption(pool, OTHER, { pageId, messageId: other.result.id, version: 1, adopted }), false);
    assert.equal(await recordAdoption(pool, OWNER, { pageId, messageId: other.request.id, version: 1, adopted }), false);
    assert.equal((await getAssistantMessage(pool, OWNER, pageId, other.result.id))?.adopted, null);
  });

  it("refuses text and JSON that are too big, before writing", async () => {
    const pageId = await newPage();
    await assert.rejects(() => appendTurn(pool, OWNER, turn(pageId, { request: { text: "" } })), TypeError);
    await assert.rejects(() => appendTurn(pool, OWNER, turn(pageId, { request: { text: "あ".repeat(4_001) } })), TypeError);
    await assert.rejects(() => appendTurn(pool, OWNER, turn(pageId, { request: { text: "a\u0000b" } })), TypeError);
    await assert.rejects(() => appendTurn(pool, OWNER, turn(pageId, { request: { text: "整える", preset: "not a preset" } })), TypeError);
    await assert.rejects(() => appendTurn(pool, OWNER, turn(pageId, { result: { text: "x", proposal: "not an object" } })), TypeError);
    const huge = { label: "x", big: "あ".repeat(MESSAGE_JSON_MAX_BYTES) };
    await assert.rejects(() => appendTurn(pool, OWNER, turn(pageId, { result: { text: "x", proposal: huge } })), TypeError);
    assert.deepEqual(await listConversations(pool, OWNER, pageId), []);
  });

  it("returns the newest messages when a conversation is longer than the limit", async () => {
    const pageId = await newPage();
    const first = await appendTurn(pool, OWNER, turn(pageId));
    assert.ok(first);
    const id = first.conversation.id;
    const turns = CONVERSATION_MESSAGE_LIMIT / 2 + 3;
    for (let index = 1; index < turns; index++) {
      await appendTurn(pool, OWNER, turn(pageId, { conversationId: id, request: { text: `${index} 回目` } }));
    }
    const opened = await getConversation(pool, OWNER, pageId, id);
    assert.equal(opened?.messages.length, CONVERSATION_MESSAGE_LIMIT);
    assert.equal(opened?.conversation.messages, turns * 2);
    // 古い方が落ちて、並びは古い順のまま
    assert.equal(opened?.messages[0]?.seq, turns * 2 - CONVERSATION_MESSAGE_LIMIT + 1);
    assert.equal(opened?.messages.at(-1)?.seq, turns * 2);
  });

  it("goes away with the page it belongs to (the trash purge is not blocked)", async () => {
    const pageId = await newPage();
    const added = await appendTurn(pool, OWNER, turn(pageId));
    assert.ok(added);
    assert.ok(await store.deletePage(OWNER, pageId));
    // ゴミ箱の中のページの会話は読めない
    assert.equal(await listConversations(pool, OWNER, pageId), null);
    // 保持の日数を過ぎたことにする（purgeTrash は 1 日以上しか受け取らない）
    await pool.query(
      `UPDATE pages
          SET created_at = created_at - make_interval(days => 32),
              updated_at = updated_at - make_interval(days => 32),
              deleted_at = deleted_at - make_interval(days => 31)
        WHERE id = $1`,
      [pageId],
    );
    const purged = await store.purgeTrash();
    assert.ok(purged.pages >= 1);
    const rows = await pool.query("SELECT count(*)::int AS count FROM ai_conversations WHERE id = $1", [added.conversation.id]);
    assert.equal(rows.rows[0]?.count, 0);
    const messages = await pool.query("SELECT count(*)::int AS count FROM ai_messages WHERE conversation_id = $1", [added.conversation.id]);
    assert.equal(messages.rows[0]?.count, 0);
  });

  describe("the AI chat (the AI writes the pages itself)", () => {
    it("keeps the work, the reply and the pages the turn changed", async () => {
      const pageId = await newPage();
      const added = await appendChatTurn(pool, OWNER, {
        pageId,
        input: "見出しを付けて",
        reply: "見出しを 2 つ付けました。",
        items: [
          { kind: "narration", text: "本文を読みます。" },
          { kind: "tool", tool: "read_page", page: "合成のページ", ok: true },
          { kind: "tool", tool: "write_page", page: "合成のページ", ok: true },
        ],
        result: "done",
        changes: [{ pageId, change: "edited", version: 1, revision: 2, chars: 120, delta: 20 }],
      });
      assert.ok(added);
      assert.equal(added.request.text, "見出しを付けて");
      assert.equal(added.result.result, "done");
      assert.equal(added.result.resultCode, null);
      assert.equal((added.result.items as unknown[]).length, 3);
      assert.deepEqual(
        added.result.changes.map((change) => [change.pageId, change.change, change.version, change.revision, change.delta, change.undoneAt]),
        [[pageId, "edited", 1, 2, 20, null]],
      );

      const opened = await getConversation(pool, OWNER, pageId, added.conversation.id);
      assert.equal(opened?.messages.length, 2);
      assert.equal(opened?.messages[1]?.changes.length, 1);
      assert.equal(opened?.messages[1]?.changes[0]?.title, "合成のページ");
    });

    it("keeps one row per page in a turn (the version stays the one from before the turn)", async () => {
      const pageId = await newPage();
      const added = await appendChatTurn(pool, OWNER, {
        pageId,
        input: "二回直して",
        reply: "直しました。",
        items: [],
        result: "done",
        changes: [
          { pageId, change: "edited", version: 1, revision: 2, chars: 100, delta: 10 },
          { pageId, change: "edited", version: 2, revision: 3, chars: 90, delta: -10 },
        ],
      });
      assert.ok(added);
      assert.deepEqual(
        added.result.changes.map((change) => [change.version, change.revision, change.chars, change.delta]),
        [[1, 3, 90, 0]],
      );
    });

    it("answers the changes only to the owner, and marks the ones that were put back", async () => {
      const pageId = await newPage();
      const added = await appendChatTurn(pool, OWNER, {
        pageId,
        input: "直して",
        reply: "直しました。",
        items: [],
        result: "done",
        changes: [{ pageId, change: "edited", version: 1, revision: 2, chars: 10, delta: 1 }],
      });
      assert.ok(added);
      assert.equal((await getChatChanges(pool, OTHER, pageId, added.result.id)), null);
      assert.equal((await getChatChanges(pool, OWNER, randomUUID(), added.result.id)), null);
      assert.equal((await getChatChanges(pool, OWNER, pageId, added.result.id))?.length, 1);

      assert.equal(await markChangesUndone(pool, OTHER, added.result.id, [pageId]), 0);
      assert.equal(await markChangesUndone(pool, OWNER, added.result.id, [pageId]), 1);
      // 戻したものは「戻すもの」には出ない（二度は戻さない）
      assert.deepEqual(await getChatChanges(pool, OWNER, pageId, added.result.id), []);
      assert.equal(await markChangesUndone(pool, OWNER, added.result.id, [pageId]), 0);
      const all = await getChatChanges(pool, OWNER, pageId, added.result.id, { undone: true });
      assert.ok(all?.[0]?.undoneAt);
    });

    it("records a turn that failed or stopped, with the short code", async () => {
      const pageId = await newPage();
      const stopped = await appendChatTurn(pool, OWNER, {
        pageId,
        input: "長いことをして",
        reply: "",
        items: [],
        result: "stopped",
        resultCode: "quota_exceeded",
      });
      assert.equal(stopped?.result.result, "stopped");
      assert.equal(stopped?.result.resultCode, "quota_exceeded");
      // 返答が無いときも発言は残る（何が起きたかが会話に出る）
      assert.equal(stopped?.result.text, "（返答はありません）");
      await assert.rejects(
        () => appendChatTurn(pool, OWNER, { pageId, input: "x", reply: "y", items: [], result: "unknown" as "done" }),
        TypeError,
      );
      await assert.rejects(
        () => appendChatTurn(pool, OWNER, { pageId, input: "x", reply: "y", items: [], result: "done", resultCode: "NOT A CODE" }),
        TypeError,
      );
    });

    it("refuses a change without the version it could be undone to", async () => {
      const pageId = await newPage();
      await assert.rejects(
        () => appendChatTurn(pool, OWNER, { pageId, input: "x", reply: "y", items: [], result: "done", changes: [{ pageId, change: "edited", revision: 2, chars: 1, delta: 1 }] }),
        TypeError,
      );
      assert.deepEqual(await listConversations(pool, OWNER, pageId), []);
    });

    it("opens a workspace of the page, its parent and its subpages — and nothing else", async () => {
      const parent = await store.createPage(OWNER, { title: "合成の録音", kind: "rec" });
      const page = await store.createPage(OWNER, { title: "記事本文" });
      const child = await store.createPage(OWNER, { title: "下書き" });
      const far = await store.createPage(OWNER, { title: "別の場所" });
      await pool.query("UPDATE pages SET parent = $2 WHERE id = $1", [page.id, parent.id]);
      await pool.query("UPDATE pages SET parent = $2 WHERE id = $1", [child.id, page.id]);

      const workspace = await listChatWorkspace(pool, OWNER, page.id);
      assert.deepEqual(
        workspace?.map((item) => [item.title, item.open]).sort(),
        [
          ["下書き", false],
          ["合成の録音", false],
          ["記事本文", true],
        ].sort(),
      );
      assert.ok(!workspace?.some((item) => item.id === far.id));
      // 親がフォルダなら作業場に入れない（本文を持たない入れ物。同じフォルダのページは参考として読むだけ）。フォルダ自身は開けない
      const folder = await store.createPage(OWNER, { title: "合成のフォルダ", kind: "folder" });
      const inFolder = (await store.createPage(OWNER, { title: "フォルダの中", parent: folder.id }))!;
      assert.deepEqual(
        (await listChatWorkspace(pool, OWNER, inFolder.id))?.map((item) => item.title),
        ["フォルダの中"],
      );
      assert.equal(await listChatWorkspace(pool, OWNER, folder.id), null);
      // 他人のページ・無いページ・ゴミ箱の中は null
      assert.equal(await listChatWorkspace(pool, OTHER, page.id), null);
      assert.equal(await listChatWorkspace(pool, OWNER, randomUUID()), null);
      assert.ok(await store.deletePage(OWNER, page.id));
      assert.equal(await listChatWorkspace(pool, OWNER, page.id), null);
    });
  });
});
