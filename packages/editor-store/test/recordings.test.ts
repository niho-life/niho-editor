import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readMigrations } from "../src/migrate.ts";
import {
  InvalidRecordingError,
  RECORDING_SEGMENTS_MAX,
  RECORDING_SEGMENT_TEXT_MAX_CHARS,
  RECORDING_TEXT_MAX_BYTES,
  createRecordingPage,
  getRecording,
  isStorableText,
  recordingDataProblem,
  recordingTextBytes,
  updateRecording,
  type Connectable,
  type RecordingData,
  type RecordingSegment,
} from "../src/recordings.ts";
import type { Queryable } from "../src/types.ts";

const PAGE_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

const segment = (text: string, speaker: number | null = null, start: number | null = 0, end: number | null = 1): RecordingSegment => ({
  start,
  end,
  text,
  speaker,
});

/** DB に触れたら失敗する接続（DB に問い合わせずに null・例外になることを確かめる）。 */
const untouchable: Queryable & Connectable = {
  query: (() => {
    throw new Error("must not reach the database");
  }) as unknown as Queryable["query"],
  connect: () => {
    throw new Error("must not reach the database");
  },
};

describe("0007_page_recordings.sql", () => {
  it("declares one owner-scoped recording row per page with the documented checks, and depends only on 0001", async () => {
    const file = (await readMigrations()).find((candidate) => candidate.name === "0007_page_recordings.sql");
    assert.ok(file, "0007_page_recordings.sql exists");
    const sql = withoutComments(file.sql);
    const body = sql.match(/CREATE TABLE page_recordings \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.ok(body.length > 0, "page_recordings is created");
    assert.match(body, /page_id uuid PRIMARY KEY,/);
    assert.match(body, /owner text NOT NULL/);
    assert.match(body, /source text NOT NULL CHECK \(source IN \('vtt', 'audio'\)\)/);
    assert.match(body, /language text NOT NULL CHECK \(language IN \('ja', 'en'\)\)/);
    assert.match(body, /engine text CHECK \(engine IS NULL OR length\(engine\) BETWEEN 1 AND 64\)/);
    assert.match(body, /duration_sec numeric CHECK \(duration_sec IS NULL OR duration_sec >= 0\)/);
    assert.match(body, /source_sha256 text CHECK \(source_sha256 IS NULL OR source_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    assert.match(body, /segments jsonb NOT NULL CHECK \(jsonb_typeof\(segments\) = 'array'\)/);
    assert.match(body, /speaker_names jsonb NOT NULL DEFAULT '\{\}'::jsonb CHECK \(jsonb_typeof\(speaker_names\) = 'object'\)/);
    assert.match(body, /revision integer NOT NULL DEFAULT 1 CHECK \(revision > 0\)/);
    assert.match(body, new RegExp(`jsonb_array_length\\(segments\\) <= ${RECORDING_SEGMENTS_MAX}`));
    assert.match(body, /FOREIGN KEY \(owner, page_id\) REFERENCES pages \(owner, id\) ON DELETE CASCADE/);
    assert.match(body, /CHECK \(updated_at >= created_at\)/);
    // 0002（版・ゴミ箱。別の PR）に依存しない: 0001 の pages だけを参照し、ページの本文・資産を写さない
    assert.doesNotMatch(sql, /page_versions|publications|assets|page_shares/);
    for (const column of ["title", "blocks", "kind", "deleted_at", "bucket_path"]) {
      assert.doesNotMatch(body, new RegExp(`\\b${column}\\b`), `page_recordings must not carry ${column}`);
    }
  });
});

describe("recording_candidate_history migration", () => {
  it("adds candidate CAS, bounded immutable versions, idempotency receipts, adopted sync, and run revision fencing", async () => {
    const file = (await readMigrations()).find((candidate) => candidate.name.endsWith("_recording_candidate_history.sql"));
    assert.ok(file);
    const sql = withoutComments(file.sql);
    assert.match(sql, /ALTER TABLE page_recording_candidates\s+ADD COLUMN revision integer NOT NULL DEFAULT 1/);
    assert.match(sql, /CREATE TABLE page_recording_candidate_versions/);
    assert.match(sql, /REFERENCES page_recording_candidates \(id\) ON DELETE CASCADE/);
    assert.match(sql, /LIMIT 100/);
    assert.match(sql, /recording_candidate_force_revision/);
    assert.match(sql, /CREATE TABLE page_recording_candidate_operations/);
    assert.match(sql, /page_recording_candidate_operations_gc_idx/);
    assert.match(sql, /AFTER UPDATE OF engine, language, segments, speaker_names, duration_sec ON page_recordings/);
    assert.match(sql, /ADD COLUMN candidate_revision integer/);
    assert.match(sql, /transcription_runs_candidate_revision_pair/);
  });
});

describe("recordingDataProblem", () => {
  const valid: RecordingData = {
    segments: [segment("最初の段落", 1), segment("二つ目", 2, 1, 2.5), segment("時刻なし", null, null, null)],
    speakerNames: { "1": "合成の話し手" },
  };

  it("accepts the documented shape", () => {
    assert.equal(recordingDataProblem(valid), null);
    assert.equal(recordingDataProblem({ segments: [], speakerNames: {} }), null);
    assert.equal(recordingDataProblem({ segments: [segment("")], speakerNames: {} }), null, "an emptied paragraph is kept");
  });

  it("refuses anything but an array of four-field segments and an object of names", () => {
    for (const data of [null, [], "x", { segments: {}, speakerNames: {} }, { segments: [], speakerNames: [] }, { segments: [] }]) {
      assert.equal(recordingDataProblem(data), "segments", JSON.stringify(data));
    }
    assert.equal(recordingDataProblem({ segments: [{ start: 0, end: 1, text: "x" }], speakerNames: {} }), "segment");
    assert.equal(recordingDataProblem({ segments: [{ ...segment("x"), extra: 1 }], speakerNames: {} }), "segment");
    assert.equal(recordingDataProblem({ segments: ["x"], speakerNames: {} }), "segment");
  });

  it("refuses times that are not both null or an ordered pair of non-negative finite numbers", () => {
    for (const [start, end] of [[null, 1], [0, null], [-1, 1], [2, 1], [Number.NaN, 1], [0, Number.POSITIVE_INFINITY], ["0", 1]] as const) {
      assert.equal(recordingDataProblem({ segments: [{ start, end, text: "x", speaker: null }], speakerNames: {} }), "time", `${start}-${end}`);
    }
  });

  it("refuses text that is too long, has NUL, or has an unpaired surrogate", () => {
    assert.equal(recordingDataProblem({ segments: [segment("あ".repeat(RECORDING_SEGMENT_TEXT_MAX_CHARS))], speakerNames: {} }), null);
    assert.equal(recordingDataProblem({ segments: [segment("😀".repeat(RECORDING_SEGMENT_TEXT_MAX_CHARS))], speakerNames: {} }), null, "counted in code points");
    for (const text of ["あ".repeat(RECORDING_SEGMENT_TEXT_MAX_CHARS + 1), "a\u0000b", "a\ud800b", "\udc00"]) {
      assert.equal(recordingDataProblem({ segments: [segment(text)], speakerNames: {} }), "text");
    }
    assert.equal(recordingDataProblem({ segments: [{ ...segment("x"), text: 1 }], speakerNames: {} }), "text");
  });

  it("refuses paragraphs whose text adds up to more than 8 MiB of UTF-8", () => {
    const of = (count: number, chars: number) => ({ segments: Array.from({ length: count }, () => segment("あ".repeat(chars))), speakerNames: {} });
    assert.equal(RECORDING_TEXT_MAX_BYTES, 8 * 1024 * 1024);
    assert.equal(recordingTextBytes(of(2, 10).segments), 60);
    assert.equal(recordingDataProblem(of(500, RECORDING_SEGMENT_TEXT_MAX_CHARS)), null, "7.5 MB fits");
    assert.equal(recordingDataProblem(of(600, RECORDING_SEGMENT_TEXT_MAX_CHARS)), "size", "9 MB does not");
  });

  it("refuses more than the maximum number of segments", () => {
    const many = Array.from({ length: RECORDING_SEGMENTS_MAX + 1 }, () => segment("x"));
    assert.equal(recordingDataProblem({ segments: many.slice(1), speakerNames: {} }), null);
    assert.equal(recordingDataProblem({ segments: many, speakerNames: {} }), "segments");
  });

  it("accepts a length only when it is omitted, null, or a non-negative finite number", () => {
    assert.equal(recordingDataProblem({ ...valid, durationSec: 12.5 }), null);
    assert.equal(recordingDataProblem({ ...valid, durationSec: 0 }), null);
    assert.equal(recordingDataProblem({ ...valid, durationSec: null }), null, "null is 長さが分からない");
    for (const durationSec of [-1, Number.NaN, Number.POSITIVE_INFINITY, "12", {}]) {
      assert.equal(recordingDataProblem({ ...valid, durationSec }), "duration", JSON.stringify(durationSec));
    }
  });

  it("refuses speakers that are not positive integers", () => {
    for (const speaker of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 2]) {
      assert.equal(recordingDataProblem({ segments: [{ ...segment("x"), speaker }], speakerNames: {} }), "speaker", String(speaker));
    }
  });

  it("refuses names for speakers that no segment has, malformed keys, and malformed names", () => {
    assert.equal(recordingDataProblem({ segments: [segment("x", 1)], speakerNames: { "2": "合成" } }), "speaker_names");
    assert.equal(recordingDataProblem({ segments: [segment("x", 1)], speakerNames: { "01": "合成" } }), "speaker_names");
    assert.equal(recordingDataProblem({ segments: [segment("x")], speakerNames: { "1": "合成" } }), "speaker_names");
    for (const name of ["", " 合成", "合成 ", "a\tb", "a\u0000b", "あ".repeat(61), 1]) {
      assert.equal(recordingDataProblem({ segments: [segment("x", 1)], speakerNames: { "1": name } }), "name", JSON.stringify(name));
    }
    assert.equal(recordingDataProblem({ segments: [segment("x", 1)], speakerNames: { "1": "あ".repeat(60) } }), null);
  });

  it("isStorableText rejects only NUL and unpaired surrogates", () => {
    assert.equal(isStorableText("改行\nタブ\t絵文字😀"), true);
    assert.equal(isStorableText("\u0000"), false);
    assert.equal(isStorableText("\ud83d"), false);
  });
});

describe("recordings without a database", () => {
  it("treats ids that are not UUIDs as missing without querying", async () => {
    for (const id of ["", "not-a-uuid", "123", `${PAGE_ID}' OR '1'='1`]) {
      assert.equal(await getRecording(untouchable, "synthetic-owner", id), null);
      assert.equal(await updateRecording(untouchable, "synthetic-owner", id, 1, (data) => data), null);
    }
  });

  it("refuses an empty owner, a bad base revision, and data of the wrong shape before touching the database", async () => {
    await assert.rejects(() => getRecording(untouchable, "", PAGE_ID), TypeError);
    await assert.rejects(() => updateRecording(untouchable, "", PAGE_ID, 1, (data) => data), TypeError);
    for (const revision of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(() => updateRecording(untouchable, "synthetic-owner", PAGE_ID, revision, (data) => data), TypeError);
    }
    await assert.rejects(
      () => createRecordingPage(untouchable, "", { lang: "ja", source: "vtt", segments: [] }),
      TypeError,
    );
    await assert.rejects(
      () => createRecordingPage(untouchable, "synthetic-owner", { lang: "ja", source: "vtt", segments: [segment("x", 1)], speakerNames: { "2": "合成" } }),
      (error: unknown) => error instanceof InvalidRecordingError && error.problem === "speaker_names",
    );
    for (const [input, problem] of [
      [{ lang: "fr" }, "lang"],
      [{ source: "mic" }, "source"],
      [{ title: "あ".repeat(501) }, "title"],
      [{ engine: "" }, "engine"],
      [{ engine: "e".repeat(65) }, "engine"],
      [{ durationSec: -1 }, "duration"],
      [{ sourceName: "dir/a.vtt" }, "source_name"],
      [{ sourceName: "a\\b.vtt" }, "source_name"],
      [{ sourceName: "a\nb.vtt" }, "source_name"],
      [{ sourceSha256: "A".repeat(64) }, "source_sha256"],
    ] as const) {
      await assert.rejects(
        () => createRecordingPage(untouchable, "synthetic-owner", Object.assign({ lang: "ja", source: "vtt", segments: [] }, input) as never),
        (error: unknown) => error instanceof InvalidRecordingError && error.problem === problem,
        problem,
      );
    }
  });

  it("passes every value as a parameter, never inside the SQL text, and ends every transaction", async () => {
    const owner = "synthetic-owner'; DROP TABLE pages; --";
    const text = "合成の段落'); DELETE FROM page_recordings; --";
    const now = new Date(0);
    const row = {
      revision: 1, source: "vtt", language: "ja", engine: null, duration_sec: 1, source_name: null, source_sha256: null,
      segments: [segment(text, 1)], speaker_names: {}, created_at: now, updated_at: now,
    };
    const calls: string[] = [];
    let released = 0;
    const fake: Queryable & Connectable = {
      query: (async (sql: string) => {
        calls.push(sql);
        return { rows: [row] };
      }) as unknown as Queryable["query"],
      connect: async () => ({
        query: (async (sql: string) => {
          calls.push(sql);
          if (/INSERT INTO pages/.test(sql)) return { rows: [{ id: PAGE_ID, kind: "rec", title: text, lang: "ja", created_at: now, updated_at: now }] };
          return { rows: [row] };
        }) as never,
        release: () => {
          released += 1;
        },
      }),
    };
    await createRecordingPage(fake, owner, { title: text, lang: "ja", source: "vtt", segments: [segment(text, 1)], speakerNames: { "1": "合成'名" } });
    await getRecording(fake, owner, PAGE_ID);
    await updateRecording(fake, owner, PAGE_ID, 1, (data) => ({ ...data, speakerNames: { "1": "合成'名" } }));
    await updateRecording(fake, owner, PAGE_ID, 2, (data) => data);
    await updateRecording(fake, owner, PAGE_ID, 1, () => ({ rejected: "name" }));
    assert.ok(calls.length >= 10);
    for (const sql of calls) assert.ok(!sql.includes(owner) && !sql.includes(PAGE_ID) && !sql.includes(text) && !sql.includes("合成'名"), sql);
    assert.equal(released, 4, "every borrowed connection is released");
    assert.equal(calls.filter((sql) => sql === "BEGIN").length, 4);
    assert.equal(calls.filter((sql) => sql === "COMMIT" || sql === "ROLLBACK").length, 4);
  });
});
