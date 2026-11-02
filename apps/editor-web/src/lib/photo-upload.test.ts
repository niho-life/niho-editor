import { afterEach, describe, expect, it, vi } from "vitest";
import { completedUpload, reservedUpload, storedPhoto } from "@niho/photo-library-contract/fixtures";

const request = vi.hoisted(() => vi.fn());
const clientKeys = vi.hoisted(() => [] as Array<(operation: string) => string>);
vi.mock("@niho/photo-cloud-library", () => ({ createPhotoApiClient: (options: { idempotencyKey: (operation: string) => string }) => {
  clientKeys.push(options.idempotencyKey);
  return { request, dispose: () => {} };
} }));

import { uploadPhotoFile } from "./photo-upload";

const scope = { actorId: "user-a", libraryId: "library-a", sessionEpoch: "session-a" };
const file = () => new File(["hello"], "synthetic.jpg", { type: "image/jpeg" });
const ticket = { url: "https://upload.example.test/synthetic", method: "PUT" as const, headers: {}, expiresAt: "2099-01-01T00:00:00Z", resumeOffsetBytes: 0 };
const options = (signal = new AbortController().signal) => ({
  file: file(), scope, currentScope: () => scope, authenticatedFetch: vi.fn(), signal, onProgress: vi.fn(),
});

afterEach(() => { request.mockReset(); clientKeys.length = 0; vi.unstubAllGlobals(); });

describe("photo upload confirmation", () => {
  it("rejects an invalid resume offset without claiming storage", async () => {
    request.mockResolvedValueOnce({ value: { kind: "upload", upload: reservedUpload, ticket: { ...ticket, resumeOffsetBytes: 6 } } });
    await expect(uploadPhotoFile(options())).rejects.toMatchObject({ reason: "resume" });
    expect(request.mock.calls.map((call) => call[0])).toEqual(["uploads.start"]);
  });

  it("reuses the same opaque start key after a lost reply", async () => {
    request.mockRejectedValueOnce(Object.assign(new Error("lost reply"), { status: 503 }))
      .mockResolvedValueOnce({ value: { kind: "existing", photo: storedPhoto } });
    await expect(uploadPhotoFile(options())).rejects.toMatchObject({ status: 503 });
    expect(await uploadPhotoFile(options())).toEqual({ kind: "existing", photo: storedPhoto });
    expect(clientKeys).toHaveLength(2);
    const first = clientKeys[0]?.("uploads.start");
    expect(first).toBe(clientKeys[1]?.("uploads.start"));
    expect(first).toMatch(/^photo_[a-f0-9]{64}$/);
    expect(first).not.toContain("synthetic");
  });

  it("uses a new deterministic generation only after an explicitly confirmed cancellation", async () => {
    request.mockResolvedValue({ value: { kind: "existing", photo: storedPhoto } });
    await uploadPhotoFile(options());
    await uploadPhotoFile({ ...options(), cancelledGeneration: 1 });
    await uploadPhotoFile({ ...options(), cancelledGeneration: 1 });
    expect(clientKeys[0]?.("uploads.start")).not.toBe(clientKeys[1]?.("uploads.start"));
    expect(clientKeys[1]?.("uploads.start")).toBe(clientKeys[2]?.("uploads.start"));
  });

  it("sends only the remaining bytes with the full-file Content-Range", async () => {
    class FakeXhr {
      static instance: FakeXhr | null = null;
      upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
      withCredentials = true;
      status = 200;
      onload: (() => void) | null = null;
      headers: Record<string, string> = {};
      body: Blob | null = null;
      constructor() { FakeXhr.instance = this; }
      open() {}
      setRequestHeader(name: string, value: string) { this.headers[name] = value; }
      send(body: Blob) { this.body = body; this.upload.onprogress?.({ lengthComputable: true, loaded: 3 } as ProgressEvent); this.onload?.(); }
      abort() {}
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    request.mockResolvedValueOnce({ value: { kind: "upload", upload: reservedUpload, ticket: { ...ticket, resumeOffsetBytes: 2 } } })
      .mockResolvedValueOnce({ value: completedUpload });
    const input = options();
    expect(await uploadPhotoFile(input)).toEqual({ kind: "stored", photo: storedPhoto });
    expect(FakeXhr.instance?.headers).toEqual({ "Content-Range": "bytes 2-4/5" });
    expect(FakeXhr.instance?.withCredentials).toBe(false);
    expect(await FakeXhr.instance?.body?.text()).toBe("llo");
    expect(input.onProgress).toHaveBeenCalledWith("uploading", 0.4);
    expect(input.onProgress).toHaveBeenCalledWith("uploading", 1);
    expect(request.mock.calls.map((call) => call[0])).toEqual(["uploads.start", "uploads.complete"]);
    expect(clientKeys[0]?.("uploads.complete")).toMatch(/^photo_[a-f0-9]{64}$/);
    expect(clientKeys[0]?.("uploads.complete")).not.toBe(clientKeys[0]?.("uploads.cancel"));
  });

  it("skips PUT at the full offset but still requires complete confirmation", async () => {
    const xhr = vi.fn(); vi.stubGlobal("XMLHttpRequest", xhr);
    request.mockResolvedValueOnce({ value: { kind: "upload", upload: reservedUpload, ticket: { ...ticket, resumeOffsetBytes: 5 } } })
      .mockResolvedValueOnce({ value: { ...reservedUpload, state: "rejected", code: "content_rejected" } });
    const input = options();
    await expect(uploadPhotoFile(input)).rejects.toMatchObject({ reason: "failed" });
    expect(xhr).not.toHaveBeenCalled();
    expect(input.onProgress).toHaveBeenCalledWith("uploading", 1);
    expect(request.mock.calls.map((call) => call[0])).toEqual(["uploads.start", "uploads.complete"]);
  });

  it("replays start and complete with stable operation keys after an ambiguous complete reply", async () => {
    const xhr = vi.fn(); vi.stubGlobal("XMLHttpRequest", xhr);
    const fullTicket = { ...ticket, resumeOffsetBytes: 5 };
    request.mockResolvedValueOnce({ value: { kind: "upload", upload: reservedUpload, ticket: fullTicket } })
      .mockRejectedValueOnce(Object.assign(new Error("lost complete reply"), { status: 503 }))
      .mockResolvedValueOnce({ value: { kind: "upload", upload: reservedUpload, ticket: fullTicket } })
      .mockResolvedValueOnce({ value: completedUpload });
    await expect(uploadPhotoFile(options())).rejects.toMatchObject({ status: 503 });
    expect(await uploadPhotoFile(options())).toEqual({ kind: "stored", photo: storedPhoto });
    expect(xhr).not.toHaveBeenCalled();
    expect(clientKeys[0]?.("uploads.start")).toBe(clientKeys[1]?.("uploads.start"));
    expect(clientKeys[0]?.("uploads.complete")).toBe(clientKeys[1]?.("uploads.complete"));
    expect(clientKeys[0]?.("uploads.cancel")).toBe(clientKeys[1]?.("uploads.cancel"));
    expect(clientKeys[0]?.("uploads.start")).not.toBe(clientKeys[0]?.("uploads.complete"));
    expect(request.mock.calls.map((call) => call[0])).toEqual(["uploads.start", "uploads.complete", "uploads.start", "uploads.complete"]);
  });

  it("keeps 503 as failure and does not claim a saved original", async () => {
    request.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { code: "temporarily_unavailable", status: 503 }));
    await expect(uploadPhotoFile(options())).rejects.toMatchObject({ status: 503 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("recognizes only server confirmed existing or stored photos", async () => {
    request.mockResolvedValueOnce({ value: { kind: "existing", photo: storedPhoto } });
    expect(await uploadPhotoFile(options())).toEqual({ kind: "existing", photo: storedPhoto });
    request.mockResolvedValueOnce({ value: { kind: "upload", upload: completedUpload, ticket: null } });
    expect(await uploadPhotoFile(options())).toEqual({ kind: "stored", photo: storedPhoto });
  });

  it("uploads without app credentials and waits for the stored receipt", async () => {
    class FakeXhr {
      static instance: FakeXhr | null = null;
      upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
      withCredentials = true;
      timeout = 0;
      status = 200;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      headers: Record<string, string> = {};
      method = "";
      constructor() { FakeXhr.instance = this; }
      open(method: string) { this.method = method; }
      setRequestHeader(name: string, value: string) { this.headers[name] = value; }
      send() {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5 } as ProgressEvent);
        this.onload?.();
      }
      abort() { this.onabort?.(); }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    request.mockResolvedValueOnce({ value: { kind: "upload", upload: reservedUpload, ticket } })
      .mockResolvedValueOnce({ value: completedUpload });
    const input = options();
    const result = await uploadPhotoFile(input);
    expect(result).toEqual({ kind: "stored", photo: storedPhoto });
    expect(request.mock.calls.map((call) => call[0])).toEqual(["uploads.start", "uploads.complete"]);
    expect(FakeXhr.instance).toMatchObject({ withCredentials: false, method: "PUT", headers: { "Content-Range": "bytes 0-4/5" } });
    expect(input.onProgress).toHaveBeenCalledWith("uploading", 1);
    expect(input.onProgress).toHaveBeenCalledWith("confirming", null);
    expect(request.mock.calls[0]?.[1]).toMatchObject({ contentType: "image/jpeg" });
  });

  it("does not report success when complete has not confirmed storage", async () => {
    class FakeXhr {
      upload = { onprogress: null };
      withCredentials = false;
      status = 200;
      onload: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      send() { this.onload?.(); }
      abort() {}
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    request.mockResolvedValueOnce({ value: { kind: "upload", upload: reservedUpload, ticket } })
      .mockResolvedValueOnce({ value: { ...reservedUpload, state: "rejected", code: "content_rejected" } });
    await expect(uploadPhotoFile(options())).rejects.toMatchObject({ reason: "failed" });
  });

  it("stops a cancelled file without starting another transfer", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(uploadPhotoFile(options(controller.signal))).rejects.toMatchObject({ reason: "cancelled", confirmedServerCancel: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels one reserved file and keeps another confirmed result independent", async () => {
    const controller = new AbortController();
    class FakeXhr {
      upload = { onprogress: null };
      withCredentials = false;
      onload = null;
      onabort: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      send() { controller.abort(); }
      abort() { this.onabort?.(); }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    request.mockResolvedValueOnce({ value: { kind: "upload", upload: reservedUpload, ticket } })
      .mockResolvedValueOnce(reservedUpload)
      .mockResolvedValueOnce({ value: { ...reservedUpload, state: "cancelled" } })
      .mockResolvedValueOnce({ value: { kind: "existing", photo: storedPhoto } });
    await expect(uploadPhotoFile(options(controller.signal))).rejects.toMatchObject({ reason: "cancelled", confirmedServerCancel: true });
    expect(await uploadPhotoFile(options())).toEqual({ kind: "existing", photo: storedPhoto });
    expect(request.mock.calls.map((call) => call[0])).toEqual(["uploads.start", "uploads.get", "uploads.cancel", "uploads.start"]);
  });
});
