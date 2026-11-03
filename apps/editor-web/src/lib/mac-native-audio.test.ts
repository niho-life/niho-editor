import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellAudioRecovery, ShellPreparedAudioFile } from "niho-desktop-bridge/shell-contract";
import type { ShellBridge } from "niho-desktop-bridge/shell-bridge";
import type { AudioUploadTicket } from "./audio-upload-client";
import { putPrepared, stableUploadKey, validateMacNativeAudioRecovery } from "./mac-native-audio";

const SCOPE = "a".repeat(64);

function recovery(files: ShellAudioRecovery["files"]): ShellAudioRecovery {
  return { stagingId: "0123456789abcdef", ownerScope: SCOPE, createdAtMs: 1, state: "ready", source: { kind: "staged", stagingId: "0123456789abcdef" }, files };
}

function file(bytes: number, durationSec: number, offsetSec = 0, index = 0) {
  return { index, name: `audio-${index + 1}.wav`, bytes, contentType: "audio/wav" as const, sha256: String(index + 1).repeat(64), durationSec, offsetSec };
}

describe("Mac native audio boundaries", () => {
  it("accepts exactly 2 GiB without 32-bit truncation and rejects +1/0", () => {
    expect(() => validateMacNativeAudioRecovery(recovery([file(2 * 1024 ** 3, 1)]), SCOPE)).not.toThrow();
    expect(() => validateMacNativeAudioRecovery(recovery([file(2 * 1024 ** 3 + 1, 1)]), SCOPE)).toThrow();
    expect(() => validateMacNativeAudioRecovery(recovery([file(0, 1)]), SCOPE)).toThrow();
  });

  it("accepts exactly 6 hours and rejects +1 second", () => {
    expect(() => validateMacNativeAudioRecovery(recovery([file(64, 6 * 60 * 60)]), SCOPE)).not.toThrow();
    expect(() => validateMacNativeAudioRecovery(recovery([file(64, 6 * 60 * 60 + 1)]), SCOPE)).toThrow();
  });

  it("requires exact offsets and does not merge speakers/files implicitly", () => {
    expect(() => validateMacNativeAudioRecovery(recovery([file(64, 10), file(64, 20, 10, 1)]), SCOPE)).not.toThrow();
    expect(() => validateMacNativeAudioRecovery(recovery([file(64, 10), file(64, 20, 9, 1)]), SCOPE)).toThrow();
  });

  it("rejects another owner scope and non-ready recovery", () => {
    expect(() => validateMacNativeAudioRecovery(recovery([file(64, 1)]), "b".repeat(64))).toThrow();
    expect(() => validateMacNativeAudioRecovery({ ...recovery([file(64, 1)]), state: "failed" }, SCOPE)).toThrow();
  });

  it("rejects a claimed type that is not the canonical WAV", () => {
    expect(() => validateMacNativeAudioRecovery(recovery([{ ...file(64, 1), contentType: "audio/mpeg" as "audio/wav" }]), SCOPE)).toThrow();
  });
});

const TICKET: AudioUploadTicket = { url: "https://storage.example.test/session", method: "PUT", headers: { "Content-Type": "audio/wav" }, expiresAt: new Date(0).toISOString(), maxBytes: 10 };

function response(status: number, range?: string): Response {
  return new Response(null, { status, headers: range ? { Range: range } : undefined });
}

function uploadFixture(bytes = 10) {
  const reads: number[] = [];
  const shell = {
    audioPreparedChunk: async (_stagingId: string, _ownerScope: string, _index: number, offset: number) => {
      reads.push(offset);
      return new Uint8Array(Math.min(4 * 1024 * 1024, bytes - offset));
    },
  } as unknown as ShellBridge;
  const item = file(bytes, 1) as ShellPreparedAudioFile;
  return { shell, reads, item, recovery: recovery([item]) };
}

function scriptedFetch(values: Array<Response | Error | ((range: string | null) => Response)>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const next = values.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(new Headers(init?.headers).get("content-range")) : next;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe("Mac native GCS resumable upload", () => {
  it("derives the same upload id for a retried staging part", async () => {
    const first = await stableUploadKey("0123456789abcdef", 0);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await stableUploadKey("0123456789abcdef", 0)).toBe(first);
    expect(await stableUploadKey("0123456789abcdef", 1)).not.toBe(first);
  });

  it("queries status first and starts from the server Range", async () => {
    const f = uploadFixture();
    const fetchMock = scriptedFetch([
      (range) => { expect(range).toBe("bytes */10"); return response(308, "bytes=0-3"); },
      (range) => { expect(range).toBe("bytes 4-9/10"); return response(200); },
    ]);
    await putPrepared(f.shell, f.recovery, f.item, TICKET, new AbortController().signal);
    expect(f.reads).toEqual([4]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a partial 308 Range instead of assuming the whole chunk was saved", async () => {
    const f = uploadFixture();
    scriptedFetch([
      response(308),
      (range) => { expect(range).toBe("bytes 0-9/10"); return response(308, "bytes=0-3"); },
      (range) => { expect(range).toBe("bytes 4-9/10"); return response(200); },
    ]);
    await putPrepared(f.shell, f.recovery, f.item, TICKET, new AbortController().signal);
    expect(f.reads).toEqual([0, 4]);
  });

  it("queries the same session after a lost response or 5xx and resumes from confirmed bytes", async () => {
    const lost = uploadFixture();
    scriptedFetch([response(308), new TypeError("synthetic response loss"), response(200)]);
    await putPrepared(lost.shell, lost.recovery, lost.item, TICKET, new AbortController().signal);
    expect(lost.reads).toEqual([0]);

    const retry = uploadFixture();
    scriptedFetch([response(308), response(503), response(308, "bytes=0-3"), response(200)]);
    await putPrepared(retry.shell, retry.recovery, retry.item, TICKET, new AbortController().signal);
    expect(retry.reads).toEqual([0, 4]);
  });

  it("safely resends the same chunk but bounds no-progress responses", async () => {
    const resent = uploadFixture();
    scriptedFetch([response(308), response(308), response(200)]);
    await putPrepared(resent.shell, resent.recovery, resent.item, TICKET, new AbortController().signal);
    expect(resent.reads).toEqual([0, 0]);

    const stalled = uploadFixture();
    scriptedFetch([response(308), response(308), response(308), response(308), response(308)]);
    await expect(putPrepared(stalled.shell, stalled.recovery, stalled.item, TICKET, new AbortController().signal)).rejects.toThrow("no progress");
    expect(stalled.reads).toEqual([0, 0, 0, 0]);
  });

  it("rejects malformed, backward and out-of-range status without treating 412 as completion", async () => {
    for (const range of ["bytes=2-3", "bytes=0-10", "not-a-range"]) {
      const f = uploadFixture();
      scriptedFetch([response(308, range)]);
      await expect(putPrepared(f.shell, f.recovery, f.item, TICKET, new AbortController().signal)).rejects.toThrow("range");
      expect(f.reads).toEqual([]);
      vi.unstubAllGlobals();
    }
    const backward = uploadFixture();
    scriptedFetch([response(308, "bytes=0-3"), response(308, "bytes=0-2")]);
    await expect(putPrepared(backward.shell, backward.recovery, backward.item, TICKET, new AbortController().signal)).rejects.toThrow("outside request");

    const exists = uploadFixture();
    scriptedFetch([response(412)]);
    await expect(putPrepared(exists.shell, exists.recovery, exists.item, TICKET, new AbortController().signal)).rejects.toMatchObject({ name: "UploadNeedsCompletionCheck" });
  });

  it("does not read the next chunk after abort", async () => {
    const f = uploadFixture();
    const controller = new AbortController();
    scriptedFetch([
      response(308),
      () => { controller.abort(); return response(308, "bytes=0-3"); },
    ]);
    await expect(putPrepared(f.shell, f.recovery, f.item, TICKET, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.reads).toEqual([0]);
  });

  it("does not read the next chunk after the owner session changes", async () => {
    const f = uploadFixture();
    const assertActive = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("native audio owner changed"));
    scriptedFetch([response(308), response(308, "bytes=0-3")]);

    await expect(
      putPrepared(f.shell, f.recovery, f.item, TICKET, new AbortController().signal, undefined, assertActive),
    ).rejects.toThrow("owner changed");
    expect(f.reads).toEqual([0]);
  });
});
