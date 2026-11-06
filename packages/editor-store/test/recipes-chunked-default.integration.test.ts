import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Pool as PgPool } from "pg";
import { applyMigrations, migrationBody, readMigrations } from "../src/migrate.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;

// 合成のユーザー ID と合成の手順だけを使う（実在の人の値を入れない）
const OWNER = "synthetic-chunked-default-owner-a";
const OTHER = "synthetic-chunked-default-owner-b";

const NAME = "20261106225704_recipes_chunked_default.sql";

type Step = Record<string, unknown>;

function step(id: string, name: string, extra: Step = {}): Step {
  return { id, name, instruction: `合成の指示 ${name}`, profile: "standard", ...extra };
}

describe("migration recipes_chunked_default on PostgreSQL", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_store_chunked_default_${randomUUID().replaceAll("-", "")}`;
  let pool: PgPool;
  let body = "";

  before(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: databaseUrl, max: 2, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
    const file = (await readMigrations()).find((candidate) => candidate.name === NAME);
    assert.ok(file, "the migration file exists");
    body = migrationBody(file);
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  // #277 の配備（migrate ジョブの開始）の前と後。migration は、前に最後に保存された行だけを対象にする
  const BEFORE_DEPLOY = "2026-11-06T10:00:00Z";
  const AFTER_DEPLOY = "2026-11-06T15:00:00Z";

  async function put(owner: string, id: string, steps: Step[], origin = "builtin", revision = 3, savedAt = BEFORE_DEPLOY): Promise<void> {
    await pool.query(
      `INSERT INTO recipes (owner, id, name, steps, origin, revision, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $7)
       ON CONFLICT (owner, id) DO UPDATE
         SET steps = EXCLUDED.steps, origin = EXCLUDED.origin, revision = EXCLUDED.revision,
             created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at`,
      [owner, id, `合成の ${id}`, JSON.stringify(steps), origin, revision, savedAt],
    );
  }

  async function read(owner: string, id: string): Promise<{ steps: Step[]; revision: number }> {
    const result = await pool.query<{ steps: Step[]; revision: number }>("SELECT steps, revision FROM recipes WHERE owner = $1 AND id = $2", [owner, id]);
    assert.ok(result.rows[0]);
    return result.rows[0];
  }

  async function migrate(): Promise<void> {
    await pool.query(body);
  }

  it("turns chunked on for the 文字起こし修正 step of the two default recipes, keeping the order and the other steps", async () => {
    const others = [step("r4t8wz3c", "記事方針"), step("h2n6v5pe", "記事本文")];
    await put(OWNER, "tpl-1", [step("k7m2q9xa", "文字起こし修正"), ...others]);
    await put(OWNER, "tpl-4", [step("c5v8n3qd", "文字起こし修正"), step("a3m9t6kw", "コーチング")]);
    await migrate();
    const article = await read(OWNER, "tpl-1");
    assert.deepEqual(article.steps, [step("k7m2q9xa", "文字起こし修正", { chunked: true }), ...others]);
    // 設計が変わったので revision が 1 つ進む（run の写しとの食い違いが帯に出て、利用者が更新できる）
    assert.equal(article.revision, 4);
    const coaching = await read(OWNER, "tpl-4");
    assert.deepEqual(coaching.steps, [step("c5v8n3qd", "文字起こし修正", { chunked: true }), step("a3m9t6kw", "コーチング")]);
    assert.equal(coaching.revision, 4);
  });

  it("changes nothing the second time (the migration is idempotent) and bumps revision only once", async () => {
    await put(OWNER, "tpl-1", [step("k7m2q9xa", "文字起こし修正"), step("r4t8wz3c", "記事方針")]);
    await migrate();
    await migrate();
    const after = await read(OWNER, "tpl-1");
    assert.equal(after.steps[0]?.chunked, true);
    assert.equal(after.revision, 4);
  });

  it("leaves alone what the person decided or changed: an explicit chunked value, a renamed step, a changed step id, a non-builtin row", async () => {
    await put(OWNER, "tpl-1", [step("k7m2q9xa", "文字起こし修正", { chunked: false }), step("r4t8wz3c", "記事方針")]);
    await migrate();
    // 設定で OFF にした段階は触らない（revision も進めない）
    assert.deepEqual(await read(OWNER, "tpl-1"), { steps: [step("k7m2q9xa", "文字起こし修正", { chunked: false }), step("r4t8wz3c", "記事方針")], revision: 3 });

    const renamed = [step("k7m2q9xa", "文字を整える"), step("r4t8wz3c", "記事方針")];
    await put(OWNER, "tpl-1", renamed);
    await migrate();
    assert.deepEqual(await read(OWNER, "tpl-1"), { steps: renamed, revision: 3 });

    const reidentified = [step("zzzzzzzz", "文字起こし修正"), step("r4t8wz3c", "記事方針")];
    await put(OWNER, "tpl-1", reidentified);
    await migrate();
    assert.deepEqual(await read(OWNER, "tpl-1"), { steps: reidentified, revision: 3 });

    const own = [step("k7m2q9xa", "文字起こし修正")];
    await put(OWNER, "tpl-1", own, "own");
    await put(OWNER, "r-mine", own);
    await migrate();
    assert.deepEqual(await read(OWNER, "tpl-1"), { steps: own, revision: 3 });
    assert.deepEqual(await read(OWNER, "r-mine"), { steps: own, revision: 3 });
  });

  it("leaves a row saved after the #277 deploy alone: a missing chunked key may be the person's own OFF (the save path drops false)", async () => {
    const saved = [step("k7m2q9xa", "文字起こし修正"), step("r4t8wz3c", "記事方針")];
    await put(OWNER, "tpl-1", saved, "builtin", 3, AFTER_DEPLOY);
    await migrate();
    assert.deepEqual(await read(OWNER, "tpl-1"), { steps: saved, revision: 3 });
    // 同じ行が配備の前に最後に保存されていれば、ON になる
    await put(OWNER, "tpl-1", saved, "builtin", 3, BEFORE_DEPLOY);
    await migrate();
    assert.equal((await read(OWNER, "tpl-1")).steps[0]?.chunked, true);
  });

  it("does not touch the other default recipes, and treats each owner on its own", async () => {
    const minutes = [step("d9c3x7mf", "文字起こし修正"), step("w5q1j8ks", "議事録")];
    await put(OWNER, "tpl-2", minutes);
    await put(OTHER, "tpl-1", [step("k7m2q9xa", "文字起こし修正")]);
    await put(OTHER, "tpl-4", [step("c5v8n3qd", "文字起こし修正", { chunked: true })], "builtin", 7);
    await migrate();
    assert.deepEqual(await read(OWNER, "tpl-2"), { steps: minutes, revision: 3 });
    assert.equal((await read(OTHER, "tpl-1")).steps[0]?.chunked, true);
    assert.equal((await read(OTHER, "tpl-1")).revision, 4);
    // すでに ON の人はそのまま
    assert.deepEqual(await read(OTHER, "tpl-4"), { steps: [step("c5v8n3qd", "文字起こし修正", { chunked: true })], revision: 7 });
  });
});
