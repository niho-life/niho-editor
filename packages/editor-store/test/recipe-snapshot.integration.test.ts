import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { applyMigrations, defaultMigrationsDir, MIGRATION_FILE_PATTERN } from "../src/migrate.ts";
import { parseRecipeSnapshot } from "../src/recipe-snapshot.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const migration = "20261103020315_recipe_run_snapshot.sql";

describe("recipe snapshot migration backfill", { skip: databaseUrl === undefined }, () => {
  const schema = `editor_snapshot_${randomUUID().replaceAll("-", "")}`;
  let pool: Pool;
  let directory: string;

  before(async () => {
    const { Pool: PgPool } = await import("pg");
    pool = new PgPool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    directory = await mkdtemp(join(tmpdir(), "editor-snapshot-migrations-"));
    for (const name of await readdir(defaultMigrationsDir)) {
      if (MIGRATION_FILE_PATTERN.test(name) && name !== migration) await copyFile(new URL(name, defaultMigrationsDir), join(directory, name));
    }
  });

  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  });

  it("backfills stored recipes and leaves an unavailable legacy recipe unusable", async () => {
    const client = await pool.connect();
    try {
      await applyMigrations(client, pathToFileURL(`${directory}/`));
      const page = (await client.query<{ id: string }>("INSERT INTO pages(owner,kind,title) VALUES ('synthetic-owner','rec','synthetic') RETURNING id")).rows[0]!.id;
      await client.query(
        "INSERT INTO recipes(owner,id,name,guide,steps,revision) VALUES ('synthetic-owner','r-test','Old design','guide',$1::jsonb,4)",
        [JSON.stringify([{ id: "step-one", name: "Old step", instruction: "Old instruction", profile: "light" }])],
      );
      const stored = (await client.query<{ id: string }>("INSERT INTO step_runs(owner,parent,recipe,state) VALUES ('synthetic-owner',$1,'r-test','succeeded') RETURNING id", [page])).rows[0]!.id;
      const missing = (await client.query<{ id: string }>("INSERT INTO step_runs(owner,parent,recipe,state) VALUES ('synthetic-owner',$1,'r-missing','failed') RETURNING id", [page])).rows[0]!.id;
      const builtin = (await client.query<{ id: string }>("INSERT INTO step_runs(owner,parent,recipe,state) VALUES ('synthetic-owner',$1,'tpl-1','succeeded') RETURNING id", [page])).rows[0]!.id;
      await client.query("INSERT INTO editor_settings(owner,recipes) VALUES ('synthetic-owner',$1::jsonb)", [JSON.stringify([{ id: "r-carried", name: "Carried", guide: "Old guide", steps: [{ id: "carried-1", name: "Carried step", instruction: "Carried instruction" }] }])]);
      const carried = (await client.query<{ id: string }>("INSERT INTO step_runs(owner,parent,recipe,state) VALUES ('synthetic-owner',$1,'r-carried','succeeded') RETURNING id", [page])).rows[0]!.id;
      await copyFile(new URL(migration, defaultMigrationsDir), join(directory, migration));
      await applyMigrations(client, pathToFileURL(`${directory}/`));
      const rows = await client.query<{ id: string; recipe_snapshot: unknown; recipe_revision: number | null }>(
        "SELECT id,recipe_snapshot,recipe_revision FROM step_runs WHERE id=ANY($1::uuid[])", [[stored, missing, builtin, carried]],
      );
      const valid = rows.rows.find((row) => row.id === stored)!;
      assert.equal(valid.recipe_revision, 4);
      assert.equal(parseRecipeSnapshot(valid.recipe_snapshot)?.steps[0]?.profile, "light");
      const unavailable = rows.rows.find((row) => row.id === missing)!;
      assert.equal(unavailable.recipe_revision, null);
      assert.equal(parseRecipeSnapshot(unavailable.recipe_snapshot), null);
      assert.equal(parseRecipeSnapshot(rows.rows.find((row) => row.id === builtin)?.recipe_snapshot)?.steps[0]?.profile, "light");
      assert.equal(parseRecipeSnapshot(rows.rows.find((row) => row.id === carried)?.recipe_snapshot)?.steps[0]?.profile, "standard");
    } finally {
      client.release();
    }
  });
});
