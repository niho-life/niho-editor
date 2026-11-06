// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellBridge } from "niho-desktop-bridge/shell-bridge";

const native = vi.hoisted(() => ({ shell: null as ShellBridge | null }));
const runMock = vi.hoisted(() => vi.fn());
const statusMock = vi.hoisted(() => vi.fn());

vi.mock("niho-desktop-bridge/tauri-shell-transport", () => ({ detectShell: () => native.shell }));
vi.mock("@/lib/mac-local-transcription", async (original) => ({ ...(await original()), runMacLocalTranscription: runMock }));
vi.mock("@/lib/mac-local-transcription-client", async (original) => ({ ...(await original()), getMacLocalTranscription: statusMock }));

import { MacLocalTranscription } from "./MacLocalTranscription";
import { MacLocalTranscriptionError } from "@/lib/mac-local-transcription";

let host: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function shell(supported: boolean): ShellBridge {
  return {
    capabilities: async () => ({
      version: "test",
      dev: true,
      features: { recording: true, localTranscription: true, localTranscriptionV2: supported, cliAi: true },
    }),
  } as unknown as ShellBridge;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  native.shell = null;
  runMock.mockReset();
  statusMock.mockReset().mockResolvedValue(null);
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("Apple on-device transcription control", () => {
  it("is absent in Web and gives an update notice only to an older Mac shell", async () => {
    await act(async () => root.render(<MacLocalTranscription pageId="p1" onSucceeded={() => undefined} />));
    await flush();
    expect(host.textContent).toBe("");

    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    native.shell = shell(false);
    await act(async () => root.render(<MacLocalTranscription pageId="p2" onSucceeded={() => undefined} />));
    await flush();
    expect(host.textContent).toContain("Macアプリを更新");
  });

  it("requires an explicit click and states that there is no provider fallback", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    native.shell = shell(true);
    const succeeded = vi.fn();
    runMock.mockResolvedValue(undefined);
    await act(async () => root.render(<MacLocalTranscription pageId="p3" onSucceeded={succeeded} />));
    await flush();
    expect(runMock).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Apple端末内で文字起こし");
    expect(host.textContent).toContain("他のproviderへ自動送信しません");
    await act(async () => host.querySelector("button")!.click());
    expect(runMock).toHaveBeenCalledOnce();
    expect(succeeded).toHaveBeenCalledOnce();
  });

  it("keeps the same operation for a result-only save retry", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    native.shell = shell(true);
    const operationId = "00000000-0000-4000-8000-000000000003";
    statusMock.mockResolvedValue({ run: { status: "running" }, operationId });
    runMock.mockRejectedValue(new MacLocalTranscriptionError("saving"));
    await act(async () => root.render(<MacLocalTranscription pageId="p4" onSucceeded={() => undefined} />));
    await flush();
    expect(host.textContent).toContain("再開");
    await act(async () => host.querySelector("button")!.click());
    await flush();
    expect(runMock.mock.calls[0]?.[0]).toMatchObject({ operationId });
    expect(host.textContent).toContain("認識はやり直しません");
  });
});
