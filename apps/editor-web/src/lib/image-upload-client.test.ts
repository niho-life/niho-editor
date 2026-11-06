import { describe, expect, it, vi } from "vitest";
import { IMAGE_MAX_BYTES } from "@/image/image-limits";
import {
  ImageUploadError,
  completeImageUpload,
  createPageImages,
  imageAssetPath,
  listPageImages,
  putImage,
  removePageImage,
  saveImageMeta,
  startImageUpload,
  type ImageUploadTicket,
} from "./image-upload-client";

// 合成の値だけ（ticket の url はダミー）
const PAGE = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const ASSET = "9a1f3b1c-0d11-4c39-9a52-6f6c6f1d0d7c";
const KEY = "0b6c9a4e-3f0a-4c5e-9d1e-2a7b8c9d0e1f";
const SHA = "e".repeat(64);
const TICKET: ImageUploadTicket = {
  url: "https://storage.example.test/upload?session=synthetic",
  method: "PUT",
  headers: { "Content-Type": "image/png" },
  expiresAt: "2030-01-08T00:00:00.000Z",
  maxBytes: 1,
};
const IMAGE = { assetId: ASSET, pageId: PAGE, status: "ready", bytes: 1, contentType: "image/png", alt: null, credit: null, consent: false, share: false };

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

const pngFile = (bytes = 1, type = "image/png") => new File([new Uint8Array(bytes)], "合成.png", { type });

describe("image upload client", () => {
  it("builds the relay path from the asset id", () => {
    expect(imageAssetPath(ASSET)).toBe(`/api/assets/${ASSET}`);
    expect(imageAssetPath("../etc/passwd")).toBe("/api/assets/..%2Fetc%2Fpasswd");
  });

  it("starts an upload with the JSON body and the Idempotency-Key, and returns the ticket", async () => {
    const fetchMock = respond(201, { assetId: ASSET, upload: TICKET });
    const started = await startImageUpload(PAGE, { contentType: "image/png", sizeBytes: 1, sha256: SHA }, { idempotencyKey: KEY, fetch: fetchMock as unknown as typeof fetch });
    expect(started).toEqual({ status: 201, assetId: ASSET, upload: TICKET });
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/pages/${PAGE}/images/start`);
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json", "idempotency-key": KEY } });
    expect(JSON.parse(init.body as string)).toEqual({ contentType: "image/png", sizeBytes: 1, sha256: SHA });
    // 済んでいる再送（upload が null）
    const replay = respond(200, { assetId: ASSET, upload: null });
    expect(await startImageUpload(PAGE, { contentType: "image/png", sizeBytes: 1, sha256: SHA }, { fetch: replay as unknown as typeof fetch })).toEqual({
      status: 200,
      assetId: ASSET,
      upload: null,
    });
    await expect(startImageUpload(PAGE, { contentType: "image/png", sizeBytes: 1, sha256: SHA }, { idempotencyKey: "not-a-uuid" })).rejects.toBeInstanceOf(TypeError);
  });

  it("PUTs to the ticket without credentials, and treats 412 as already there", async () => {
    const ok = vi.fn(async () => new Response(null, { status: 200 }));
    await putImage(TICKET, pngFile(), ok as unknown as typeof fetch);
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(TICKET.url);
    expect(init).toMatchObject({ method: "PUT", credentials: "omit", cache: "no-store", headers: { "Content-Type": "image/png" } });
    await putImage(TICKET, pngFile(), vi.fn(async () => new Response(null, { status: 412 })) as unknown as typeof fetch);
    await expect(putImage(TICKET, pngFile(), vi.fn(async () => new Response("the storage said why", { status: 403 })) as unknown as typeof fetch)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("completes the upload and saves the fields, turning refusals into ImageUploadError", async () => {
    const complete = respond(200, { image: IMAGE });
    expect(await completeImageUpload(PAGE, ASSET, complete as unknown as typeof fetch)).toEqual(IMAGE);
    expect((complete.mock.calls[0] as unknown as [string])[0]).toBe(`/api/pages/${PAGE}/images/${ASSET}/complete`);

    const meta = respond(200, { image: { ...IMAGE, alt: "合成の写真", consent: true } });
    expect(await saveImageMeta(ASSET, { alt: "合成の写真", consent: true }, meta as unknown as typeof fetch)).toMatchObject({ alt: "合成の写真", consent: true });
    const [path, init] = meta.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/assets/${ASSET}`);
    expect(init.method).toBe("PATCH");
    // 指定した欄だけを送る
    expect(JSON.parse(init.body as string)).toEqual({ alt: "合成の写真", consent: true });

    // 共有画像の許諾は別の欄（それだけを送る）。無い応答は false と読む
    const share = respond(200, { image: { ...IMAGE, consent: true, share: true } });
    expect(await saveImageMeta(ASSET, { share: true }, share as unknown as typeof fetch)).toMatchObject({ consent: true, share: true });
    expect(JSON.parse((share.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ share: true });
    const { share: _share, ...older } = IMAGE;
    expect(await completeImageUpload(PAGE, ASSET, respond(200, { image: older }) as unknown as typeof fetch)).toMatchObject({ share: false });

    for (const [status, body] of [
      [409, { error: "incomplete", reason: "size_mismatch" }],
      [404, { error: "not_found" }],
      [503, { error: "storage_unavailable" }],
    ] as const) {
      const failed = await completeImageUpload(PAGE, ASSET, respond(status, body) as unknown as typeof fetch).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(ImageUploadError);
      expect(failed).toMatchObject({ status, error: body.error });
    }
    await expect(completeImageUpload(PAGE, ASSET, respond(200, { image: { assetId: ASSET } }) as unknown as typeof fetch)).rejects.toMatchObject({ status: 500 });
  });

  it("refuses an unsupported type or an oversized file before sending anything", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    const images = createPageImages({ fetch: fetchMock as unknown as typeof fetch });
    expect(await images.upload(pngFile(1, "image/svg+xml"), PAGE)).toEqual({ ok: false, problem: "content_type" });
    expect(await images.upload(new File([], "空.png", { type: "image/png" }), PAGE)).toEqual({ ok: false, problem: "too_large" });
    // 大きすぎるファイル（中身は作らず size だけを見せる）
    const huge = pngFile(1);
    Object.defineProperty(huge, "size", { value: IMAGE_MAX_BYTES + 1 });
    expect(await images.upload(huge, PAGE)).toEqual({ ok: false, problem: "too_large" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("goes start → PUT → complete for one file and reports the asset with its fields", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/images/start")) return new Response(JSON.stringify({ assetId: ASSET, upload: TICKET }), { status: 201 });
      if (url === TICKET.url) return new Response(null, { status: 200 });
      return new Response(JSON.stringify({ image: { ...IMAGE, alt: "合成の写真" } }), { status: 200 });
    });
    const images = createPageImages({ fetch: fetchMock as unknown as typeof fetch });
    expect(await images.upload(pngFile(), PAGE)).toEqual({ ok: true, assetId: ASSET, meta: { alt: "合成の写真", credit: null, consent: false } });
    expect(calls).toEqual([`/api/pages/${PAGE}/images/start`, TICKET.url, `/api/pages/${PAGE}/images/${ASSET}/complete`]);
    // 送った sha256 は計算した申告値（64 桁の 16 進）
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps the server's refusal to the reason the editor shows, and never throws out of the port", async () => {
    for (const [body, problem] of [
      [{ error: "bad_request", reason: "too_many" }, "too_many"],
      [{ error: "bad_request", reason: "content_type" }, "content_type"],
      [{ error: "bad_request", reason: "too_large" }, "too_large"],
      [{ error: "page_full" }, "page_full"],
      [{ error: "not_found" }, "failed"],
      [{ error: "storage_failed" }, "failed"],
    ] as const) {
      const images = createPageImages({ fetch: respond(400, body) as unknown as typeof fetch });
      expect(await images.upload(pngFile(), PAGE), problem).toEqual({ ok: false, problem });
    }
    const broken = createPageImages({
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(await broken.upload(pngFile(), PAGE)).toEqual({ ok: false, problem: "failed" });
    expect(await broken.saveMeta(ASSET, { consent: true })).toBe(false);
  });

  it("cancels the reservation when PUT fails after start", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push([url, init?.method]);
      if (url.endsWith("/images/start")) return new Response(JSON.stringify({ assetId: ASSET, upload: TICKET }), { status: 201 });
      if (url === TICKET.url) return new Response(null, { status: 502 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error("unexpected request");
    });
    const images = createPageImages({ fetch: fetchMock as unknown as typeof fetch });
    expect(await images.upload(pngFile(), PAGE)).toEqual({ ok: false, problem: "failed" });
    expect(calls.map(([url]) => url)).toEqual([
      `/api/pages/${PAGE}/images/start`,
      TICKET.url,
      `/api/pages/${PAGE}/images/${ASSET}`,
    ]);
  });

  it("releases the reservation when the user aborts the PUT", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/images/start")) return new Response(JSON.stringify({ assetId: ASSET, upload: TICKET }), { status: 201 });
      if (url === TICKET.url) {
        expect(init?.signal).toBe(controller.signal);
        controller.abort();
        throw new DOMException("cancelled", "AbortError");
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error("unexpected request");
    });
    const images = createPageImages({ fetch: fetchMock as unknown as typeof fetch });
    expect(await images.upload(pngFile(), PAGE, controller.signal)).toEqual({ ok: false, problem: "failed" });
    expect(calls).toEqual([`/api/pages/${PAGE}/images/start`, TICKET.url, `/api/pages/${PAGE}/images/${ASSET}`]);
  });
  it("lists the page's photos (only well-formed ids) and removes one with DELETE", async () => {
    const list = respond(200, {
      images: [
        { assetId: ASSET, bytes: 2048, contentType: "image/png", alt: "合成", credit: null, consent: true, createdAt: "2026-11-05T00:00:00.000Z" },
        { assetId: "../x", bytes: 1 },
      ],
    });
    expect(await listPageImages(PAGE, list)).toEqual([
      { assetId: ASSET, bytes: 2048, contentType: "image/png", createdAt: "2026-11-05T00:00:00.000Z", meta: { alt: "合成", credit: null, consent: true } },
    ]);
    expect(list).toHaveBeenCalledWith(`/api/pages/${PAGE}/images`, { credentials: "same-origin", cache: "no-store" });
    const removed = vi.fn(async () => new Response(null, { status: 204 }));
    await removePageImage(PAGE, ASSET, removed);
    expect(removed).toHaveBeenCalledWith(`/api/pages/${PAGE}/images/${ASSET}`, { method: "DELETE", credentials: "same-origin", cache: "no-store" });
    await expect(removePageImage(PAGE, ASSET, respond(404, { error: "not_found" }))).rejects.toBeInstanceOf(ImageUploadError);
  });

  it("gives the panel list and remove through the port, answering null and false instead of throwing", async () => {
    const images = createPageImages({ fetch: respond(500, { error: "internal" }) });
    expect(await images.list!(PAGE)).toBeNull();
    expect(await images.remove!(PAGE, ASSET)).toBe(false);
    const ok = createPageImages({ fetch: vi.fn(async () => new Response(null, { status: 204 })) });
    expect(await ok.remove!(PAGE, ASSET)).toBe(true);
  });
});
