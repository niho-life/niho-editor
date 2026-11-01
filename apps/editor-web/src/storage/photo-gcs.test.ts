import { describe, expect, it, vi } from "vitest";
import { createGcsPhotoStorage, type PhotoTicketBroker } from "./photo-gcs";
import { createFakePhotoStorage } from "./photo-fake";
import { PhotoStorageError, type PhotoObject } from "./photo-types";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const ID = "44444444-4444-4444-8444-444444444444";
const FINAL = `photo/final/${ID}/55555555-5555-4555-8555-555555555555`;
const STAGE = `photo/stage/${ID}`;
const session = "https://storage.googleapis.com/upload/storage/v1/b/synthetic-bucket/o?upload_id=synthetic-private-session";
const input = { key: STAGE, sizeBytes: 10, contentType: "image/jpeg", origin: "https://editor.synthetic.invalid", expiresAt: new Date(NOW + 900000).toISOString() };
const source: PhotoObject = { key: STAGE, generation: "101", sizeBytes: 10, contentType: "image/jpeg" };
const signal = () => new AbortController().signal;
const broker: PhotoTicketBroker = {
  issue: vi.fn<PhotoTicketBroker["issue"]>(async (input) => ({ url: "https://upload.synthetic.invalid/short-capability", method: "PUT", headers: { "Content-Type": input.contentType }, expiresAt: input.expiresAt, resumeOffsetBytes: 0 })),
  renew: async () => null,
  progress: async () => 0,
};
function setup(responses: Response[], ticketBroker = broker) {
  const fetcher = vi.fn(async () => { const response = responses.shift(); if (!response) throw new Error("unexpected fetch"); return response; });
  return { fetcher, storage: createGcsPhotoStorage({ bucket: "synthetic-bucket", accessToken: async () => "synthetic-token", now: () => NOW, broker: ticketBroker, fetch: fetcher as typeof fetch }) };
}
const metadata = (generation = "101", size = "10") => new Response(JSON.stringify({ generation, size, contentType: "image/jpeg" }));

describe("photo-specific GCS storage", () => {
  it("creates only a stage object and keeps raw GCS session URIs behind an expiring broker", async () => {
    const f = setup([new Response(null, { headers: { Location: session } })]);
    const ticket = await f.storage.ticket(input, signal());
    expect(ticket.url).not.toBe(session); expect(JSON.stringify(ticket)).not.toContain("synthetic-private-session");
    const call = (f.fetcher.mock.calls[0] as unknown as [string, RequestInit]);
    const url = new URL(call[0]); expect(url.searchParams.get("ifGenerationMatch")).toBe("0"); expect(url.searchParams.get("name")).toBe(STAGE);
    expect(call[1].redirect).toBe("error"); expect(new Headers(call[1].headers).get("X-Upload-Content-Length")).toBe("10");
    expect(broker.issue).toHaveBeenCalledWith(expect.objectContaining({ sessionUrl: session, expiresAt: input.expiresAt }), expect.any(AbortSignal));
  });
  it("rejects fake short expiry on a raw GCS bearer URL", async () => {
    const f = setup([new Response(null, { headers: { Location: session } })], { ...broker, issue: async () => ({ url: session, method: "PUT", headers: {}, expiresAt: input.expiresAt, resumeOffsetBytes: 0 }) });
    await expect(f.storage.ticket(input, signal())).rejects.toMatchObject({ code: "unavailable" });
  });
  it("rejects malicious upstream session hosts and overlong ticket lifetimes", async () => {
    const f = setup([new Response(null, { headers: { Location: "https://foreign.invalid/bearer" } })]);
    await expect(f.storage.ticket(input, signal())).rejects.toMatchObject({ code: "unavailable" });
    await expect(f.storage.ticket({ ...input, expiresAt: new Date(NOW + 900001).toISOString() }, signal())).rejects.toMatchObject({ code: "conflict" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("renews a fresh broker capability at its actual private-session offset", async () => {
    const f = setup([], { ...broker, renew: async (input) => ({ url: "https://upload.synthetic.invalid/new-capability", method: "PUT", headers: {}, expiresAt: input.expiresAt, resumeOffsetBytes: 4 }) });
    expect((await f.storage.ticket(input, signal())).resumeOffsetBytes).toBe(4); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("reports storage-confirmed completed or partial progress", async () => {
    const f = setup([metadata(), new Response(null, { status: 404 })], { ...broker, progress: async () => 4 });
    expect(await f.storage.progress(STAGE, 10, signal())).toBe(10);
    expect(await f.storage.progress(STAGE, 10, signal())).toBe(4);
  });
  it("pins exact-generation stat, read, and create-only copy preconditions", async () => {
    const f = setup([metadata(), new Response(new Uint8Array([2, 3, 4]), { status: 206, headers: { "Content-Length": "3", "Content-Range": "bytes 2-4/10", "x-goog-generation": "101" } }), metadata("102")]);
    expect(await f.storage.stat(STAGE, "101", signal())).toEqual(source);
    const body = await f.storage.read(source, { start: 2, end: 4 }, signal()); expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(new Uint8Array([2, 3, 4]));
    expect(await f.storage.copy(source, FINAL, signal())).toMatchObject({ key: FINAL, generation: "102" });
    const calls = f.fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(new URL(calls[0]![0]).searchParams.get("generation")).toBe("101");
    expect(new URL(calls[1]![0]).searchParams.get("ifGenerationMatch")).toBe("101");
    const copy = new URL(calls[2]![0]);
    expect(copy.pathname).toBe(`/storage/v1/b/synthetic-bucket/o/${encodeURIComponent(STAGE)}/copyTo/b/synthetic-bucket/o/${encodeURIComponent(FINAL)}`);
    expect(copy.searchParams.get("sourceGeneration")).toBe("101"); expect(copy.searchParams.get("ifSourceGenerationMatch")).toBe("101"); expect(copy.searchParams.get("ifGenerationMatch")).toBe("0");
    expect(calls.every(([, init]) => init.redirect === "error")).toBe(true);
  });
  it("rejects provider metadata/Range/generation mismatches and redirects", async () => {
    for (const response of [metadata("999"), new Response(null, { status: 302, headers: { Location: "https://foreign.invalid" } })]) {
      const f = setup([response]); await expect(f.storage.stat(STAGE, "101", signal())).rejects.toMatchObject({ code: "unavailable" });
    }
    for (const response of [new Response(new Uint8Array(10), { headers: { "Content-Length": "10" } }), new Response(new Uint8Array(3), { status: 206, headers: { "Content-Length": "3", "Content-Range": "bytes 3-5/10" } })]) {
      const f = setup([response]); await expect(f.storage.read(source, { start: 2, end: 4 }, signal())).rejects.toMatchObject({ code: "unavailable" });
    }
  });
  it("maps generation precondition failures and transport exceptions without details", async () => {
    const f = setup([new Response(null, { status: 412 })]); await expect(f.storage.copy(source, FINAL, signal())).rejects.toMatchObject({ code: "conflict" });
    const storage = createGcsPhotoStorage({ bucket: "synthetic-private-bucket", broker, accessToken: async () => { throw new Error("private-token-location"); }, fetch: vi.fn(), now: () => NOW });
    try { await storage.stat(STAGE, null, signal()); expect.unreachable(); } catch (error) { expect(error).toBeInstanceOf(PhotoStorageError); expect(String(error)).not.toContain("private-token-location"); expect(String(error)).not.toContain("synthetic-private-bucket"); }
  });
});

describe("development photo storage", () => {
  it("enforces actual ticket expiry, byte limit, create-only final and exact generation", async () => {
    let current = NOW; const fake = createFakePhotoStorage(() => current);
    const ticket = await fake.storage.ticket(input, signal());
    expect(() => fake.put(ticket.url, new Uint8Array(11))).toThrow();
    const stage = fake.put(ticket.url, new Uint8Array(10));
    expect(() => fake.put(ticket.url, new Uint8Array(10))).toThrow();
    const final = await fake.storage.copy(stage, FINAL, signal());
    expect(final.generation).not.toBe(stage.generation);
    await expect(fake.storage.copy(stage, FINAL, signal())).rejects.toMatchObject({ code: "conflict" });
    expect(await fake.storage.stat(FINAL, "wrong", signal())).toBeNull();
    await expect(fake.storage.read({ ...final, generation: "wrong" }, null, signal())).rejects.toMatchObject({ code: "not_found" });
    const second = await fake.storage.ticket({ ...input, key: `photo/stage/66666666-6666-4666-8666-666666666666` }, signal());
    current += 900000; expect(() => fake.put(second.url, new Uint8Array(10))).toThrow();
  });
});
