import { describe, expect, it } from "vitest";
import { FAKE_STORAGE_MAX_BYTES, FAKE_STORAGE_PATH, createFakeStorage } from "../storage/fake";
import type { StorageEnv } from "../storage/config";
import { fakeStorageEnabled, fakeStoragePutRoute } from "./fake-storage-api";

const PATH = "audio/6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

function put(token: string, body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(`http://editor.test${FAKE_STORAGE_PATH}${token}`, { method: "PUT", headers: { "content-type": "audio/mp4", ...headers }, body });
}

function status(token: string, total = 3): Request {
  return put(token, null, { "content-range": `bytes */${total}` });
}

async function ticketToken(storage: ReturnType<typeof createFakeStorage>): Promise<string> {
  const ticket = await storage.startUpload({ objectPath: PATH, contentType: "audio/mp4", sizeBytes: 3, origin: null });
  return ticket.url.slice(FAKE_STORAGE_PATH.length);
}

describe("dev fake storage route", () => {
  it("works only when storage is fake and NODE_ENV is not production", () => {
    for (const env of [{}, { NODE_ENV: "development" }, { NODE_ENV: "test" }, { NODE_ENV: "development", EDITOR_STORAGE: "fake" }] as StorageEnv[]) {
      expect(fakeStorageEnabled(env), JSON.stringify(env)).toBe(true);
    }
    for (const env of [
      { NODE_ENV: "production" },
      { NODE_ENV: "production", EDITOR_STORAGE: "fake" },
      { NODE_ENV: "production", EDITOR_STORAGE: "off" },
      { NODE_ENV: "development", EDITOR_STORAGE: "off" },
      { NODE_ENV: "development", EDITOR_STORAGE: "gcs", EDITOR_ASSETS_BUCKET: "synthetic-test-bucket" },
      { NODE_ENV: "development", EDITOR_STORAGE: "nope" },
    ] as StorageEnv[]) {
      expect(fakeStorageEnabled(env), JSON.stringify(env)).toBe(false);
    }
  });

  it("stores the bytes of a valid ticket in development, once", async () => {
    const storage = createFakeStorage();
    const token = await ticketToken(storage);
    const deps = { env: { NODE_ENV: "development" }, storage: () => storage };
    const response = await fakeStoragePutRoute(put(token, new Uint8Array([1, 2, 3])), token, deps);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await storage.stat(PATH)).toEqual({ sizeBytes: 3, contentType: "audio/mp4" });
    expect((await fakeStoragePutRoute(put(token, new Uint8Array([1])), token, deps)).status, "a used ticket").toBe(404);
    const again = await ticketToken(storage);
    const exists = await fakeStoragePutRoute(put(again, new Uint8Array([1])), again, deps);
    expect(exists.status, "never overwrites").toBe(412);
    expect((await fakeStoragePutRoute(put("A".repeat(43), new Uint8Array([1])), "A".repeat(43), deps)).status).toBe(404);
    expect((await fakeStoragePutRoute(put("..%2F", new Uint8Array([1])), "../", deps)).status).toBe(404);
  });

  it("matches GCS status queries, partial ranges and an already saved chunk replay", async () => {
    const storage = createFakeStorage();
    const token = await ticketToken(storage);
    const deps = { env: { NODE_ENV: "development" }, storage: () => storage };
    const first = await fakeStoragePutRoute(put(token, new Uint8Array([1, 2]), { "content-range": "bytes 0-1/3" }), token, deps);
    expect(first.status).toBe(308);
    expect(first.headers.get("range")).toBe("bytes=0-1");
    const queried = await fakeStoragePutRoute(status(token), token, deps);
    expect(queried.status).toBe(308);
    expect(queried.headers.get("range")).toBe("bytes=0-1");
    const replay = await fakeStoragePutRoute(put(token, new Uint8Array([1, 2]), { "content-range": "bytes 0-1/3" }), token, deps);
    expect(replay.status).toBe(308);
    expect(replay.headers.get("range")).toBe("bytes=0-1");
    const final = await fakeStoragePutRoute(put(token, new Uint8Array([3]), { "content-range": "bytes 2-2/3" }), token, deps);
    expect(final.status).toBe(200);
    expect((await fakeStoragePutRoute(status(token), token, deps)).status).toBe(200);
    expect(await storage.stat(PATH)).toEqual({ sizeBytes: 3, contentType: "audio/mp4" });
  });

  it("answers 404 in production and whenever storage is not fake, without storing anything", async () => {
    for (const env of [
      { NODE_ENV: "production" },
      { NODE_ENV: "production", EDITOR_STORAGE: "fake" },
      { NODE_ENV: "development", EDITOR_STORAGE: "off" },
      { NODE_ENV: "development", EDITOR_STORAGE: "gcs", EDITOR_ASSETS_BUCKET: "synthetic-test-bucket" },
    ] as StorageEnv[]) {
      const storage = createFakeStorage();
      const token = await ticketToken(storage);
      const response = await fakeStoragePutRoute(put(token, new Uint8Array([1, 2, 3])), token, { env, storage: () => storage });
      expect(response.status, JSON.stringify(env)).toBe(404);
      expect(await response.text()).toBe('{"error":"not_found"}');
      expect(await storage.stat(PATH)).toBeNull();
    }
  });

  it("refuses a body over 64 MiB with 413", async () => {
    const storage = createFakeStorage();
    const token = await ticketToken(storage);
    const deps = { env: { NODE_ENV: "development" }, storage: () => storage };
    const declared = await fakeStoragePutRoute(put(token, new Uint8Array(1), { "content-length": String(FAKE_STORAGE_MAX_BYTES + 1) }), token, deps);
    expect(declared.status).toBe(413);
    const streamed = await fakeStoragePutRoute(put(token, new Uint8Array(FAKE_STORAGE_MAX_BYTES + 1)), token, deps);
    expect(streamed.status).toBe(413);
    expect(await storage.stat(PATH)).toBeNull();
  });
});
