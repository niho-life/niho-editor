/**
 * 殻の command を型付きで呼ぶ。Tauri の import は持たず、`ShellTransport` 越しに呼ぶ（テストでは偽物に替える）。
 * 本番の transport は `tauri-shell-transport.ts`。
 */
import {
  SHELL_COMMANDS,
  type ShellAiEngine,
  type ShellAiEnvelope,
  type ShellAiTurn,
  type ShellAiTurnRequest,
  type ShellAudioSource,
  type ShellAudioRecovery,
  type ShellCapabilities,
  type ShellCommand,
  type ShellMicStatus,
  type ShellRecording,
  type ShellRecordingEvent,
  type ShellStagedAudio,
  type ShellTranscribeEvent,
  type ShellTranscribeOptions,
  type ShellTranscript,
  type ShellGeminiAudioSource,
  type ShellAudioStage,
  type ShellGeminiPreparedFile,
  type ShellGeminiTurn,
} from "./shell-contract";

export type ShellTransport = {
  invoke: <T>(command: ShellCommand, args?: Record<string, unknown>) => Promise<T>;
  /** command に渡す channel（Rust の `Channel<Value>`）。返り値をそのまま `onEvent` の引数に入れる。 */
  channel: <T>(onMessage: (value: T) => void) => unknown;
};

export type ShellBridge = {
  capabilities: () => Promise<ShellCapabilities>;
  /** `request` が true なら、まだ決まっていないときに OS の許可のダイアログを出す。 */
  micStatus: (request: boolean) => Promise<ShellMicStatus>;
  /** 録音を始める。進み（Started・Level）と、画面が止めずに終わったとき（Done・Error）は `onEvent` に来る。 */
  recordingStart: (recordingId: string, onEvent: (event: ShellRecordingEvent) => void) => Promise<{ device: string | null }>;
  recordingStartV2: (recordingId: string, ownerScope: string, onEvent: (event: ShellRecordingEvent) => void) => Promise<{ stagingId: string; device: string | null }>;
  recordingStop: (recordingId: string) => Promise<ShellRecording>;
  recordingDiscard: (recordingId: string) => Promise<void>;
  /** 書き出した音声のバイト列（1 回 512 MB まで）。画面がサーバーへ上げる。 */
  recordingRead: (recordingId: string) => Promise<Uint8Array>;
  /** Mac の選択ダイアログ。取り消したら null。選んだ音声は一時置き場に写される。 */
  audioPick: () => Promise<ShellStagedAudio | null>;
  audioRead: (stagingId: string, index: number) => Promise<Uint8Array>;
  stagingDiscard: (stagingId: string) => Promise<void>;
  /** 端末内の文字起こし。ファイルごとの結果を返す。止めるのは `transcribeStop(jobId)`。 */
  transcribeLocal: (
    jobId: string,
    source: ShellAudioSource,
    options: ShellTranscribeOptions,
    onEvent: (event: ShellTranscribeEvent) => void,
  ) => Promise<ShellTranscript[]>;
  transcribeStop: (jobId: string) => Promise<boolean>;
  localAudioBegin: (jobId: string, partIndex: number, bytes: number, contentType: string, sha256: string) => Promise<ShellAudioStage>;
  localAudioChunk: (jobId: string, partIndex: number, offset: number, chunk: Uint8Array) => Promise<number>;
  localAudioFinish: (jobId: string, partIndex: number) => Promise<void>;
  /** server保存成功後だけ、Apple端末内認識の音声と保存待ち結果を消す。 */
  localDiscard: (jobId: string) => Promise<void>;
  audioPrepare: (jobId: string, source: Exclude<ShellAudioSource, { kind: "server" }>, ownerScope: string) => Promise<ShellAudioRecovery>;
  audioPrepareResume: (jobId: string, stagingId: string, ownerScope: string) => Promise<ShellAudioRecovery>;
  audioPreparedChunk: (stagingId: string, ownerScope: string, index: number, offset: number) => Promise<Uint8Array>;
  audioRecovery: (ownerScope: string) => Promise<ShellAudioRecovery[]>;
  audioPreparedCommit: (stagingId: string, ownerScope: string) => Promise<void>;
  audioRecoveryDiscard: (stagingId: string, ownerScope: string) => Promise<void>;
  /** この Mac で使える CLI の AI（数秒かかる）。 */
  aiEngines: () => Promise<ShellAiEngine[]>;
  /** CLI の AI を 1 回動かす。進みは `onEvent`、最後のイベントと本文の差分は結果に。止めるのは `aiStop(turnId)`。 */
  aiTurn: (turnId: string, request: ShellAiTurnRequest, onEvent: (envelope: ShellAiEnvelope) => void) => Promise<ShellAiTurn>;
  aiStop: (turnId: string) => Promise<boolean>;
  geminiAudioBegin: (jobId: string, partIndex: number, bytes: number, contentType: string, sha256: string) => Promise<ShellAudioStage>;
  /** 4 MiB 以下のchunkをoffset順に渡す。 */
  geminiAudioChunk: (jobId: string, partIndex: number, offset: number, chunk: Uint8Array) => Promise<number>;
  geminiAudioFinish: (jobId: string, partIndex: number) => Promise<void>;
  geminiPrepare: (jobId: string, source: ShellGeminiAudioSource, onEvent: (event: ShellTranscribeEvent) => void) => Promise<ShellGeminiPreparedFile[]>;
  geminiTranscribePart: (
    jobId: string,
    turnId: string,
    file: number,
    part: number,
    systemPrompt: string,
    userPrompt: string,
    onEvent: (envelope: ShellAiEnvelope) => void,
  ) => Promise<ShellGeminiTurn>;
  geminiCheckpointRead: (jobId: string) => Promise<unknown | null>;
  geminiCheckpointWrite: (jobId: string, checkpoint: unknown) => Promise<void>;
  geminiStop: (jobId: string) => Promise<boolean>;
  geminiDiscard: (jobId: string) => Promise<void>;
};

/** Tauri の webview の中か（editor.niho.life をブラウザ・PWA で開いたときは false。SSR で window が無いときも false）。 */
export function isShellWindow(target: unknown): boolean {
  return typeof target === "object" && target !== null && "__TAURI_INTERNALS__" in target;
}

/** `tauri::ipc::Response` のバイト列（Tauri は ArrayBuffer で返す）。 */
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new TypeError("shell: audio bytes expected");
}

export function createShellBridge(transport: ShellTransport): ShellBridge {
  const { invoke, channel } = transport;
  return {
    capabilities: () => invoke<ShellCapabilities>(SHELL_COMMANDS.capabilities),
    micStatus: (request) => invoke<ShellMicStatus>(SHELL_COMMANDS.micStatus, { request }),
    recordingStart: (recordingId, onEvent) =>
      invoke<{ device: string | null }>(SHELL_COMMANDS.recordingStart, { recordingId, onEvent: channel(onEvent) }),
    recordingStartV2: (recordingId, ownerScope, onEvent) =>
      invoke<{ stagingId: string; device: string | null }>(SHELL_COMMANDS.recordingStartV2, { recordingId, ownerScope, onEvent: channel(onEvent) }),
    recordingStop: (recordingId) => invoke<ShellRecording>(SHELL_COMMANDS.recordingStop, { recordingId }),
    recordingDiscard: (recordingId) => invoke<void>(SHELL_COMMANDS.recordingDiscard, { recordingId }),
    recordingRead: async (recordingId) => bytes(await invoke<unknown>(SHELL_COMMANDS.recordingRead, { recordingId })),
    audioPick: () => invoke<ShellStagedAudio | null>(SHELL_COMMANDS.audioPick),
    audioRead: async (stagingId, index) => bytes(await invoke<unknown>(SHELL_COMMANDS.audioRead, { stagingId, index })),
    stagingDiscard: (stagingId) => invoke<void>(SHELL_COMMANDS.stagingDiscard, { stagingId }),
    transcribeLocal: (jobId, source, options, onEvent) =>
      invoke<ShellTranscript[]>(SHELL_COMMANDS.transcribeLocal, {
        jobId,
        source,
        language: options.language,
        speakerMode: options.speakerMode,
        hints: options.hints ?? [],
        onEvent: channel(onEvent),
      }),
    transcribeStop: (jobId) => invoke<boolean>(SHELL_COMMANDS.transcribeStop, { jobId }),
    localAudioBegin: (jobId, partIndex, size, contentType, sha256) =>
      invoke<ShellAudioStage>(SHELL_COMMANDS.localAudioBegin, { jobId, partIndex, bytes: size, contentType, sha256 }),
    localAudioChunk: (jobId, partIndex, offset, chunk) =>
      invoke<number>(SHELL_COMMANDS.localAudioChunk, { jobId, partIndex, offset, chunk }),
    localAudioFinish: (jobId, partIndex) => invoke<void>(SHELL_COMMANDS.localAudioFinish, { jobId, partIndex }),
    localDiscard: (jobId) => invoke<void>(SHELL_COMMANDS.localDiscard, { jobId }),
    audioPrepare: (jobId, source, ownerScope) => invoke<ShellAudioRecovery>(SHELL_COMMANDS.audioPrepare, { jobId, source, ownerScope }),
    audioPrepareResume: (jobId, stagingId, ownerScope) => invoke<ShellAudioRecovery>(SHELL_COMMANDS.audioPrepareResume, { jobId, stagingId, ownerScope }),
    audioPreparedChunk: async (stagingId, ownerScope, index, offset) =>
      bytes(await invoke<unknown>(SHELL_COMMANDS.audioPreparedChunk, { stagingId, ownerScope, index, offset })),
    audioRecovery: (ownerScope) => invoke<ShellAudioRecovery[]>(SHELL_COMMANDS.audioRecovery, { ownerScope }),
    audioPreparedCommit: (stagingId, ownerScope) => invoke<void>(SHELL_COMMANDS.audioPreparedCommit, { stagingId, ownerScope }),
    audioRecoveryDiscard: (stagingId, ownerScope) => invoke<void>(SHELL_COMMANDS.audioRecoveryDiscard, { stagingId, ownerScope }),
    aiEngines: () => invoke<ShellAiEngine[]>(SHELL_COMMANDS.aiEngines),
    aiTurn: (turnId, request, onEvent) =>
      invoke<ShellAiTurn>(SHELL_COMMANDS.aiTurn, { turnId, request, onEvent: channel(onEvent) }),
    aiStop: (turnId) => invoke<boolean>(SHELL_COMMANDS.aiStop, { turnId }),
    geminiAudioBegin: (jobId, partIndex, size, contentType, sha256) =>
      invoke<ShellAudioStage>(SHELL_COMMANDS.geminiAudioBegin, { jobId, partIndex, bytes: size, contentType, sha256 }),
    geminiAudioChunk: (jobId, partIndex, offset, chunk) =>
      invoke<number>(SHELL_COMMANDS.geminiAudioChunk, { jobId, partIndex, offset, chunk }),
    geminiAudioFinish: (jobId, partIndex) => invoke<void>(SHELL_COMMANDS.geminiAudioFinish, { jobId, partIndex }),
    geminiPrepare: (jobId, source, onEvent) =>
      invoke<ShellGeminiPreparedFile[]>(SHELL_COMMANDS.geminiPrepare, { jobId, source, onEvent: channel(onEvent) }),
    geminiTranscribePart: (jobId, turnId, file, part, systemPrompt, userPrompt, onEvent) =>
      invoke<ShellGeminiTurn>(SHELL_COMMANDS.geminiTranscribePart, {
        jobId,
        turnId,
        file,
        part,
        systemPrompt,
        userPrompt,
        onEvent: channel(onEvent),
      }),
    geminiCheckpointRead: (jobId) => invoke<unknown | null>(SHELL_COMMANDS.geminiCheckpointRead, { jobId }),
    geminiCheckpointWrite: (jobId, checkpoint) => invoke<void>(SHELL_COMMANDS.geminiCheckpointWrite, { jobId, checkpoint }),
    geminiStop: (jobId) => invoke<boolean>(SHELL_COMMANDS.geminiStop, { jobId }),
    geminiDiscard: (jobId) => invoke<void>(SHELL_COMMANDS.geminiDiscard, { jobId }),
  };
}
