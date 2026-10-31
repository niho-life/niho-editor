import { describe, expect, it } from "vitest";

import { createShellBridge, isShellWindow, type ShellTransport } from "./shell-bridge";
import { SHELL_COMMANDS, isShellError, type ShellAiEnvelope, type ShellRecordingEvent } from "./shell-contract";

type Call = { command: string; args: Record<string, unknown> | undefined };

/** 偽の transport：呼ばれた command と引数を覚え、channel は番号付きの印を返す。 */
function fakeTransport(results: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const handlers: Array<(value: unknown) => void> = [];
  const transport: ShellTransport = {
    invoke: async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      return results[command] as T;
    },
    channel: <T>(onMessage: (value: T) => void) => {
      handlers.push(onMessage as (value: unknown) => void);
      return { channel: handlers.length };
    },
  };
  return { transport, calls, handlers };
}

describe("createShellBridge", () => {
  it("呼ぶ command は Rust の名前、引数は camelCase の id だけ（パスは渡さない）", async () => {
    const { transport, calls } = fakeTransport();
    const shell = createShellBridge(transport);
    const noop = () => undefined;
    await shell.capabilities();
    await shell.micStatus(true);
    await shell.recordingStart("rec-1", noop);
    await shell.recordingStop("rec-1");
    await shell.recordingDiscard("rec-1");
    await shell.audioPick();
    await shell.stagingDiscard("0123456789abcdef");
    await shell.transcribeLocal(
      "job-1",
      { kind: "staged", stagingId: "0123456789abcdef" },
      { language: "ja", speakerMode: "auto", hints: [{ term: "NIHO" }] },
      noop,
    );
    await shell.transcribeStop("job-1");
    await shell.aiEngines();
    await shell.aiTurn(
      "turn-1",
      {
        engine: "cli:claude-code",
        model: "sonnet",
        instruction: "短くして",
        page: { pageId: "p1", title: "t", markdown: "# t\n" },
      },
      noop,
    );
    await shell.aiStop("turn-1");
    expect(calls).toEqual([
      { command: "shell_capabilities", args: undefined },
      { command: "shell_mic_status", args: { request: true } },
      { command: "shell_recording_start", args: { recordingId: "rec-1", onEvent: { channel: 1 } } },
      { command: "shell_recording_stop", args: { recordingId: "rec-1" } },
      { command: "shell_recording_discard", args: { recordingId: "rec-1" } },
      { command: "shell_audio_pick", args: undefined },
      { command: "shell_staging_discard", args: { stagingId: "0123456789abcdef" } },
      {
        command: "shell_transcribe_local",
        args: {
          jobId: "job-1",
          source: { kind: "staged", stagingId: "0123456789abcdef" },
          language: "ja",
          speakerMode: "auto",
          hints: [{ term: "NIHO" }],
          onEvent: { channel: 2 },
        },
      },
      { command: "shell_transcribe_stop", args: { jobId: "job-1" } },
      { command: "shell_ai_engines", args: undefined },
      {
        command: "shell_ai_turn",
        args: {
          turnId: "turn-1",
          request: {
            engine: "cli:claude-code",
            model: "sonnet",
            instruction: "短くして",
            page: { pageId: "p1", title: "t", markdown: "# t\n" },
          },
          onEvent: { channel: 3 },
        },
      },
      { command: "shell_ai_stop", args: { turnId: "turn-1" } },
    ]);
    // 全部の command を 1 度ずつ呼んだ（読み出しの 2 つは下のテスト）
    const used = new Set(calls.map((call) => call.command));
    for (const command of Object.values(SHELL_COMMANDS)) {
      if (command === SHELL_COMMANDS.recordingRead || command === SHELL_COMMANDS.audioRead) continue;
      expect(used.has(command), command).toBe(true);
    }
  });

  it("hints を省くと空の配列で渡す", async () => {
    const { transport, calls } = fakeTransport();
    await createShellBridge(transport).transcribeLocal(
      "job-1",
      { kind: "recording", recordingId: "rec-1" },
      { language: "en", speakerMode: "none" },
      () => undefined,
    );
    expect(calls[0]?.args?.hints).toEqual([]);
    expect(calls[0]?.args?.source).toEqual({ kind: "recording", recordingId: "rec-1" });
  });

  it("channel のイベントはそのまま handler に届く", async () => {
    const { transport, handlers } = fakeTransport();
    const shell = createShellBridge(transport);
    const recording: ShellRecordingEvent[] = [];
    const ai: ShellAiEnvelope[] = [];
    await shell.recordingStart("rec-1", (event) => recording.push(event));
    await shell.aiTurn(
      "turn-1",
      { engine: "cli:codex", model: "gpt-5.1-codex", instruction: "x", page: { pageId: "p", title: "", markdown: "" } },
      (envelope) => ai.push(envelope),
    );
    handlers[0]?.({ type: "Level", db: -20, durationSec: 1.5 });
    handlers[0]?.({ type: "Done", audio: { recordingId: "rec-1", name: "録音", durationSec: 3, exported: true } });
    handlers[1]?.({ turnId: "turn-1", seq: 0, event: { type: "TextDelta", text: "直し" } });
    expect(recording).toEqual([
      { type: "Level", db: -20, durationSec: 1.5 },
      { type: "Done", audio: { recordingId: "rec-1", name: "録音", durationSec: 3, exported: true } },
    ]);
    expect(ai).toEqual([{ turnId: "turn-1", seq: 0, event: { type: "TextDelta", text: "直し" } }]);
  });

  it("音声のバイト列は Uint8Array で返す（Tauri の ArrayBuffer・配列のどちらでも）", async () => {
    const { transport, calls } = fakeTransport({
      shell_recording_read: new Uint8Array([1, 2, 3]).buffer,
      shell_audio_read: [4, 5],
    });
    const shell = createShellBridge(transport);
    expect(Array.from(await shell.recordingRead("rec-1"))).toEqual([1, 2, 3]);
    expect(Array.from(await shell.audioRead("0123456789abcdef", 0))).toEqual([4, 5]);
    expect(calls).toEqual([
      { command: "shell_recording_read", args: { recordingId: "rec-1" } },
      { command: "shell_audio_read", args: { stagingId: "0123456789abcdef", index: 0 } },
    ]);
    const broken = createShellBridge(fakeTransport({ shell_recording_read: "not bytes" }).transport);
    await expect(broken.recordingRead("rec-1")).rejects.toThrow(TypeError);
  });

  it("結果と reject はそのまま通す", async () => {
    const error = { code: "shell_ai_engine_unsupported", message: "この AI はこの Mac では動かせません。" };
    const transport: ShellTransport = {
      invoke: async () => {
        throw error;
      },
      channel: () => undefined,
    };
    await expect(createShellBridge(transport).aiEngines()).rejects.toBe(error);
    expect(isShellError(error)).toBe(true);
    expect(isShellError(new Error("x"))).toBe(false);
    expect(isShellError(null)).toBe(false);
  });
});

describe("isShellWindow", () => {
  it("Tauri の webview だけ true", () => {
    expect(isShellWindow({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(isShellWindow({})).toBe(false);
    expect(isShellWindow(undefined)).toBe(false);
    expect(isShellWindow(null)).toBe(false);
    expect(isShellWindow("window")).toBe(false);
  });
});
