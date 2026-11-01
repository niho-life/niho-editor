import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { SOURCE_STEP_ID, type About, type ConversationFile, type TurnPageChange, type TurnVersion } from "@niho/docs-core";
import { loadComposerPlace, markPageUndone, undoPageChange } from "./composer";
import { errorMessage, type Bridge, type ProjectId, type RecordingRef } from "./bridge";
import {
  chatUnavailableReason,
  conversationEntries,
  draftKeyOf,
  markUndone,
  newConversation,
  parseConversations,
  runChatTurn,
  saveProjectDrafts,
  undoVersion,
  type ConversationEntry,
  type DraftLike,
  type ChatTarget,
  type LiveChat,
} from "./chat";
import { newId } from "./format";
import { isMarkdownChanged } from "./markdown";
import { candidateMarkdown, recordingKey, recordingRef, type RecordingView } from "./project-view";
import type { ActiveRun } from "./run-state";
import type { AppSettings } from "./settings";

/**
 * 「AIと作る」の状態（App が持つ。画面を切り替えても実行中の依頼を失わない）: 録音ごとの会話・表示する会話・実行中の依頼・
 * 送信・停止・元に戻す。同じ案件の実行（工程・会話。別の録音も）は 1 つ（acquire_run_lock は案件単位）。依頼は同時に 1 つ。
 */

/** 「新しい会話」を選んだ印（次の送信で新しい修正の会話を始める）。 */
export const NEW_CONVERSATION = "new";
/** 逐次表示を描き直す間隔。 */
const LIVE_FLUSH_MS = 120;

export type ChatController = {
  /** 表示している録音の会話（新しい順）。 */
  conversations: ConversationFile[];
  /** 会話一覧の読込状態。読み込み完了前は送信を止める。 */
  conversationsStatus: "loading" | "ready" | "error";
  reloadConversations: () => void;
  /** 実行中の依頼（どの録音でも 1 つ）。 */
  live: LiveChat | null;
  /** 表示している録音で選んだ会話（null は最後に動いた会話、NEW_CONVERSATION は新しい会話）。 */
  selection: string | null;
  /** 送信の準備中・実行中。 */
  sending: boolean;
  /** 送信を始めた場所。null はフォルダ外、undefined は送信していない。画面を移っても変えない。 */
  sendingProjectId: ProjectId | undefined;
  /** 設定のために入力欄を使えない理由（API キー方式・モデルが無い）。 */
  unavailable: string | null;
  /** 入力欄の打ちかけ（録音ごと。録音のページと子ページを行き来しても残す）。 */
  draft: string;
  setDraft: (text: string) => void;
  /** 送れなかった指示を入力欄に戻す（その間に打っていなければ）。 */
  restoreDraft: (text: string) => void;
  /** 送る（依頼が始まらなかったら false。終わるまで待つ）。 */
  send: (text: string) => Promise<boolean>;
  stop: () => void;
  select: (conversationId: string | null) => void;
  startNew: () => void;
  undo: (conversationId: string, turnId: string, version: TurnVersion) => Promise<void>;
  /** composer: AI が直した文書ページを、直す前の本文に戻す。 */
  undoPage: (conversationId: string, turnId: string, change: TurnPageChange) => Promise<void>;
  /** composer: AI が直した・作った文書ページを開く。 */
  openPage: (pageId: string) => void;
  loadVersion: (stepId: string, version: number) => Promise<string>;
  /**
   * 送れなかった・元に戻せなかった理由（#18788。入力欄の下の帯に残す。表示している録音の分だけ）。次の送信・元に戻す・「閉じる」で消す。
   * 成功の確認（「元に戻しました」など）は App のトースト。
   */
  failure: string | null;
  dismissFailure: () => void;
  /** 本文をコピーする（App の「コピー」と同じ。途中までの出力の「コピー」）。 */
  copy: (markdown: string) => void;
};

/**
 * 表示する会話: 選んだもの（まだファイルになっていない新しい会話なら null）、選んでいなければ最後に動いたもの。
 * 「新しい会話」を選んでいれば null。
 */
export function displayedEntry(
  view: RecordingView,
  conversations: readonly ConversationFile[],
  selection: string | null,
  target: ChatTarget | null = null,
): ConversationEntry | null {
  if (selection === NEW_CONVERSATION) return null;
  const runs = view.runs.filter((run) =>
    target
      ? run.candidateId === target.candidateId || (run.candidateId === undefined && target.artifactId === target.stepId && run.stepId === target.stepId)
      : run.candidateId === undefined,
  );
  const entries = conversationEntries(conversations, runs);
  if (selection) return entries.find((entry) => entry.id === selection) ?? null;
  return entries[0] ?? null;
}

export function useChat(props: {
  bridge: Bridge;
  view: RecordingView | null;
  settings: AppSettings;
  documentChat?: { pageId: string; flush: () => Promise<boolean> };
  /** 「あなたについて」（保存済みの内容。依頼のシステム側に添える）。 */
  about: About;
  activeRun: ActiveRun | null;
  drafts: Readonly<Record<string, DraftLike>>;
  setDrafts: Dispatch<SetStateAction<Record<string, DraftLike>>>;
  reloadView: (rec: RecordingRef) => Promise<RecordingView>;
  refreshProjects: () => Promise<unknown>;
  showToast: (text: string) => void;
  target?: ChatTarget | null;
  writableArtifactId?: string | null;
  /**
   * 開いている録音の文書を読むだけにする理由（複数案があって案を開いていない録音ページ）。会話は送れて、AI は録音の文書を読み、
   * 文書ページを直す・新しい文書を作るだけにする（composer #18722。録音の文書を直すように頼まれたらこの理由を返す）。
   */
  recordingReadOnly?: string | null;
  /** composer: 依頼・元に戻すで文書ページを直した・作った（開いている文書を読み直し、レールを更新する）。 */
  onPagesChanged?: (projectId: ProjectId, changedPageIds: readonly string[], createdPageIds: readonly string[]) => void | Promise<void>;
  /** composer: 会話の「開く」で文書ページを開く。 */
  onOpenPage?: (projectId: ProjectId, pageId: string) => void;
  /** 人の保存が state 反映前から動いているか。 */
  writeBlocked: () => boolean;
  /**
   * この書きかけ（鍵は draftKeyOf の形）は、App が直前に自動で版にした本文と同じか（#18912。送る前の保存で同じ版を重ねない・
   * 元に戻す前の確かめで版になっていない編集とみなさない）。
   */
  versioned?: (key: string, markdown: string) => boolean;
  /** 本文をコピーする（App の「コピー」。成功・失敗の知らせも App が出す）。 */
  copy?: (markdown: string) => void;
}): ChatController {
  const { bridge, view } = props;
  const [conversations, setConversations] = useState<Record<string, ConversationFile[]>>({});
  const [conversationStatus, setConversationStatus] = useState<Record<string, "loading" | "ready" | "error">>({});
  const [reloadToken, setReloadToken] = useState<Record<string, number>>({});
  const [selection, setSelection] = useState<Record<string, string | null>>({});
  /** 入力欄の打ちかけ（録音の見え方の鍵 → 文）。 */
  const [composerDrafts, setComposerDrafts] = useState<Record<string, string>>({});
  const [live, setLive] = useState<LiveChat | null>(null);
  const [sending, setSending] = useState(false);
  const [sendingProjectId, setSendingProjectId] = useState<ProjectId | undefined>(undefined);
  /** 送れなかった・元に戻せなかった理由（会話の鍵ごと。入力欄の下の帯）。 */
  const [failure, setFailure] = useState<{ viewId: string; text: string } | null>(null);
  const viewRef = useRef(view);
  const settingsRef = useRef(props.settings);
  const draftsRef = useRef(props.drafts);
  const activeRunRef = useRef(props.activeRun);
  const conversationsRef = useRef(conversations);
  const conversationStatusRef = useRef(conversationStatus);
  const selectionRef = useRef(selection);
  const liveRef = useRef<LiveChat | null>(null);
  const sendingRef = useRef(false);
  const stopRef = useRef(false);
  const flushTimer = useRef<number | null>(null);
  const mountedRef = useRef(false);
  // App の関数（showToast・reloadView・refreshProjects・setDrafts）は最新のものを使う
  const hostRef = useRef(props);
  hostRef.current = props;
  viewRef.current = view;
  settingsRef.current = props.settings;
  draftsRef.current = props.drafts;
  activeRunRef.current = props.activeRun;
  conversationsRef.current = conversations;
  conversationStatusRef.current = conversationStatus;
  selectionRef.current = selection;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (flushTimer.current !== null) {
        window.clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
    };
  }, []);

  const target = props.target ?? null;
  const viewId = view ? `${view.key}::chat:${target?.candidateId ?? "shared"}` : null;
  const viewRecording = view?.recordingId ?? null;
  const currentReloadToken = viewId ? (reloadToken[viewId] ?? 0) : 0;
  useLayoutEffect(() => {
    if (!viewId || !viewRecording) return;
    const viewProject = viewRef.current?.projectId ?? null;
    let cancelled = false;
    conversationStatusRef.current = { ...conversationStatusRef.current, [viewId]: "loading" };
    setConversationStatus((all) => ({ ...all, [viewId]: "loading" }));
    bridge.listConversations({ projectId: viewProject, recordingId: viewRecording }).then(
      (values) => {
        if (!cancelled) {
          const loaded = parseConversations(values).filter((conversation) =>
            target
              ? conversation.candidateId === target.candidateId || (target.artifactId === target.stepId && conversation.candidateId === undefined)
              : conversation.candidateId === undefined,
          );
          conversationsRef.current = { ...conversationsRef.current, [viewId]: loaded };
          setConversations((all) => ({ ...all, [viewId]: loaded }));
          conversationStatusRef.current = { ...conversationStatusRef.current, [viewId]: "ready" };
          setConversationStatus((all) => ({ ...all, [viewId]: "ready" }));
        }
      },
      () => {
        if (!cancelled) {
          conversationStatusRef.current = { ...conversationStatusRef.current, [viewId]: "error" };
          setConversationStatus((all) => ({ ...all, [viewId]: "error" }));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bridge, currentReloadToken, target?.artifactId, target?.candidateId, target?.stepId, viewId, viewRecording]);

  // 工程の実行が始まったら、その実行の会話を出す（選んでいた会話の選びを外す）
  const runningViewId = props.activeRun
    ? `${recordingKey(props.activeRun)}::chat:${props.activeRun.candidateId ?? "shared"}`
    : null;
  useEffect(() => {
    if (!runningViewId) return;
    setSelection((all) => (all[runningViewId] === undefined ? all : { ...all, [runningViewId]: null }));
  }, [runningViewId, props.activeRun?.stepId]);

  const publishLive = useCallback((next: LiveChat | null, immediate: boolean) => {
    if (!mountedRef.current) return;
    liveRef.current = next;
    const flush = () => {
      flushTimer.current = null;
      if (mountedRef.current) setLive(liveRef.current);
    };
    if (immediate || next === null) {
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
      flush();
    } else if (flushTimer.current === null) {
      flushTimer.current = window.setTimeout(flush, LIVE_FLUSH_MS);
    }
  }, []);

  const putConversation = useCallback((key: string, conversation: ConversationFile) => {
    setConversations((all) => {
      const list = (all[key] ?? []).filter((candidate) => candidate.id !== conversation.id);
      return { ...all, [key]: [conversation, ...list] };
    });
  }, []);

  /** 送れなかった・元に戻せなかった理由を、その会話の入力欄の下に残す（トーストにしない。#18788）。 */
  const fail = useCallback((key: string, text: string) => {
    setFailure({ viewId: key, text });
  }, []);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const current = viewRef.current;
      const instruction = text.trim();
      if (!current || !instruction || sendingRef.current || liveRef.current) return false;
      setFailure(null);
      if (!viewId) return false;
      if (hostRef.current.writeBlocked()) {
        fail(viewId, "保存が終わってから送ってください。");
        return false;
      }
      if (conversationStatusRef.current[viewId] !== "ready") {
        fail(viewId, "会話の読み込みが終わってから送ってください。");
        return false;
      }
      const host = hostRef.current;
      const selectedEntry = displayedEntry(
        current,
        conversationsRef.current[viewId] ?? [],
        selectionRef.current[viewId] ?? null,
        target,
      );
      if (target && selectedEntry?.kind === "file" && selectedEntry.file.candidateId === undefined) {
        fail(viewId, "元の会話は閲覧と元に戻すだけです。案の編集は新しい会話から始めてください。");
        return false;
      }
      const unavailable = chatUnavailableReason(settingsRef.current);
      if (unavailable) {
        fail(viewId, unavailable);
        return false;
      }
      // 実行のロックは案件単位（同じ案件の別の録音の実行中も送らない）
      if (activeRunRef.current?.projectId === current.projectId) {
        fail(viewId, "工程の実行が終わってから送ってください。");
        return false;
      }
      sendingRef.current = true;
      setSending(true);
      setSendingProjectId(current.projectId);
      const rec = recordingRef(current);
      const key = viewId;
      const projectId = current.projectId;
      try {
        await bridge.acquireRunLock(projectId);
      } catch (error) {
        sendingRef.current = false;
        setSending(false);
        setSendingProjectId(undefined);
        fail(key, errorMessage(error, "この場所は実行中です。"));
        return false;
      }
      let started = false;
      try {
        // 文書ページの書きかけを先に保存する（AI が古い本文を読まないように）
        if (host.documentChat && !await host.documentChat.flush()) return false;
        // 編集中（未保存）の文書は送る前に保存する（AI が古い文書を読まないように）
        const draftSnapshot = draftsRef.current;
        const saved = await saveProjectDrafts({
          bridge,
          view: current,
          drafts: draftSnapshot,
          newId,
          now: () => new Date(),
          artifactId: host.writableArtifactId,
          target,
          versioned: host.versioned,
        });
        if (saved.length > 0) {
          host.setDrafts((all) => {
            const next = { ...all };
            for (const savedKey of saved) {
              const before = draftSnapshot[savedKey];
              const after = all[savedKey];
              if (before && after && before.markdown === after.markdown) {
                delete next[savedKey];
              }
            }
            return next;
          });
        }
        const fresh = host.documentChat ? current : await host.reloadView(rec);
        // composer（#18722）: 同じ場所の文書ページ・ほかの録音の成果物も作業場所に写す（文書ページの会話は録音の文書を写さない）
        const place = await loadComposerPlace(bridge, projectId, {
          pageId: host.documentChat ? host.documentChat.pageId : fresh.page.id,
          recording: !host.documentChat,
          readOnly: host.documentChat ? null : (host.recordingReadOnly ?? null),
        });
        const files = conversationsRef.current[key] ?? [];
        const entry = displayedEntry(fresh, files, selectionRef.current[key] ?? null, target);
        const generation = fresh.recording.moveGeneration ?? 0;
        const savedConversation = entry?.kind === "file" ? entry.file : null;
        const moved = savedConversation !== null && (savedConversation.locationGeneration ?? 0) !== generation;
        const conversation =
          savedConversation && !moved
            ? savedConversation
            : newConversation({
                // 候補は旧 recording-wide 会話と同じ run id を使わない。既存ファイルと session を上書きせず常に新規にする。
                id: target ? newId("conv") : moved ? newId("conv") : entry?.kind === "run" ? entry.record.id : newId("conv"),
                now: new Date(),
                run: moved ? null : entry?.kind === "run" ? entry.record : null,
                locationGeneration: generation,
                notice: moved ? "移動したので新しい会話で始めます。" : null,
                target,
              });
        setSelection((all) => ({ ...all, [key]: conversation.id }));
        stopRef.current = false;
        started = true;
        const outcome = await runChatTurn({
          bridge,
          view: fresh,
          conversation,
          instruction,
          place,
          settings: settingsRef.current,
          about: host.about,
          newId,
          now: () => new Date(),
          onLive: (next) => publishLive(next, liveRef.current === null),
          isStopRequested: () => stopRef.current,
          target,
          writableArtifactId: host.writableArtifactId,
        });
        putConversation(key, outcome.conversation);
        // 依頼の最中に書きかけにした文書は、画面は書きかけのまま（AI の版は履歴にある）
        for (const version of outcome.turn.versions) {
          if (draftsRef.current[draftKeyOf(current.key, version.artifactId ?? version.stepId)]) {
            host.showToast(`${version.stepName}は編集中のため、画面は編集中の内容のままです（AI の版 ${version.version} は履歴にあります）。`);
          }
        }
        if (!host.documentChat) await host.reloadView(rec).catch(() => undefined);
        await host.refreshProjects().catch(() => undefined);
        if (outcome.changedPageIds.length > 0 || outcome.createdPageIds.length > 0) {
          await host.onPagesChanged?.(projectId, outcome.changedPageIds, outcome.createdPageIds);
        }
        return true;
      } catch (error) {
        fail(key, errorMessage(error, "送れませんでした。もう一度送ってください。"));
        return started;
      } finally {
        publishLive(null, true);
        await bridge.releaseRunLock(projectId).catch(() => undefined);
        sendingRef.current = false;
        setSending(false);
        setSendingProjectId(undefined);
      }
    },
    [bridge, fail, publishLive, putConversation, target, viewId],
  );

  const reloadConversations = useCallback(() => {
    if (!viewId) return;
    conversationStatusRef.current = { ...conversationStatusRef.current, [viewId]: "loading" };
    setConversationStatus((all) => ({ ...all, [viewId]: "loading" }));
    setReloadToken((all) => ({ ...all, [viewId]: (all[viewId] ?? 0) + 1 }));
  }, [viewId]);

  const stop = useCallback(() => {
    const current = liveRef.current;
    if (!current || stopRef.current) return;
    stopRef.current = true;
    publishLive({ ...current, stopRequested: true }, true);
    void (async () => {
      // 依頼が CLI に届く前（cliTurnId が無い・まだ登録されていない）は少し待って送り直す
      for (let attempt = 0; attempt < 20; attempt++) {
        const turnId = liveRef.current?.cliTurnId;
        if (!liveRef.current) return;
        if (turnId && (await bridge.stopTurn(turnId).catch(() => false))) return;
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
    })();
  }, [bridge, publishLive]);

  const select = useCallback((conversationId: string | null) => {
    if (!viewId || liveRef.current) return;
    setSelection((all) => ({ ...all, [viewId]: conversationId }));
    // 前の会話で送れなかった・元に戻せなかった理由は、別の会話を選んだら消す（別の会話の失敗に見せない）
    setFailure(null);
  }, [viewId]);

  const startNew = useCallback(() => select(NEW_CONVERSATION), [select]);

  const undo = useCallback(
    async (conversationId: string, turnId: string, version: TurnVersion) => {
      const current = viewRef.current;
      const host = hostRef.current;
      if (!current || liveRef.current || sendingRef.current) return;
      if (!viewId) return;
      setFailure(null);
      if (host.writeBlocked()) {
        fail(viewId, "保存が終わってから元に戻してください。");
        return;
      }
      const file = (conversationsRef.current[viewId] ?? []).find((candidate) => candidate.id === conversationId);
      if (!file || (file.locationGeneration ?? 0) !== (current.recording.moveGeneration ?? 0)) {
        fail(viewId, "移動前の会話からは元に戻せません。新しい会話を始めてください。");
        return;
      }
      const artifactId = version.artifactId ?? version.stepId;
      const owner = Object.values(current.recording.candidateSets ?? {}).find((set) =>
        Object.values(set.items).some((candidate) => candidate.artifactId === artifactId || candidate.id === version.candidateId),
      );
      const candidateTarget = host.target ?? null;
      if (owner && (!candidateTarget || candidateTarget.stepId !== owner.stepId || candidateTarget.artifactId !== artifactId)) {
        const ownerName = current.flow.steps.find((step) => step.id === owner.stepId)?.name || "この工程";
        fail(viewId, `${ownerName}を元に戻すには、左から対象の案を開いてください。`);
        return;
      }
      const draftKey = draftKeyOf(current.key, version.artifactId ?? version.stepId);
      const draft = draftsRef.current[draftKey];
      const savedMarkdown =
        owner && candidateTarget
          ? candidateMarkdown(current, owner.stepId, candidateTarget.candidateId)
          : artifactId === SOURCE_STEP_ID
            ? current.source
            : current.artifacts[artifactId];
      // 版になっていない編集は、App が元に戻す前に版にする（#18912 before_ai）。版にできなかったときだけ止める
      if (
        draft &&
        !host.versioned?.(draftKey, draft.markdown) &&
        (savedMarkdown === undefined || isMarkdownChanged(draft.markdown, savedMarkdown))
      ) {
        fail(viewId, `${version.stepName}の編集中の内容を版に残せなかったため、元に戻していません。もう一度お試しください。`);
        return;
      }
      const rec = recordingRef(current);
      try {
        await bridge.acquireRunLock(current.projectId);
      } catch (error) {
        fail(viewId, errorMessage(error, "この場所は実行中です。"));
        return;
      }
      try {
        const fresh = await host.reloadView(rec);
        const scopedVersion = owner && candidateTarget
          ? { ...version, stepId: owner.stepId, candidateId: candidateTarget.candidateId, artifactId: candidateTarget.artifactId }
          : version;
        const undoneAs = await undoVersion({ bridge, view: fresh, version: scopedVersion, newId, now: () => new Date() });
        // 版にした編集の書きかけは外す（戻した本文を古い書きかけで隠さない・書き戻さない）
        if (draft) {
          host.setDrafts((all) => {
            if (all[draftKey]?.markdown !== draft.markdown) return all;
            const next = { ...all };
            delete next[draftKey];
            return next;
          });
        }
        const latestFile = (conversationsRef.current[viewId] ?? []).find((candidate) => candidate.id === conversationId);
        if (!latestFile || (latestFile.locationGeneration ?? 0) !== (current.recording.moveGeneration ?? 0)) {
          fail(viewId, "移動前の会話からは元に戻せません。新しい会話を始めてください。");
          return;
        }
        const next = markUndone(latestFile, turnId, version.stepId, undoneAs, new Date());
        await bridge.saveConversation(rec, next);
        putConversation(viewId, next);
        await host.reloadView(rec);
        await host.refreshProjects().catch(() => undefined);
        host.showToast(`${version.stepName}を版 ${version.previous ?? ""} の内容に戻しました（版 ${undoneAs}）`);
      } catch (error) {
        fail(viewId, errorMessage(error, "元に戻せませんでした。"));
      } finally {
        await bridge.releaseRunLock(current.projectId).catch(() => undefined);
      }
    },
    [bridge, fail, putConversation, viewId],
  );

  const undoPage = useCallback(
    async (conversationId: string, turnId: string, change: TurnPageChange) => {
      const current = viewRef.current;
      const host = hostRef.current;
      if (!current || liveRef.current || sendingRef.current || !viewId) return;
      setFailure(null);
      if (host.writeBlocked()) {
        fail(viewId, "保存が終わってから元に戻してください。");
        return;
      }
      const file = (conversationsRef.current[viewId] ?? []).find((candidate) => candidate.id === conversationId);
      if (!file || (file.locationGeneration ?? 0) !== (current.recording.moveGeneration ?? 0)) {
        fail(viewId, "移動前の会話からは元に戻せません。新しい会話を始めてください。");
        return;
      }
      if (host.documentChat && !(await host.documentChat.flush())) return;
      try {
        await bridge.acquireRunLock(current.projectId);
      } catch (error) {
        fail(viewId, errorMessage(error, "この場所は実行中です。"));
        return;
      }
      try {
        await undoPageChange({ bridge, projectId: current.projectId, change });
        const latestFile = (conversationsRef.current[viewId] ?? []).find((candidate) => candidate.id === conversationId);
        if (latestFile) {
          const next = markPageUndone(latestFile, turnId, change.pageId, new Date());
          await bridge.saveConversation(recordingRef(current), next);
          putConversation(viewId, next);
        }
        await host.onPagesChanged?.(current.projectId, [change.pageId], []);
        host.showToast(`${change.title}を直す前の内容に戻しました`);
      } catch (error) {
        fail(viewId, errorMessage(error, "元に戻せませんでした。"));
      } finally {
        await bridge.releaseRunLock(current.projectId).catch(() => undefined);
      }
    },
    [bridge, fail, putConversation, viewId],
  );

  const openPage = useCallback((pageId: string) => {
    const current = viewRef.current;
    if (current) hostRef.current.onOpenPage?.(current.projectId, pageId);
  }, []);

  const loadVersion = useCallback(
    async (stepId: string, version: number) => {
      const current = viewRef.current;
      if (!current) throw { code: "no_project", message: "録音のページが開かれていません。" };
      return bridge.readVersion(recordingRef(current), stepId, version);
    },
    [bridge],
  );

  const setDraft = (text: string) => {
    if (!viewId) return;
    setComposerDrafts((all) => ({ ...all, [viewId]: text }));
  };
  const restoreDraft = (text: string) => {
    if (!viewId) return;
    setComposerDrafts((all) => (all[viewId] ? all : { ...all, [viewId]: text }));
  };

  return {
    conversations: viewId ? (conversations[viewId] ?? []) : [],
    conversationsStatus: viewId ? (conversationStatus[viewId] ?? "loading") : "ready",
    reloadConversations,
    live,
    selection: viewId ? (selection[viewId] ?? null) : null,
    sending,
    sendingProjectId,
    unavailable: chatUnavailableReason(props.settings),
    draft: viewId ? (composerDrafts[viewId] ?? "") : "",
    setDraft,
    restoreDraft,
    send,
    stop,
    select,
    startNew,
    undo,
    undoPage,
    openPage,
    loadVersion,
    failure: viewId && failure?.viewId === viewId ? failure.text : null,
    dismissFailure: () => setFailure(null),
    copy: (markdown: string) => hostRef.current.copy?.(markdown),
  };
}
