import { createHash, randomUUID } from "node:crypto";
import {
  bindPhotoRequest,
  type Database,
} from "@niho/editor-store";
import { applyMigrations } from "@niho/editor-store/migrate";
import { Pool } from "pg";
import type { StartUploadRequest, VerifiedPhotoActor } from "../../../../../packages/photo-library-contract/src/v1";
import { createFakePhotoStorage } from "../../storage/photo-fake";
import { createPhotoTransferApi } from "../photo-transfer/api";
import { createP02PhotoTransferStore } from "../photo-transfer/p02";
import type { PhotoMutationJournal, PhotoProbe, ProbeResult } from "../photo-transfer/types";

export const CONFORMANCE_ORIGIN = "https://editor.synthetic.invalid";
export const SYNTHETIC_JPEG = Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 217]);
export const SYNTHETIC_PNG = (() => {
  const bytes = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(2, 16);
  bytes.writeUInt32BE(1, 20);
  bytes[24] = 8;
  bytes[25] = 0;
  return bytes;
})();

export const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export type ConformanceDatabaseEnv = {
  readonly CI?: string;
  readonly TEST_DATABASE_URL?: string;
};

export function conformanceDatabaseUrl(env: ConformanceDatabaseEnv = {
  CI: process.env.CI,
  TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
}): string | undefined {
  const value = env.TEST_DATABASE_URL;
  if (!value) {
    if (env.CI === "true") throw new Error("CI requires TEST_DATABASE_URL for photo conformance");
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("photo conformance requires a valid database URL");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("photo conformance requires PostgreSQL");
  const directTarget = url.search === "" && url.hash === "";
  const localFixture = directTarget && loopback && url.port === "56542";
  const ciFixture = directTarget && loopback && url.port === "5432" && url.username === "editor_ci" && url.pathname === "/editor_ci";
  if (env.CI === "true" ? !ciFixture : !localFixture) {
    throw new Error("photo conformance refuses a non-ephemeral database target");
  }
  return value;
}

export async function openConformanceDatabase(connectionString: string): Promise<{ pool: Pool; close: () => Promise<void> }> {
  const schema = `photo_conformance_${randomUUID().replaceAll("-", "")}`;
  if (!/^photo_conformance_[a-f0-9]{32}$/.test(schema)) throw new Error("invalid conformance schema name");
  const pool = new Pool({ connectionString, max: 12, options: `-c search_path=${schema}` });
  const dropSchema = async () => pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  let schemaCreated = false;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const client = await pool.connect();
    try {
      await applyMigrations(client);
    } finally {
      client.release();
    }
  } catch (error) {
    if (schemaCreated) await dropSchema().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
  return {
    pool,
    close: async () => {
      try {
        await dropSchema();
      } finally {
        await pool.end();
      }
    },
  };
}

function journal(db: Database): PhotoMutationJournal {
  return {
    bind: ({ owner, ...input }) => bindPhotoRequest(db, owner, input),
  };
}

export function actor(owner: string, transport: VerifiedPhotoActor["transport"] = "browser-session"): VerifiedPhotoActor {
  return {
    userId: owner,
    sessionId: `synthetic-session-${randomUUID()}`,
    transport,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}

export function post(body: unknown = {}, key = randomUUID(), origin = CONFORMANCE_ORIGIN): Request {
  return new Request(`${CONFORMANCE_ORIGIN}/api/photo/v1/uploads`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

export function get(): Request {
  return new Request(`${CONFORMANCE_ORIGIN}/api/photo/v1/content`);
}

export function originalRequest(bytes: Uint8Array = SYNTHETIC_JPEG): StartUploadRequest {
  return {
    target: { kind: "original", fileName: "synthetic.jpg", format: "jpeg" },
    sizeBytes: bytes.byteLength,
    sha256: digest(bytes),
    contentType: "image/jpeg",
  };
}

export function maskRequest(photoId: string, bytes: Uint8Array = SYNTHETIC_PNG): StartUploadRequest {
  return {
    target: { kind: "mask", photoId },
    sizeBytes: bytes.byteLength,
    sha256: digest(bytes),
    contentType: "image/png",
  };
}

export function createConformanceHarness(db: Database) {
  const clock = () => Date.now();
  const fake = createFakePhotoStorage(clock);
  const store = createP02PhotoTransferStore(db);
  let probeResult: ProbeResult = {
    format: "jpeg",
    contentType: "image/jpeg",
    width: 2,
    height: 1,
    encodedWidth: 2,
    encodedHeight: 1,
  };
  let probeImpl: PhotoProbe["inspect"] | null = null;
  const probe: PhotoProbe = {
    inspect: (path, limits, signal) => probeImpl ? probeImpl(path, limits, signal) : Promise.resolve(probeResult),
  };
  const api = createPhotoTransferApi({
    store,
    storage: fake.storage,
    journal: journal(db),
    probe,
    origins: [CONFORMANCE_ORIGIN],
    now: clock,
  });
  return {
    api,
    store,
    storage: fake.storage,
    put: fake.put,
    setProbe(result: ProbeResult) { probeResult = result; probeImpl = null; },
    setProbeImplementation(value: PhotoProbe["inspect"]) { probeImpl = value; },
  };
}

export type ConformanceHarness = ReturnType<typeof createConformanceHarness>;

export async function startAndStage(
  harness: ConformanceHarness,
  owner: string,
  body: StartUploadRequest,
  bytes: Uint8Array,
  key = randomUUID(),
): Promise<{ key: string; uploadId: string }> {
  const response = await harness.api.start(post(body, key), actor(owner));
  if (response.status !== 201) throw new Error(`synthetic upload start failed (${response.status})`);
  const envelope = await response.json() as { value: { upload: { id: string }; ticket: { url: string } } };
  harness.put(envelope.value.ticket.url, bytes);
  return { key, uploadId: envelope.value.upload.id };
}

export async function waitForUploadState(db: Database, owner: string, uploadId: string, state: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const row = (await db.query<{ state: string }>("SELECT state FROM photo_uploads WHERE owner = $1 AND id = $2", [owner, uploadId])).rows[0];
    if (row?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`synthetic upload did not reach ${state}`);
}
