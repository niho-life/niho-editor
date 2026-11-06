"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { useRouter } from "next/navigation";
import type { Block, PageKind } from "@niho/editor-store";
import { ShellSteps, ShellStepsStart, type ShellStepsAction } from "niho-docs-ui/shell";
import { StepsRequestError, cancelStepRun, getStepPartialOutput, getSteps, isStepRunDone, resumeStepRun, startStepRun, updateStepRunRecipe, type StepRecipeChoice, type StepRun, type StepRunStep } from "@/lib/steps-client";
import {
  isStepRunActive,
  maxStepFrom,
  stepBandActions,
  stepBandNote,
  stepBandSteps,
  stepDoneMessage,
  stepPagesOf,
  stepRecipeName,
  stepStartChoices,
  type StepBandAction,
} from "@/lib/steps-view";
import { useEditorFrame } from "./EditorFrame";
import type { AttachedAiSteps } from "@/lib/attached-page";

/**
 * 状態を読み直す間隔（ms）。動いている間だけ、だんだん空けながら読む（短い間隔で回さない）。
 * 画面が隠れている間は読まず、戻ってきたら 1 回だけ読み直す。画面を離れたら止める。
 */
const POLL_MS = [4_000, 7_000, 12_000, 20_000, 30_000] as const;

function pollDelay(round: number): number {
  return POLL_MS[Math.min(round, POLL_MS.length - 1)]!;
}

function messageOf(error: unknown): string {
  if (error instanceof StepsRequestError) {
    if (error.status === 401) return "ログインが切れています。もう一度ログインしてください。";
    if (error.error === "run_in_progress") return "いま別の手順が動いています。終わるまで待ってください。";
    if (error.error === "invalid_from_step") return "手前の段階が済んでいないので、ここからは作り直せません。";
    if (error.error === "input_changed") return "入力が変わったので、区切りの続きからはやり直せません。この段階を最初から作り直してください。";
    if (error.error === "not_resumable") return "この手順は区切りの続きからやり直せません。この段階を最初から作り直してください。";
    if (error.error === "steps_unavailable" || error.status === 503) return "いま手順を実行できません。しばらくしてからもう一度。";
    if (error.status === 404) return "このページの手順は見つかりませんでした。";
  }
  return "手順の状態を読めませんでした。しばらくしてからもう一度。";
}

/** 許可されているときだけブラウザ通知を出す（設計 §7.2。本文は入れず、終わったことだけ）。 */
function notifyDone(recipes: readonly StepRecipeChoice[], run: StepRun): void {
  const message = stepDoneMessage(recipes, run);
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

function blockText(value: unknown): string {
  if (Array.isArray(value)) return value.map(blockText).join("");
  if (typeof value !== "object" || value === null) return "";
  const node = value as Record<string, unknown>;
  if (node.type === "text") return typeof node.text === "string" ? node.text : "";
  if (node.type === "hardBreak") return "\n";
  const children = Array.isArray(node.content) ? node.content.map(blockText).join("") : "";
  if (node.type === "heading") return "#".repeat(node.attrs && typeof node.attrs === "object" && (node.attrs as Record<string, unknown>).level === 3 ? 3 : 2) + " " + children;
  if (node.type === "bulletList") return Array.isArray(node.content) ? node.content.map((item) => "• " + blockText(item)).join("\n") : "";
  if (node.type === "callout") return children.split("\n").map((line) => "▌ " + line).join("\n");
  return children;
}

function partialText(blocks: readonly Block[]): string {
  return blocks.map((block) => blockText(block)).filter(Boolean).join("\n\n");
}

/** Native details/summary provides keyboard open/close. The body is fetched only on first explicit expansion. */
function StepPartialOutputDisclosure({ parentId, runId, step }: { parentId: string; runId: string; step: StepRunStep }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open || loading || loaded.current) return;
    loaded.current = true;
    setLoading(true);
    void getStepPartialOutput(parentId, runId, step.index)
      .then((blocks) => setContent(partialText(blocks)))
      .catch((reason: unknown) => {
        loaded.current = false;
        setError(reason instanceof StepsRequestError && reason.status === 401
          ? "ログインが切れています。もう一度ログインしてください。"
          : reason instanceof StepsRequestError && reason.status === 404
            ? "この途中出力はもう利用できません。手順の状態を読み直してください。"
            : "途中出力を読み出せませんでした。しばらくしてからもう一度お試しください。");
      })
      .finally(() => setLoading(false));
  };

  return (
    <details className="es-stepband-partial" onToggle={onToggle}>
      <summary>「{step.name}」の途中までの出力を確認</summary>
      {loading && <p role="status">読み込み中です。</p>}
      {error && <p role="status">{error}</p>}
      {content !== null && <pre aria-label="途中までの出力">{content || "表示できる本文がありません。"}</pre>}
    </details>
  );
}

/**
 * 手順の帯（#37。設計 §7.2）。録音ページと、その手順のサブページで、ページのいちばん上に出る。
 * 録音ページの「この録音から」の入口は、モック v6 と同じく文字起こしの下（`media` の後）に出す。
 *
 * - 状態は親（録音ページ）の id で読む。読むたびにサーバーが前提変更を測り直すので、画面では測らない。
 * - 帯の段階を押すとそのサブページへ移る。失敗した段階・前提が変わった段階からやり直せる（受付 API に `fromStep` を渡すだけ）。
 * - 実行はサーバー（Cloud Tasks の worker）が進めるので、画面を閉じても進む。開き直すと読み直すので帯は最新になる。
 * - 開いているページがその段階で、実行が終わって本文が入れ替わったら `onBodyReplaced` で知らせる（呼ぶ側が開き直す）。
 * - 手順に関わらないページ（録音でもサブページでもない）では、帯も入口も出さず `media` と本文をそのまま並べる。
 */
export function PageSteps({
  pageId,
  kind,
  parentId,
  media,
  onBodyReplaced,
  children,
}: {
  pageId: string;
  kind: PageKind;
  parentId: string | null;
  /** 本文の上に入るもの（録音ページの文字起こし）。 */
  media?: ReactNode;
  /**
   * 開いているページが手順の段階で、その実行が終わって worker が本文を入れ替えた（revision も進んだ）。
   * 呼ぶ側はページを読み直してエディタを開き直す（#37。帯だけ「済み」になってエディタが古いままにならないように）。
   */
  onBodyReplaced?: () => void;
  /** 本文（PageEditor）。 */
  children: ReactNode;
}) {
  const router = useRouter();
  const { stepPagesChanged, registerAiSteps } = useEditorFrame();
  // 手順は録音ページを根に持つ。サブページを開いているときは親で読む
  const rootId = kind === "rec" ? pageId : parentId;
  const [run, setRun] = useState<StepRun | null>(null);
  // その人の手順（設定で変えた名前・足したものを含む。サーバーが状態と一緒に答える）
  const [recipes, setRecipes] = useState<readonly StepRecipeChoice[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const ownerGeneration = useRef(0);
  const [loadedRoot, setLoadedRoot] = useState<string | null>(null);
  useEffect(() => {
    const generation = ++ownerGeneration.current;
    busyRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the pending request belongs to the previous page
    setBusy(false);
    return () => { ownerGeneration.current = generation + 1; };
  }, [rootId, pageId]);
  // 読み直しの合図（始めた・やり直した直後にもう一度読む）
  const [tick, setTick] = useState(0);
  // 通知の文のために、いま読んでいる手順の一覧（apply を作り直さず、送る直前の値を読む）
  const recipesRef = useRef<readonly StepRecipeChoice[]>([]);
  // 前に見た run が動いていたか（動いている → 終わったの境目でだけ通知する）
  const wasActive = useRef(false);
  // 開いているページの段階が、前に見たとき実行の途中だったか（途中 → 済みの境目でだけ本文を読み直す）
  const wasPending = useRef(false);
  const replaced = useRef(onBodyReplaced);
  useEffect(() => {
    replaced.current = onBodyReplaced;
  });

  const apply = useCallback(
    (next: StepRun) => {
      setRun(next);
      if (wasActive.current && isStepRunDone(next)) notifyDone(recipesRef.current, next);
      wasActive.current = isStepRunActive(next);
      // 開いているページの本文が、この段階の結果で入れ替わった（worker が blocks を書き、revision を進めた）
      const here = next.steps.find((step) => step.pageId === pageId);
      const pending = here !== undefined && (here.state === "pending" || here.state === "queued" || here.state === "running");
      if (wasPending.current && here?.state === "succeeded") replaced.current?.();
      wasPending.current = pending;
      if (rootId) stepPagesChanged(rootId, stepPagesOf(next));
    },
    [rootId, pageId, stepPagesChanged],
  );

  // 開いたときに読み、動いている間だけ、だんだん間隔を空けて読み直す。隠れている間は読まない
  useEffect(() => {
    if (!rootId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let round = 0;
    const read = async () => {
      timer = null;
      try {
        const latest = await getSteps(rootId);
        if (cancelled) return;
        setNotice(null);
        recipesRef.current = latest.recipes;
        setRecipes(latest.recipes);
        setLoadedRoot(rootId);
        if (latest.run) apply(latest.run);
        else setRun(null);
        if (!isStepRunActive(latest.run)) return;
      } catch (error) {
        if (cancelled) return;
        // 読めなかったことは帯の下に出し、間隔を空けてもう一度（ログインが切れていれば止める）
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
  }, [rootId, tick, apply]);

  const send = useCallback(async (job: () => Promise<StepRun>): Promise<{ ok: boolean; message: string }> => {
    if (busyRef.current) return { ok: false, message: "いま工程を開始しています。終わるまで待ってください。" };
    const generation = ownerGeneration.current;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const next = await job();
      if (generation !== ownerGeneration.current) return { ok: false, message: "ページを移動したため、元のページで工程の状態を確認してください。" };
      apply(next);
      setTick((value) => value + 1);
      return { ok: true, message: "工程を開始しました。進み具合はページの手順に反映されます。" };
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
  }, [apply]);

  const start = useCallback((recipe: string, fromStep?: number) => {
    if (!rootId) return Promise.resolve({ ok: false, message: "このページには実行できる工程がありません。" });
    askNotifyPermission();
    return send(() => startStepRun(rootId, fromStep === undefined ? { recipe } : { recipe, fromStep }));
  }, [rootId, send]);

  const aiSteps = useMemo<AttachedAiSteps | null>(() => {
    if (!rootId || loadedRoot !== rootId) return null;
    const commonReason = isStepRunActive(run) ? "いま別の手順が動いています。終わるまで待ってください。" : busy ? "いま工程を開始しています。" : null;
    const options = run ? run.steps.map((step) => ({
      id: `stage:${step.index}`,
      label: step.name,
      hint: `${run.recipeName ?? stepRecipeName(recipes, run.recipe)} · この段階から作り直す`,
      disabledReason: commonReason ?? (step.index > maxStepFrom(run) ? "手前の段階が済んでいません。" : null),
    })) : recipes.map((recipe) => ({
      id: recipe.id,
      label: recipe.name,
      hint: "この手順をはじめから開始",
      disabledReason: recipe.unusableReason ?? commonReason,
    }));
    return {
      ownerId: pageId,
      guide: run?.hasGuide ? (run.recipeName ?? stepRecipeName(recipes, run.recipe)) : null,
      options,
      start: async (id) => {
        const option = options.find((item) => item.id === id);
        if (!option) return { ok: false, message: "この工程は現在の手順にありません。" };
        if (option.disabledReason) return { ok: false, message: option.disabledReason };
        const step = run?.steps.find((item) => `stage:${item.index}` === id);
        const result = await start(step && run ? run.recipe : id, step?.index);
        return result.ok ? { ...result, message: `「${option.label}」を開始しました。進み具合はページの手順に反映されます。` } : result;
      },
    };
  }, [rootId, loadedRoot, pageId, recipes, run, busy, start]);

  useEffect(() => (aiSteps ? registerAiSteps(aiSteps) : undefined), [aiSteps, registerAiSteps]);

  if (!rootId) {
    return (
      <>
        {media}
        {children}
      </>
    );
  }
  const root = rootId;

  const actions: StepBandAction[] = run ? stepBandActions(run, pageId) : [];
  const shellActions: ShellStepsAction[] = actions.map((action) => ({ id: action.id, label: action.label, tone: action.tone, busy }));
  const onAction = (id: string) => {
    const action = actions.find((candidate) => candidate.id === id);
    if (!action || !run) return;
    // 設定の一覧の節へ（今月の使用量は「データ」、手順の指示とお手本は「手順」。節の id は docs-ui の EditorSettingsHub と同じ）
    if (action.settings) router.push(action.settings === "usage" ? "/settings#es-s-data" : "/settings#es-s-steps");
    else if (action.cancel) void send(() => cancelStepRun(root, run.id));
    else if (action.resume) void send(() => resumeStepRun(root, run.id));
    else if (action.fromStep !== undefined) void start(run.recipe, action.fromStep);
  };

  return (
    <>
      {run && (
        <ShellSteps
          band
          title={`${run.recipeName ?? stepRecipeName(recipes, run.recipe)}の手順`}
          steps={stepBandSteps(run)}
          currentId={pageId}
          note={notice ?? stepBandNote(run)}
          actions={shellActions}
          onSelect={(stepPageId) => {
            if (stepPageId !== pageId) router.push(`/p/${stepPageId}`);
          }}
          onAction={onAction}
        />
      )}
      {run && run.recipeRevision !== undefined && (
        <div className="es-stepband-note" role="status">
          使用中の手順: 第{run.recipeRevision}版{run.currentRevision !== null && run.currentRevision !== undefined ? `（現在: 第${run.currentRevision}版）` : ""}
          {run.currentRevision !== null && run.currentRevision !== undefined && run.currentRevision !== run.recipeRevision && (
            <details>
              <summary>手順が新しくなっています。変更内容を見る</summary>
              <ul>{(run.designChanges ?? []).map((change, index) => <li key={`${index}-${change}`}>{change}</li>)}</ul>
              <p>更新後、必要な段階は「作り直す」で実行してください。段階の追加・削除・並び替えがある場合は、最初から作り直してください。</p>
              <button type="button" disabled={busy || isStepRunActive(run)} onClick={() => void send(() => updateStepRunRecipe(root, run.id, run.recipeRevision!))}>
                今の設計に更新
              </button>
            </details>
          )}
        </div>
      )}
      {run?.steps.filter((step) => step.state === "failed" && step.hasPartialOutput).map((step) => (
        <StepPartialOutputDisclosure key={run.id + ":" + step.id + ":" + step.tries} parentId={root} runId={run.id} step={step} />
      ))}
      {!run && notice && (
        <p className="es-stepband-note" role="status">
          {notice}
        </p>
      )}
      {media}
      {/* 録音ページで、手順が動いていないときの入口（終わったあとは別の手順も始められる） */}
      {kind === "rec" && recipes.length > 0 && !isStepRunActive(run) && (
        <ShellStepsStart choices={stepStartChoices(recipes)} busy={busy} onPick={(recipe) => void start(recipe)} onChangeSteps={() => router.push("/settings")} />
      )}
      {children}
    </>
  );
}
