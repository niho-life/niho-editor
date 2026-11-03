// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellBridge } from "niho-desktop-bridge/shell-bridge";

const native = vi.hoisted(() => ({ shell: null as ShellBridge | null }));
const ownerScopeMock = vi.hoisted(() => vi.fn());
const uploadMock = vi.hoisted(() => vi.fn());
vi.mock("niho-desktop-bridge/tauri-shell-transport", () => ({ detectShell: () => native.shell }));
vi.mock("@/lib/mac-native-audio", async (original) => ({ ...(await original()), macNativeAudioOwnerScope: ownerScopeMock, uploadMacNativeAudio: uploadMock }));

import { MacNativeAudioImport } from "./MacNativeAudioImport";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  native.shell = null;
  ownerScopeMock.mockReset();
  uploadMock.mockReset().mockResolvedValue({ page: { id: "page", title: "合成音声" } });
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("Mac native audio control", () => {
  it("starts one conversion when a manual stop also emits Done", async () => {
    const scope = "a".repeat(64);
    ownerScopeMock.mockResolvedValue(scope);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    let sendEvent: ((event: { type: "Done" }) => void) | undefined;
    const prepare = vi.fn(async () => ({ stagingId: "stage", ownerScope: scope, files: [] }));
    const start = vi.fn(async (_id, _scope, event) => {
      sendEvent = event;
      return { stagingId: "stage" };
    });
    native.shell = {
      capabilities: async () => ({ features: { nativeAudioV2: true } }),
      audioRecovery: async () => [],
      micStatus: async () => "authorized",
      recordingStartV2: start,
      recordingStop: async () => { sendEvent?.({ type: "Done" }); },
      audioPrepareResume: prepare,
    } as unknown as ShellBridge;
    await act(async () => root.render(<MacNativeAudioImport onCreated={() => undefined} />));
    await flush();
    const startButton = [...host.querySelectorAll("button")].find((button) => button.textContent === "Macのマイクで録音")!;
    await act(async () => { startButton.click(); startButton.click(); });
    expect(start).toHaveBeenCalledTimes(1);
    const stopButton = [...host.querySelectorAll("button")].find((button) => button.textContent === "Mac録音を止めて取り込む")!;
    await act(async () => stopButton.click());
    await flush();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain("途中で終了しました");
  });

  it("clears the stopped recording and exposes recovery when native export fails", async () => {
    const scope = "a".repeat(64);
    ownerScopeMock.mockResolvedValue(scope);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const recovery = {
      stagingId: "recovered-stage",
      ownerScope: scope,
      createdAtMs: 1,
      state: "ready",
      source: { kind: "recording", recordingId: "recording" },
      files: [{ index: 0, name: "recovered.wav", bytes: 64, contentType: "audio/wav", sha256: "c".repeat(64), durationSec: 1, offsetSec: 0 }],
    };
    const prepare = vi.fn(async () => recovery);
    const start = vi.fn(async () => ({ stagingId: "recording-stage" }));
    native.shell = {
      capabilities: async () => ({ features: { nativeAudioV2: true } }),
      audioRecovery: async () => [],
      micStatus: async () => "authorized",
      recordingStartV2: start,
      recordingStop: async () => { throw new Error("shell_recording_failed"); },
      audioPrepareResume: prepare,
    } as unknown as ShellBridge;
    await act(async () => root.render(<MacNativeAudioImport onCreated={() => undefined} />));
    await flush();
    const startButton = [...host.querySelectorAll("button")].find((button) => button.textContent === "Macのマイクで録音")!;
    await act(async () => startButton.click());
    const stopButton = [...host.querySelectorAll("button")].find((button) => button.textContent === "Mac録音を止めて取り込む")!;
    await act(async () => stopButton.click());
    await flush();

    expect(prepare).toHaveBeenCalledOnce();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("このMacで録音中です");
    expect(host.querySelector('[role="group"][aria-label="このMacの一時音声"]')).not.toBeNull();
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Macから音声を選ぶ" && !button.disabled)).toBe(true);
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "再開・救出" && !button.disabled)).toBe(true);
  });

  it("preserves the Web path and shows an update notice for an older Mac binary", async () => {
    await act(async () => root.render(<MacNativeAudioImport onCreated={() => undefined} />));
    await flush();
    expect(host.textContent).toBe("");

    await act(async () => root.unmount());
    root = createRoot(host);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    native.shell = {
      capabilities: async () => ({
        version: "old",
        dev: false,
        features: { recording: true, localTranscription: true, cliAi: true, nativeAudioV2: false },
      }),
    } as unknown as ShellBridge;
    await act(async () => root.render(<MacNativeAudioImport onCreated={() => undefined} />));
    await flush();
    expect(host.textContent).toContain("AIFC等の取り込みと復旧を使うにはMacアプリを更新");
    expect(host.querySelector("button")).toBeNull();
  });

  it("does not let a changed login discard the previous owner's recovery", async () => {
    const scope = "a".repeat(64);
    const discard = vi.fn();
    ownerScopeMock.mockResolvedValueOnce(scope).mockResolvedValueOnce("b".repeat(64));
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    native.shell = {
      capabilities: async () => ({
        version: "new",
        dev: false,
        features: { recording: true, localTranscription: true, cliAi: true, nativeAudioV2: true },
      }),
      audioRecovery: async () => [{
        stagingId: "0123456789abcdef",
        ownerScope: scope,
        createdAtMs: 1,
        state: "ready",
        source: { kind: "staged", stagingId: "0123456789abcdef" },
        files: [{ index: 0, name: "synthetic.wav", bytes: 64, contentType: "audio/wav", sha256: "c".repeat(64), durationSec: 1, offsetSec: 0 }],
      }],
      audioRecoveryDiscard: discard,
    } as unknown as ShellBridge;
    await act(async () => root.render(<MacNativeAudioImport onCreated={() => undefined} />));
    await flush();
    const discardButton = [...host.querySelectorAll("button")].find((button) => button.textContent === "破棄")!;
    await act(async () => discardButton.click());
    expect(discard).not.toHaveBeenCalled();
    expect(host.textContent).toContain("ログインが変わっている場合");
  });
});
