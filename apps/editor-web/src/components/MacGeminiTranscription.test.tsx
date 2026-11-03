// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellBridge } from "niho-desktop-bridge/shell-bridge";

const native = vi.hoisted(() => ({ shell: null as ShellBridge | null }));
const runMock = vi.hoisted(() => vi.fn());
const statusMock = vi.hoisted(() => vi.fn());

vi.mock("niho-desktop-bridge/tauri-shell-transport", () => ({ detectShell: () => native.shell }));
vi.mock("@/lib/mac-gemini-transcription", async (original) => ({ ...(await original()), runMacGeminiTranscription: runMock }));
vi.mock("@/lib/mac-transcription-client", async (original) => ({ ...(await original()), getMacTranscription: statusMock }));

import { MacGeminiTranscription } from "./MacGeminiTranscription";
import { MacGeminiTranscriptionError } from "@/lib/mac-gemini-transcription";

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
  runMock.mockReset();
  statusMock.mockReset().mockResolvedValue(null);
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

function shell(supported: boolean): ShellBridge {
  return {
    capabilities: async () => ({ version: "test", dev: true, features: { recording: true, localTranscription: true, cliAi: true, geminiCliTranscription: supported } }),
  } as unknown as ShellBridge;
}

describe("Mac Gemini transcription control", () => {
  it("is absent in a normal browser and in an older unsupported Mac shell", async () => {
    await act(async () => root.render(<MacGeminiTranscription pageId="p1" hasTranscript={false} onSucceeded={() => undefined} />));
    await flush();
    expect(host.textContent).toBe("");

    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    native.shell = shell(false);
    await act(async () => root.render(<MacGeminiTranscription pageId="p2" hasTranscript={false} onSucceeded={() => undefined} />));
    await flush();
    expect(host.textContent).toBe("");
  });

  it("shows the Google destination, progress, and reloads the same page after success", async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    native.shell = shell(true);
    const succeeded = vi.fn();
    runMock.mockImplementation(async ({ onProgress }: { onProgress: (value: unknown) => void }) => {
      onProgress({ phase: "transcribing", completed: 1, total: 3 });
    });
    await act(async () => root.render(<MacGeminiTranscription pageId="p3" hasTranscript={false} onSucceeded={succeeded} />));
    await flush();
    expect(host.textContent).toContain("Gemini（このMacのCLI）で文字起こし");
    expect(host.textContent).toContain("Google Geminiへ送ります");
    const button = host.querySelector("button")!;
    await act(async () => button.click());
    expect(host.textContent).toContain("1/3");
    expect(succeeded).toHaveBeenCalledOnce();
  });

  it("offers continuation for a stopped checkpoint instead of silently starting over", async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    native.shell = shell(true);
    statusMock.mockResolvedValue({ run: { status: "failed" }, operationId: "00000000-0000-4000-8000-000000000003" });
    await act(async () => root.render(<MacGeminiTranscription pageId="p4" hasTranscript onSucceeded={() => undefined} />));
    await flush();
    expect(host.textContent).toContain("Gemini（このMacのCLI）で続ける");
  });

  it("stops the native job from the running control and keeps a continuation action", async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    native.shell = shell(true);
    runMock.mockImplementation(({ signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new MacGeminiTranscriptionError("stopped")), { once: true });
    }));
    statusMock.mockResolvedValue({ run: { status: "failed" }, operationId: "00000000-0000-4000-8000-000000000003" });
    await act(async () => root.render(<MacGeminiTranscription pageId="p5" hasTranscript={false} onSucceeded={() => undefined} />));
    await flush();
    await act(async () => host.querySelector("button")!.click());
    expect(host.textContent).toContain("止める");
    await act(async () => host.querySelector("button")!.click());
    await flush();
    expect(host.textContent).toContain("終わった区切りまでこのMacに残してあります");
    expect(host.textContent).toContain("Gemini（このMacのCLI）で続ける");
  });

  it("keeps the local result visible after a recording conflict instead of silently starting over", async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    native.shell = shell(true);
    statusMock.mockResolvedValue({ run: { status: "failed" }, operationId: "00000000-0000-4000-8000-000000000003" });
    runMock.mockRejectedValue(new MacGeminiTranscriptionError("changed"));
    await act(async () => root.render(<MacGeminiTranscription pageId="p6" hasTranscript={false} onSucceeded={() => undefined} />));
    await flush();
    expect(host.textContent).toContain("続ける");
    await act(async () => host.querySelector("button")!.click());
    await flush();
    expect(host.textContent).toContain("終わった区切りはこのMacに残してあります");
    expect(host.textContent).toContain("Gemini（このMacのCLI）で続ける");
  });

  it("labels a pending output as a save retry", async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    native.shell = shell(true);
    statusMock.mockResolvedValue({ run: { status: "running" }, operationId: "00000000-0000-4000-8000-000000000003" });
    runMock.mockRejectedValue(new MacGeminiTranscriptionError("saving"));
    await act(async () => root.render(<MacGeminiTranscription pageId="p7" hasTranscript={false} onSucceeded={() => undefined} />));
    await flush();
    await act(async () => host.querySelector("button")!.click());
    await flush();
    expect(host.textContent).toContain("生成結果はこのMacに保存待ちで残っています");
    expect(host.textContent).toContain("生成結果の保存を再試行");
  });

  it("ignores an old page callback after switching pages", async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    native.shell = shell(true);
    let oldProgress: ((value: unknown) => void) | null = null;
    runMock.mockImplementation(({ onProgress, signal }: { onProgress: (value: unknown) => void; signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
      oldProgress = onProgress;
      signal.addEventListener("abort", () => reject(new MacGeminiTranscriptionError("stopped")), { once: true });
    }));
    await act(async () => root.render(<MacGeminiTranscription pageId="old" hasTranscript={false} onSucceeded={() => undefined} />));
    await flush();
    await act(async () => host.querySelector("button")!.click());
    await act(async () => root.render(<MacGeminiTranscription pageId="new" hasTranscript={false} onSucceeded={() => undefined} />));
    await flush();
    await act(async () => { oldProgress?.({ phase: "transcribing", completed: 9, total: 9 }); });
    expect(host.textContent).not.toContain("9/9");
    expect(host.textContent).not.toContain("止めました");
  });
});
