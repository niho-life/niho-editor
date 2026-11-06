"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PageKind } from "@niho/editor-store";
import type { PageFlowRow } from "niho-docs-ui/page/PageFlow";
import type { AttachedAiSteps, AttachedFlow } from "@/lib/attached-page";
import { getFlow, setFlowRecipe, startFlowRun, type FlowRow, type FlowState } from "@/lib/flow-client";
import { StepsRequestError, cancelStepRun, isStepRunDone, resumeStepRun, type StepRun } from "@/lib/steps-client";
import { isStepRunActive, stepBandNote, stepDoneMessage, stepRunActions } from "@/lib/steps-view";
import { TranscriptionRequestError, startTranscription } from "@/lib/transcription-client";
import { useEditorFrame, type FrameFlowPage } from "./EditorFrame";

/**
 * 状態を読み直す間隔（ms）。動いている間だけ、だんだん空けながら読む（短い間隔で回さない）。
 * 画面が隠れている間は読まず、戻ってきたら 1 回だけ読み直す。画面を離れたら止める。
 */
const POLL_MS = [4_000, 7_000, 12_000, 20_000, 30_000] as const;

function pollDelay(round: number): number {
  return POLL_MS[Math.min(round, POLL_MS.length - 1)]!;
}

/** 文字起こしのエンジンの表示名（API の id は小文字。画面は製品の名前）。 */
export const ENGINE_LABELS: Readonly<Record<string, string>> = { deepgram: "Deepgram", gemini: "Gemini", fake: "テスト用（偽物）" };

export function engineLabel(engine: string): string {
  return ENGINE_LABELS[engine] ?? engine;
}

function messageOf(error: unknown): string {
  if (error instanceof StepsRequestError) {
    if (error.status === 401) return "ログインが切れています。もう一度ログインしてください。";
    if (error.error === "run_in_progress") return "いま別の手順が動いています。終わるまで待ってください。";
    if (error.error === "invalid_from_step") return "このタブからは、その段階を作れません。";
    if (error.error === "recipe_unusable") return "このフォルダの手順は、いまのままでは実行できません。設定の「手順」を確かめてください。";
    if (error.error === "input_changed") return "入力が変わったので、区切りの続きからはやり直せません。この段階を最初から作り直してください。";
    if (error.error === "not_resumable") return "この手順は区切りの続きからやり直せません。この段階を最初から作り直してください。";
    if (error.error === "steps_unavailable" || error.status === 503) return "いま手順を実行できません。しばらくしてからもう一度。";
    if (error.status === 404) return "このページの流れは見つかりませんでした。";
  }
  if (error instanceof TranscriptionRequestError) {
    if (error.status === 401) return "ログインが切れています。もう一度ログインしてください。";
    if (error.status === 409) return "いま文字起こしが動いています。終わるまで待ってください。";
    if (error.status === 503) return "いま文字起こしを始められません。しばらくしてからもう一度。";
    return "文字起こしを始められませんでした。";
  }
  return "流れの状態を読めませんでした。しばらくしてからもう一度。";
}

/** 許可されているときだけブラウザ通知を出す（設計 §7.2。本文は入れず、終わったことだけ）。 */
function notifyDone(state: FlowState, run: StepRun): void {
  const message = stepDoneMessage(state.recipes, run);
  if (message === null || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification("NIHO editor", { body: message, tag: `steps-${run.id}` });
  } catch {
    // 通知を出せない環境（権限を取り消された直後など）では黙ってあきらめる
  }
}

/** 始めるときに、まだ聞いていなければ通知の許可を聞く（押した操作の中なので聞いてよい）。 */
function askNotifyPermission(): void {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Notification.requestPermission().catch(() => undefined);
}

/** 流れの行（サーバーの形）を、パネルの行（docs-ui の PageFlow）にする。エンジンは表示名を付ける。 */
export function panelRowsOf(rows: readonly FlowRow[]): PageFlowRow[] {
  return rows.map((row, index) => ({
    key: row.kind === "step" ? `step:${row.stepId ?? index}` : row.kind,
    kind: row.kind,
    name: row.name,
    holder: row.holder,
    tabs: row.tabs.map((tab) => ({ id: tab.id, label: tab.label, status: tab.status, running: tab.running })),
    current: row.current,
    from: row.from,
    action: row.action,
    ...(row.engines === undefined ? {} : { engines: row.engines.map((engine) => ({ id: engine.id, label: engineLabel(engine.id), used: engine.used })) }),
  }));
}

/** 一覧へ知らせる行（フォルダ・入れ物・タブ）。 */
export function framePagesOf(state: FlowState): FrameFlowPage[] {
  const pages: FrameFlowPage[] = [];
  const folder = state.tab.folder;
  if (folder) pages.push({ id: folder.id, title: folder.title, kind: "folder", parent: null, page: null, stepStatus: null });
  for (const row of state.rows) {
    if (!row.holder) continue;
    pages.push({ id: row.holder.id, title: row.holder.title, kind: "page", parent: folder?.id ?? null, page: null, stepStatus: null });
    row.tabs.forEach((tab, index) => {
      pages.push({ id: tab.id, title: row.holder!.title, kind: tab.kind, parent: folder?.id ?? null, page: row.holder!.id, stepStatus: tab.status, tabName: null, tabPos: index + 1 });
    });
  }
  return pages;
}

/**
 * 開いているタブの流れ（#309）。何も描かない。開いたときに読み、動いている間だけ読み直し、
 * 「ページ」パネルの流れ（`registerFlow`）・AI の工程の選択（`registerAiSteps`）・一覧の行（`flowPagesChanged`）へ渡す。
 *
 * - 「作成」は今のタブを入力にその段階までを作り、できた（最後の）タブを開く。作り直す・もう 1 つはタブの ▾ とここから。
 * - 開いているタブが段階の出力で、その実行が終わって本文が入れ替わったら `onBodyReplaced` で知らせる（呼ぶ側が開き直す）。
 * - 実行はサーバー（Cloud Tasks の worker）が進めるので、画面を閉じても進む。開き直すと読み直すので最新になる。
 */
export function FlowWatcher({ pageId, kind, onBodyReplaced }: { pageId: string; kind: PageKind; onBodyReplaced?: () => void }) {
  const router = useRouter();
  // 枠からは安定した関数だけを取る（枠の値そのものは、登録した流れで変わる。値ごと依存にすると登録→再描画→登録の輪になる）
  const { registerFlow, registerAiSteps, flowPagesChanged, openPage } = useEditorFrame();
  // 流れを持つのは本文のページ（フォルダと、#307 より前の段階のサブページには無い）
  const watched = kind === "note" || kind === "rec" || kind === "article";
  const [state, setState] = useState<FlowState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const ownerGeneration = useRef(0);
  // 前に見た run が動いていたか（動いている → 終わったの境目でだけ通知する）
  const wasActive = useRef(false);
  // 開いているタブの段階が、前に見たとき実行の途中だったか（途中 → 済みの境目でだけ本文を読み直す）
  const wasPending = useRef(false);
  useEffect(() => {
    const generation = ++ownerGeneration.current;
    busyRef.current = false;
    wasActive.current = false;
    wasPending.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the pending request belongs to the previous page
    setBusy(false);
    setState(null);
    return () => { ownerGeneration.current = generation + 1; };
  }, [pageId]);
  // 読み直しの合図（始めた・替えた直後にもう一度読む）
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const replaced = useRef(onBodyReplaced);
  useEffect(() => {
    replaced.current = onBodyReplaced;
  });

  const apply = useCallback(
    (next: FlowState) => {
      setState(next);
      const run = next.run;
      if (run && wasActive.current && isStepRunDone(run)) notifyDone(next, run);
      wasActive.current = isStepRunActive(run);
      // 開いているタブの本文が、この段階の結果で入れ替わった（worker が blocks を書き、revision を進めた）
      const here = run?.steps.find((step) => step.pageId === pageId);
      const pending = here !== undefined && (here.state === "pending" || here.state === "queued" || here.state === "running");
      if (wasPending.current && here?.state === "succeeded") replaced.current?.();
      wasPending.current = pending;
      flowPagesChanged(framePagesOf(next));
    },
    [pageId, flowPagesChanged],
  );

  // 開いたときに読み、動いている間だけ、だんだん間隔を空けて読み直す。隠れている間は読まない
  useEffect(() => {
    if (!watched) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let round = 0;
    const read = async () => {
      timer = null;
      try {
        const latest = await getFlow(pageId);
        if (cancelled) return;
        setNotice(null);
        apply(latest);
        if (!isStepRunActive(latest.run)) return;
      } catch (error) {
        if (cancelled) return;
        // 読めなかったことはパネルに出し、間隔を空けてもう一度（ログインが切れていれば止める）
        setNotice(messageOf(error));
        if (error instanceof StepsRequestError && (error.status === 401 || error.status === 404)) return;
      }
      if (document.hidden) return;
      timer = setTimeout(() => void read(), pollDelay(round++));
    };
    // 画面に戻ってきたら読み直す（閉じている間に進んだ分を取り込む）
    const onVisible = () => {
      if (!document.hidden && timer === null) void read();
    };
    void read();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [watched, pageId, tick, apply]);

  const send = useCallback(async (job: () => Promise<string>): Promise<{ ok: boolean; message: string }> => {
    if (busyRef.current) return { ok: false, message: "いま送っています。終わるまで待ってください。" };
    const generation = ownerGeneration.current;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const message = await job();
      if (generation !== ownerGeneration.current) return { ok: false, message: "ページを移動したため、元のページで流れを確かめてください。" };
      setTick((value) => value + 1);
      return { ok: true, message };
    } catch (error) {
      const message = messageOf(error);
      if (generation === ownerGeneration.current) setNotice(message);
      return { ok: false, message };
    } finally {
      if (generation === ownerGeneration.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, []);

  const open = useCallback((id: string) => {
    if (id === pageId) return;
    if (openPage) openPage(id);
    else router.push(`/p/${id}`);
  }, [pageId, openPage, router]);

  /** 「作成」: 今のタブを入力に、段階 `stepId` まで。できた（最後の）タブを開く。 */
  const makeStep = useCallback((stepId: string) => {
    const row = state?.rows.find((item) => item.kind === "step" && item.stepId === stepId && item.action === "go");
    if (!row || row.stepIndex === undefined) return Promise.resolve({ ok: false, message: "この段階はいま作れません。" });
    const { stepIndex, name } = row;
    askNotifyPermission();
    return send(async () => {
      const result = await startFlowRun(pageId, { inputTab: pageId, toStep: stepIndex });
      if (result.opened && result.opened !== pageId) open(result.opened);
      return `「${name}」を作っています。進み具合は「ページ」パネルの流れに出ます。`;
    });
  }, [state, pageId, send, open]);

  /** パネルの行（key は `step:<段階の id>`）から。 */
  const make = useCallback((row: PageFlowRow) => makeStep(row.key.startsWith("step:") ? row.key.slice("step:".length) : ""), [makeStep]);

  /** タブの ▾「作り直す」「同じ入力でもう 1 つ」（PageTabs から）。 */
  const regenerate = useCallback((tabId: string, how: "regenerate" | "sibling") => send(async () => {
    const result = await startFlowRun(pageId, how === "regenerate" ? { regenerate: tabId } : { sibling: tabId });
    if (how === "sibling" && result.opened && result.opened !== pageId) open(result.opened);
    return how === "regenerate" ? "このタブを作り直しています。" : "同じ入力から、もう 1 つ作っています。";
  }), [pageId, send, open]);

  const transcribe = useCallback((engine: string) => send(async () => {
    // #310 までは録音のタブ＝文字起こし。段落があれば置き換える（今の「もう一度」と同じ）
    await startTranscription(pageId, { engine, replace: true });
    return `${engineLabel(engine)} で文字起こしを始めました。`;
  }), [pageId, send]);

  const changeRecipe = useCallback((recipeId: string) => send(async () => {
    await setFlowRecipe(pageId, recipeId);
    return "このフォルダの手順を替えました。";
  }), [pageId, send]);

  const onAction = useCallback((id: string) => {
    const run = state?.run;
    const folder = state?.tab.folder;
    if (!run || !folder) return;
    const action = stepRunActions(run).find((candidate) => candidate.id === id);
    if (!action) return;
    // 設定の一覧の節へ（今月の使用量は「データ」、手順の指示とお手本は「手順」。節の id は docs-ui の EditorSettingsHub と同じ）
    if (action.settings) router.push(action.settings === "usage" ? "/settings#es-s-data" : "/settings#es-s-steps");
    else if (action.cancel) void send(async () => { await cancelStepRun(folder.id, run.id); return "手順を取消しました。"; });
    else if (action.resume) void send(async () => { await resumeStepRun(folder.id, run.id); return "区切りの続きからやり直しています。"; });
    else if (action.regenerate !== undefined) void regenerate(action.regenerate, "regenerate");
  }, [state, router, send, regenerate]);

  const flow = useMemo<AttachedFlow | null>(() => {
    if (!watched || !state) return null;
    return {
      ownerId: pageId,
      folder: state.tab.folder,
      recipe: { id: state.recipe.id, name: state.recipe.name },
      recipes: state.recipes,
      rows: panelRowsOf(state.rows),
      run: state.run,
      busy,
      note: notice ?? (state.run ? stepBandNote(state.run) : null),
      actions: state.run ? stepRunActions(state.run).map((action) => ({ id: action.id, label: action.label, tone: action.tone })) : [],
      onAction,
      open,
      make,
      regenerate,
      transcribe,
      changeRecipe,
      refresh,
      generated: state.rows.some((row) => row.current && row.tabs.some((tab) => tab.id === pageId && tab.generated)),
    };
  }, [watched, state, pageId, busy, notice, onAction, open, make, regenerate, transcribe, changeRecipe, refresh]);

  useEffect(() => (flow ? registerFlow(flow) : undefined), [flow, registerFlow]);

  const aiSteps = useMemo<AttachedAiSteps | null>(() => {
    if (!watched || !state) return null;
    const commonReason = isStepRunActive(state.run) ? "いま別の手順が動いています。終わるまで待ってください。" : busy ? "いま送っています。" : null;
    const options = state.rows.filter((row) => row.kind === "step" && row.stepId !== undefined).map((row) => ({
      id: `step:${row.stepId}`,
      label: row.name,
      hint: `${state.recipe.name} · このタブからここまで作る`,
      disabledReason: commonReason ?? (row.action === "done" ? "このタブからは作成済みです。" : row.action === null ? "今のタブより前の段階です。" : null),
    }));
    return {
      ownerId: pageId,
      guide: state.run?.hasGuide ? state.recipe.name : null,
      options,
      start: async (id) => {
        const option = options.find((item) => item.id === id);
        if (!option) return { ok: false, message: "この工程は現在の手順にありません。" };
        if (option.disabledReason) return { ok: false, message: option.disabledReason };
        return makeStep(id.slice("step:".length));
      },
    };
  }, [watched, state, pageId, busy, makeStep]);

  useEffect(() => (aiSteps ? registerAiSteps(aiSteps) : undefined), [aiSteps, registerAiSteps]);

  return null;
}
