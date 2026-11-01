import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { PhotoAssetRecord, PhotoUploadRecord } from "@niho/editor-store";
import type { StartUploadRequest, VerifiedPhotoActor } from "../../../../../packages/photo-library-contract/src/v1";
import { IDS, storedPhoto } from "../../../../../packages/photo-library-contract/fixtures/v1";
import { createFakePhotoStorage } from "../../storage/photo-fake";
import { PhotoStorageError } from "../../storage/photo-types";
import { createPhotoTransferApi } from "./api";
import { PhotoTransferError, PRIVATE_PHOTO_HEADERS, canonicalHash, parseRange } from "./http";
import type { PhotoTransferDeps, PhotoTransferStore, ProbeResult } from "./types";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const ORIGIN = "https://editor.synthetic.invalid";
const actor: VerifiedPhotoActor = { userId: IDS.userA, sessionId: "synthetic-session", transport: "browser-session", expiresAt: new Date(NOW + 3600_000).toISOString() };
const jpeg = Buffer.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 217]);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const start: StartUploadRequest = { target: { kind: "original", fileName: "synthetic.jpg", format: "jpeg" }, sizeBytes: jpeg.length, sha256: digest(jpeg), contentType: "image/jpeg" };
const post = (value: unknown = {}, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/photo/v1/uploads`, {
  method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", "idempotency-key": "synthetic_key_0001", ...headers }, body: JSON.stringify(value),
});
const get = (headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/photo/v1/uploads`, { headers });

function arrange() {
  const fake = createFakePhotoStorage(() => NOW);
  let upload: PhotoUploadRecord | null = null;
  let asset: PhotoAssetRecord | null = null;
  let probeResult: ProbeResult = { format: "jpeg", contentType: "image/jpeg", width: 2, height: 1 };
  let probePath = "";
  const store: PhotoTransferStore = {
    reserve: vi.fn<PhotoTransferStore["reserve"]>(async (owner, input) => {
      if (owner !== actor.userId) return null;
      if (upload) return { status: "replayed", upload: { ...upload } };
      upload = { id: IDS.upload, operation: input.operation, targetPhotoId: input.targetPhotoId ?? null, state: "reserved", sizeBytes: input.sizeBytes,
        sha256: input.sha256, contentType: input.contentType, fileName: input.fileName ?? null, format: input.format ?? null, reservedBytes: input.sizeBytes,
        leaseGeneration: 0, verificationJobId: null, verificationLeaseUntil: null, expiresAt: new Date(NOW + 86400_000).toISOString(), resultPhotoId: null,
        resultAssetId: null, rejectionCode: null, createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() };
      return { status: "created", upload: { ...upload } };
    }),
    upload: vi.fn<PhotoTransferStore["upload"]>(async (owner, id) => owner === actor.userId && upload && id === upload.id ? { ...upload } : null),
    uploadByStartKey: vi.fn(async (owner) => owner === actor.userId && upload ? { ...upload } : null),
    claim: vi.fn(async (owner) => {
      if (owner !== actor.userId || !upload) return null;
      upload.state = "verifying"; upload.leaseGeneration++; upload.verificationJobId = IDS.job; upload.verificationLeaseUntil = new Date(NOW + 900_000).toISOString();
      return { ...upload };
    }),
    complete: vi.fn(async (owner, id, verified) => {
      if (owner !== actor.userId || !upload || id !== upload.id) return null;
      if (upload.state !== "verifying" || upload.leaseGeneration !== verified.leaseGeneration) throw new PhotoTransferError("upload_state_conflict");
      asset = { id: upload.operation === "mask" ? IDS.mask : IDS.original, photoId: IDS.photo, kind: upload.operation, sha256: verified.sha256,
        sizeBytes: verified.sizeBytes, contentType: verified.contentType, width: verified.width, height: verified.height, objectKey: verified.objectKey,
        objectGeneration: verified.objectGeneration, deletionState: "retained", createdAt: new Date(NOW).toISOString() };
      upload.state = "stored"; upload.reservedBytes = 0; upload.resultPhotoId = IDS.photo; upload.resultAssetId = asset.id;
      return { replayed: false, photoId: IDS.photo, assetId: asset.id, deduplicated: false };
    }),
    cancel: vi.fn(async (owner) => { if (owner !== actor.userId || !upload) return null; upload.state = "cancelled"; upload.leaseGeneration++; upload.reservedBytes = 0; return { ...upload }; }),
    reject: vi.fn(async (_owner, _id, lease, code) => {
      if (!upload) return null;
      if (upload.leaseGeneration !== lease) throw new PhotoTransferError("upload_state_conflict");
      upload.state = "rejected"; upload.leaseGeneration++; upload.rejectionCode = code; upload.reservedBytes = 0;
      return { ...upload };
    }),
    orphan: vi.fn(async () => null),
    photo: vi.fn(async (owner, id) => owner === actor.userId && id === IDS.photo ? { ...storedPhoto, original: asset ?? storedPhoto.original } : null),
    asset: vi.fn<PhotoTransferStore["asset"]>(async (owner, photo, id) => owner === actor.userId && photo === IDS.photo && asset && asset.id === id ? { ...asset } : null),
    mask: vi.fn(async (owner, photo, surface) => owner === actor.userId && photo === IDS.photo && asset?.kind === "mask" && asset.sha256 === surface ? { ...asset } : null),
  };
  const journal = new Map<string, string>();
  const deps: PhotoTransferDeps = {
    store, storage: fake.storage, now: () => NOW, origins: [ORIGIN],
    journal: { bind: vi.fn(async (input) => {
      const key = JSON.stringify([input.owner, input.operation, input.resourceId, input.key]);
      const old = journal.get(key); if (old && old !== input.requestHash) throw new PhotoTransferError("idempotency_conflict");
      journal.set(key, input.requestHash); return old !== undefined;
    }) },
    probe: { inspect: vi.fn(async (path) => { probePath = path; expect((await readFile(path)).length).toBeGreaterThan(0); return probeResult; }) },
  };
  const api = createPhotoTransferApi(deps);
  return { fake, deps, store, api, get upload() { return upload!; }, get asset() { return asset!; }, get probePath() { return probePath; },
    probe(value: ProbeResult) { probeResult = value; },
    async reserve(body = start, bytes = jpeg) {
      const response = await api.start(post(body), actor); expect(response.status).toBe(201);
      const value = await response.json(); fake.put(value.value.ticket.url, bytes); return value;
    },
  };
}

describe("photo transfer authorization and schema", () => {
  it("requires a verified, unexpired actor before all effects", async () => {
    const f = arrange();
    for (const identity of [null, { ...actor, expiresAt: new Date(NOW).toISOString() }]) {
      const response = await f.api.start(post(start), identity); expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("unauthenticated");
    }
    expect(f.store.reserve).not.toHaveBeenCalled();
  });
  it("enforces browser Origin and a supplied Mac Origin on every mutation", async () => {
    const f = arrange();
    for (const operation of [f.api.start, (r: Request, a: VerifiedPhotoActor | null) => f.api.complete(r, a, IDS.upload), (r: Request, a: VerifiedPhotoActor | null) => f.api.cancel(r, a, IDS.upload), (r: Request, a: VerifiedPhotoActor | null) => f.api.renew(r, a, IDS.upload)]) {
      const missing = post(start); missing.headers.delete("origin");
      expect((await operation(missing, actor)).status).toBe(403);
      expect((await operation(post(start, { origin: "https://foreign.invalid" }), { ...actor, transport: "mac-bearer" })).status).toBe(403);
    }
    const mac = post(start); mac.headers.delete("origin"); expect((await f.api.start(mac, { ...actor, transport: "mac-bearer" })).status).toBe(201);
  });
  it.each([
    { ...start, ownerId: "foreign" }, { ...start, target: { ...start.target, objectKey: "private" } },
    { ...start, sizeBytes: 0 }, { ...start, sizeBytes: Number.MAX_SAFE_INTEGER + 1 }, { ...start, sha256: "A".repeat(64) },
    { ...start, target: { kind: "original", fileName: "../photo.jpg", format: "jpeg" } },
    { ...start, target: { kind: "original", fileName: "写".repeat(86), format: "jpeg" } },
  ])("rejects closed schema / unsafe scalar input %#", async (body) => {
    const f = arrange(); expect((await f.api.start(post(body), actor)).status).toBe(400); expect(f.store.reserve).not.toHaveBeenCalled();
  });
  it("bounds body bytes, JSON depth, query and idempotency keys", async () => {
    const f = arrange();
    expect((await f.api.start(post(start, { "content-length": "65537" }), actor)).status).toBe(413);
    expect((await f.api.start(post({ text: "x".repeat(65536) }), actor)).status).toBe(413);
    expect((await f.api.start(post(start, { "idempotency-key": "short" }), actor)).status).toBe(400);
    expect((await f.api.start(new Request(`${ORIGIN}/?ownerId=x`, { method: "POST", headers: post().headers, body: JSON.stringify(start) }), actor)).status).toBe(400);
    let deep: unknown = {}; for (let i = 0; i < 34; i++) deep = { nested: deep };
    expect((await f.api.start(post(deep), actor)).status).toBe(400);
    expect(f.store.reserve).not.toHaveBeenCalled();
  });
  it("makes malformed and foreign resources indistinguishable before Range or storage", async () => {
    const f = arrange(); await f.reserve();
    for (const id of [IDS.upload, "malformed"]) {
      const response = await f.api.complete(post(), { ...actor, userId: IDS.userB }, id); expect(response.status).toBe(404);
    }
    for (const id of [IDS.photo, "malformed"]) expect((await f.api.content(get({ range: "invalid" }), { ...actor, userId: IDS.userB }, id, IDS.original)).status).toBe(404);
    expect(f.store.claim).not.toHaveBeenCalled();
  });
  it("sets privacy headers and keeps internal failures out of envelopes", async () => {
    const f = arrange(); vi.mocked(f.store.reserve).mockRejectedValue(new Error("private/bucket bearer=synthetic-secret"));
    const response = await f.api.start(post(start), actor);
    expect(response.status).toBe(503); expect(response.headers.get("Retry-After")).toBe("1");
    for (const [key, value] of Object.entries(PRIVATE_PHOTO_HEADERS)) expect(response.headers.get(key)).toBe(value);
    const text = await response.text(); expect(text).not.toContain("private/bucket"); expect(text).not.toContain("synthetic-secret");
    expect(JSON.parse(text).error).toEqual({ code: "temporarily_unavailable", requestId: expect.any(String), retryable: true, retryAfterSeconds: 1 });
  });
});

describe("photo upload lifecycle", () => {
  it("reserves before ticket creation and releases newly reserved quota when issuing fails", async () => {
    const f = arrange(); const ticket = vi.spyOn(f.deps.storage, "ticket").mockImplementation(async () => {
      expect(f.upload.reservedBytes).toBe(jpeg.length); throw new PhotoStorageError("unavailable");
    });
    expect((await f.api.start(post(start), actor)).status).toBe(503);
    expect(ticket).toHaveBeenCalledOnce(); expect(f.upload.state).toBe("cancelled"); expect(f.upload.reservedBytes).toBe(0);
  });
  it("uses canonical hashes and fresh tickets on start/renew; replay reflects current state", async () => {
    const f = arrange(); const first = await f.api.start(post(start), actor); const initial = await first.json();
    const replay = await f.api.start(post({ contentType: start.contentType, sha256: start.sha256, sizeBytes: start.sizeBytes, target: start.target }), actor);
    expect(replay.status).toBe(200); const second = await replay.json(); expect(second.replayed).toBe(true); expect(second.value.ticket.url).not.toBe(initial.value.ticket.url);
    const renew = await f.api.renew(post(), actor, IDS.upload); expect((await renew.json()).ticket.url).not.toBe(second.value.ticket.url);
    const conflict = await f.api.start(post({ ...start, sizeBytes: 11 }), actor); expect(conflict.status).toBe(409);
    f.upload.state = "verifying"; f.upload.verificationJobId = IDS.job;
    const verifying = await f.api.start(post(start), actor); expect((await verifying.json()).value.ticket).toBeNull();
    expect((await f.api.renew(post(), actor, IDS.upload)).status).toBe(409);
    expect(canonicalHash({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalHash({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it("keeps complete/cancel bodies closed and requires their own idempotency key", async () => {
    const f = arrange(); await f.reserve();
    for (const operation of [f.api.complete, f.api.cancel]) {
      expect((await operation(post({ uploadId: IDS.upload }), actor, IDS.upload)).status).toBe(400);
      const missing = post(); missing.headers.delete("idempotency-key");
      expect((await operation(missing, actor, IDS.upload)).status).toBe(400);
    }
    expect(f.store.claim).not.toHaveBeenCalled(); expect(f.store.cancel).not.toHaveBeenCalled();
  });
  it("hashes all bytes, probes a private spool, copies exact generation then commits verified metadata", async () => {
    const f = arrange(); await f.reserve();
    expect((await (await f.api.get(get(), actor, IDS.upload)).json()).uploadedBytes).toBe(jpeg.length);
    const copy = vi.spyOn(f.deps.storage, "copy");
    const response = await f.api.complete(post(), actor, IDS.upload); expect(response.status).toBe(200);
    const body = await response.json(); expect(body.value.state).toBe("stored"); expect(JSON.stringify(body)).not.toContain("objectGeneration");
    expect(JSON.stringify(body)).not.toContain("photo/final");
    expect(copy.mock.calls[0]![0].generation).toBe("1");
    expect(vi.mocked(f.store.complete).mock.calls[0]![2]).toMatchObject({ sizeBytes: jpeg.length, sha256: digest(jpeg), width: 2, height: 1, leaseGeneration: 1, objectGeneration: "2" });
    await expect(access(f.probePath)).rejects.toThrow();
    expect(f.store.orphan).toHaveBeenCalledWith(actor.userId, expect.objectContaining({ objectKey: `photo/stage/${IDS.upload}`, objectGeneration: "1" }));
    const duplicate = await f.api.complete(post(), actor, IDS.upload); expect((await duplicate.json()).replayed).toBe(true); expect(copy).toHaveBeenCalledOnce();
    const replayStart = await f.api.start(post(start), actor); expect(replayStart.status).toBe(200);
    const replayBody = await replayStart.json(); expect(replayBody.replayed).toBe(true); expect(replayBody.value.upload.state).toBe("stored"); expect(replayBody.value.ticket).toBeNull();
  });
  it("returns owner-scoped dedup metadata and preserves start receipt replay flags", async () => {
    const f = arrange();
    vi.mocked(f.store.reserve).mockResolvedValue({ status: "existing", photoId: IDS.photo, assetId: IDS.original });
    const first = await f.api.start(post(start), actor); expect(first.status).toBe(200); expect((await first.json()).replayed).toBe(false);
    const replay = await f.api.start(post(start), actor); expect((await replay.json()).replayed).toBe(true);
    vi.mocked(f.store.photo).mockResolvedValue(null);
    expect((await f.api.start(post(start), actor)).status).toBe(404);
  });
  it("records a known copy generation before rejecting inconsistent copy metadata", async () => {
    const f = arrange(); await f.reserve();
    vi.spyOn(f.deps.storage, "copy").mockImplementation(async (_source, destination) => ({ key: destination, generation: "999", sizeBytes: 1, contentType: "image/jpeg" }));
    expect((await f.api.complete(post(), actor, IDS.upload)).status).toBe(422);
    expect(f.store.complete).not.toHaveBeenCalled();
    expect(f.store.orphan).toHaveBeenCalledWith(actor.userId, expect.objectContaining({ objectGeneration: "999", reason: "copy_db_failure" }));
  });
  it.each(["size", "hash", "magic", "type", "pixels"])("rejects %s mismatch before final copy", async (kind) => {
    const f = arrange(); const body = { ...start };
    let bytes = jpeg;
    if (kind === "hash") body.sha256 = "a".repeat(64);
    if (kind === "magic") { bytes = Buffer.alloc(jpeg.length); body.sha256 = digest(bytes); }
    await f.reserve(body, bytes);
    if (kind === "size") f.upload.sizeBytes++;
    if (kind === "type") f.probe({ format: "png", contentType: "image/png", width: 2, height: 1 });
    if (kind === "pixels") f.probe({ format: "jpeg", contentType: "image/jpeg", width: 100001, height: 1000 });
    const copy = vi.spyOn(f.deps.storage, "copy");
    const response = await f.api.complete(post(), actor, IDS.upload); expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe(kind === "pixels" ? "pixel_limit_exceeded" : "content_rejected");
    expect(copy).not.toHaveBeenCalled(); expect(f.upload.state).toBe("rejected"); expect(f.upload.reservedBytes).toBe(0);
    if (f.probePath) await expect(access(f.probePath)).rejects.toThrow();
  });
  it("returns 202 for an active verifier and fences a stale completion without overwriting", async () => {
    const f = arrange(); await f.reserve();
    f.upload.state = "verifying"; f.upload.verificationJobId = IDS.job; f.upload.verificationLeaseUntil = new Date(NOW + 1000).toISOString();
    expect((await f.api.complete(post(), actor, IDS.upload)).status).toBe(202); expect(f.store.claim).not.toHaveBeenCalled();
    f.upload.verificationLeaseUntil = new Date(NOW - 1).toISOString();
    vi.mocked(f.store.complete).mockImplementation(async () => { f.upload.leaseGeneration++; throw new PhotoTransferError("upload_state_conflict"); });
    expect((await f.api.complete(post(), actor, IDS.upload)).status).toBe(409);
    expect(f.store.orphan).toHaveBeenCalledWith(actor.userId, expect.objectContaining({ reason: "copy_db_failure", objectGeneration: "2" }));
    expect(f.store.orphan).not.toHaveBeenCalledWith(actor.userId, expect.objectContaining({ objectKey: `photo/stage/${IDS.upload}` }));
    expect(f.store.reject).not.toHaveBeenCalled();
  });
  it("does not retire retryable verification stages or leak decoder failures", async () => {
    const f = arrange(); await f.reserve(); vi.mocked(f.deps.probe.inspect).mockRejectedValue(new Error("decoder process private failure"));
    const response = await f.api.complete(post(), actor, IDS.upload); expect(response.status).toBe(503); expect(await response.text()).not.toContain("decoder process");
    expect(f.store.orphan).not.toHaveBeenCalled(); expect(f.store.reject).not.toHaveBeenCalled(); await expect(access(f.probePath)).rejects.toThrow();
  });
  it("maps an accepted decoder's unsupported format rejection and fences the upload", async () => {
    const f = arrange(); await f.reserve(); vi.mocked(f.deps.probe.inspect).mockRejectedValue(new PhotoTransferError("unsupported_format"));
    expect((await f.api.complete(post(), actor, IDS.upload)).status).toBe(415); expect(f.upload.rejectionCode).toBe("unsupported_format");
  });
  it("cancels once, records known stage generations, and never renews terminal uploads", async () => {
    const f = arrange(); await f.reserve(); const response = await f.api.cancel(post(), actor, IDS.upload); expect(response.status).toBe(200);
    expect(f.upload.state).toBe("cancelled"); expect(f.upload.reservedBytes).toBe(0);
    expect(f.store.orphan).toHaveBeenCalledWith(actor.userId, expect.objectContaining({ reason: "cancelled_upload", objectGeneration: "1" }));
    const again = await f.api.cancel(post(), actor, IDS.upload); expect((await again.json()).replayed).toBe(true);
    expect((await f.api.renew(post(), actor, IDS.upload)).status).toBe(409);
    expect((await f.api.start(post(start), actor)).status).toBe(409);
    f.upload.state = "expired"; expect((await f.api.renew(post(), actor, IDS.upload)).status).toBe(410);
  });
});

describe("mask surface and private content reads", () => {
  function png(color = 0, depth = 8, width = 2) {
    const buffer = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer); buffer.writeUInt32BE(13, 8); buffer.write("IHDR", 12); buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(1, 20); buffer[24] = depth; buffer[25] = color;
    // Synthetic probe fixture only; accepted production decoders must validate CRC/IDAT/end-of-file.
    return buffer;
  }
  it.each([[0, 8, 2, 200], [2, 8, 2, 422], [0, 16, 2, 422], [0, 8, 4097, 422]])("enforces PNG gray8 and mask edge limits (%s,%s,%s)", async (color, depth, width, status) => {
    const f = arrange(); const bytes = png(color, depth, width);
    const body: StartUploadRequest = { target: { kind: "mask", photoId: IDS.photo }, sizeBytes: bytes.length, sha256: digest(bytes), contentType: "image/png" };
    f.probe({ format: "png", contentType: "image/png", width, height: 1, bitDepth: depth, channels: color === 0 ? "gray" : "rgb" });
    await f.reserve(body, bytes); const response = await f.api.complete(post(), actor, IDS.upload); expect(response.status).toBe(status);
    if (status === 200) {
      const meta = await f.api.mask(get(), actor, IDS.photo, digest(bytes)); expect(meta.status).toBe(200); const publicAsset = await meta.json(); expect(publicAsset.sha256).toBe(digest(bytes)); expect(publicAsset.objectKey).toBeUndefined();
      expect((await f.api.mask(get(), { ...actor, userId: IDS.userB }, IDS.photo, digest(bytes))).status).toBe(404);
      expect((await f.api.mask(get(), actor, IDS.photo, "bad")).status).toBe(404);
    }
  });
  it("returns a mask dedup's stored upload rather than an unrelated original existing result", async () => {
    const f = arrange(); const bytes = png();
    const body: StartUploadRequest = { target: { kind: "mask", photoId: IDS.photo }, sizeBytes: bytes.length, sha256: digest(bytes), contentType: "image/png" };
    f.probe({ format: "png", contentType: "image/png", width: 2, height: 1, bitDepth: 8, channels: "gray" });
    await f.reserve(body, bytes); await f.api.complete(post(), actor, IDS.upload);
    vi.mocked(f.store.reserve).mockResolvedValue({ status: "existing", photoId: IDS.photo, assetId: IDS.mask });
    const response = await f.api.start(post(body), actor); const visible = await response.json();
    expect(response.status).toBe(200); expect(visible.value.kind).toBe("upload"); expect(visible.value.upload.result.kind).toBe("mask"); expect(visible.value.ticket).toBeNull();
    expect(f.store.uploadByStartKey).toHaveBeenCalledWith(actor.userId, "mask", "synthetic_key_0001");
  });
  it("returns exact-generation 200/206 streams with bounded/suffix ranges", async () => {
    const f = arrange(); await f.reserve(); await f.api.complete(post(), actor, IDS.upload);
    const read = vi.spyOn(f.deps.storage, "read");
    for (const [range, expected, status] of [[undefined, jpeg, 200], ["bytes=1-3", jpeg.subarray(1, 4), 206], ["bytes=-2", jpeg.subarray(-2), 206], ["bytes=8-999", jpeg.subarray(8), 206]] as const) {
      const response = await f.api.content(get(range ? { range } : {}), actor, IDS.photo, IDS.original); expect(response.status).toBe(status);
      expect(response.headers.get("content-length")).toBe(String(expected.length)); expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
      expect(read.mock.calls.at(-1)![0].generation).toBe("2");
      if (range === "bytes=1-3") expect(response.headers.get("content-range")).toBe(`bytes 1-3/${jpeg.length}`);
    }
    const invalid = await f.api.content(get({ range: "bytes=99-" }), actor, IDS.photo, IDS.original);
    expect(invalid.status).toBe(416); expect(invalid.headers.get("Content-Range")).toBe(`bytes */${jpeg.length}`);
    expect((await f.api.content(get({ range: "bytes=0-1,4-5" }), actor, IDS.photo, IDS.original)).status).toBe(416);
  });
  it("does not read/buffer content before downstream demand and propagates cancel/abort", async () => {
    const f = arrange(); await f.reserve(); await f.api.complete(post(), actor, IDS.upload);
    const pull = vi.fn(); const cancel = vi.fn();
    vi.spyOn(f.deps.storage, "read").mockImplementation(async () => new ReadableStream({ pull, cancel }, { highWaterMark: 0 }));
    const response = await f.api.content(get(), actor, IDS.photo, IDS.original); expect(pull).not.toHaveBeenCalled();
    await response.body!.cancel(); expect(cancel).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const aborted = await f.api.content(new Request(`${ORIGIN}/`, { signal: controller.signal }), actor, IDS.photo, IDS.original);
    controller.abort(); await expect(aborted.arrayBuffer()).rejects.toThrow(); expect(cancel).toHaveBeenCalledTimes(2);
  });
  it("bounds stalled content streams by the request deadline", async () => {
    const f = arrange(); await f.reserve(); await f.api.complete(post(), actor, IDS.upload);
    const cancel = vi.fn(); vi.spyOn(f.deps.storage, "read").mockResolvedValue(new ReadableStream({ cancel }, { highWaterMark: 0 }));
    const api = createPhotoTransferApi({ ...f.deps, timeoutMs: 10 });
    const response = await api.content(get(), actor, IDS.photo, IDS.original);
    const bytes = response.arrayBuffer();
    await expect(bytes).rejects.toThrow("photo storage: unavailable"); expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects immutable stream length violations and keeps storage details private", async () => {
    const f = arrange(); await f.reserve(); await f.api.complete(post(), actor, IDS.upload);
    vi.spyOn(f.deps.storage, "read").mockResolvedValue(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); c.close(); } }));
    const response = await f.api.content(get(), actor, IDS.photo, IDS.original); await expect(response.arrayBuffer()).rejects.toThrow("photo storage: unavailable");
  });
  it.each(["bytes=", "bytes=-0", "bytes=1-0", "bytes=9007199254740992-", "items=0-1"])("rejects invalid ranges %s", (range) => {
    expect(() => parseRange(range, 10)).toThrow("range_not_satisfiable");
  });
});
