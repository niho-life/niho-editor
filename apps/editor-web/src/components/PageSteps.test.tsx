// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block, SettingsRecipe } from "@niho/editor-store";
import type { AuthProvider } from "@/auth/types";
import { cancelStepRun, createStepRun, getStepPartialOutput, getSteps, updateStepRunRecipe, type StepsApiDeps } from "@/server/steps-api";
import { StepError, fakeBlocks, type StepExecutor } from "@/steps/executor";
import { MemoryStepRunStore } from "@/steps/memory-store";
import { MemoryTaskQueue } from "@/steps/queue";
import { recipesOf } from "@/steps/recipes";
import type { AttachedAiSteps } from "@/lib/attached-page";
import { runAttempt } from "@/steps/runner";

const router = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn() };
const frame = { stepPagesChanged: vi.fn(), registerAiSteps: vi.fn<(steps: AttachedAiSteps) => () => void>(() => () => undefined) };
const onBodyReplaced = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./EditorFrame", () => ({ useEditorFrame: () => frame }));

import { PageSteps } from "./PageSteps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = "http://editor.test";
const TRANSCRIPT: Block[] = [{ type: "paragraph", content: [{ type: "text", text: "合成の文字起こし" }] }];
const STEPS_PATH = /^\/api\/pages\/([^/]+)\/steps(?:\/runs(?:\/([^/]+)\/(cancel|update-recipe))?)?$/;
const PARTIAL_PATH = /^\/api\/pages\/([^/]+)\/steps\/runs\/([^/]+)\/steps\/(\d+)\/partial$/;

const notUsed = async (): Promise<Response> => {
  throw new Error("the steps API never calls the login routes");
};

/**
 * 本物の受付 API（src/server/steps-api.ts）とメモリの store を、画面の fetch の先につなぐ。
 * `saved` はその人が設定（#108）で変えた・足した手順（空なら既定の 3 つ）。
 */
function server(saved: readonly SettingsRecipe[] = []) {
  const store = new MemoryStepRunStore();
  const queue = new MemoryTaskQueue();
  let recipes = recipesOf(saved);
  const recording = store.addPage("user-a", { kind: "rec", blocks: TRANSCRIPT });
  const auth: AuthProvider = {
    mode: "stub",
    getSession: async () => ({ userId: "user-a", mode: "stub" }),
    beginLogin: notUsed,
    completeLogin: notUsed,
    logout: notUsed,
  };
  const deps: StepsApiDeps = {
    auth: () => auth,
    steps: () => store,
    recipes: () => async () => recipes,
    queue: () => queue,
    env: { EDITOR_STEPS_MODE: "inline" },
  };
  const calls: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const method = init?.method ?? "GET";
    const url = new URL(String(input), ORIGIN);
    calls.push(`${method} ${url.pathname}`);
    const headers = new Headers(init?.headers);
    headers.set("host", "editor.test");
    if (method !== "GET") headers.set("origin", ORIGIN);
    const request = new Request(url, { ...init, method, headers });
    const partialMatch = PARTIAL_PATH.exec(url.pathname);
    if (method === "GET" && partialMatch) {
      return getStepPartialOutput(request, decodeURIComponent(partialMatch[1]!), decodeURIComponent(partialMatch[2]!), partialMatch[3]!, deps);
    }
    const match = STEPS_PATH.exec(url.pathname);
    if (!match) throw new Error(`the test server does not serve ${url.pathname}`);
    const id = decodeURIComponent(match[1]!);
    if (method === "GET") return getSteps(request, id, deps);
    if (match[2]) return match[3] === "cancel"
      ? cancelStepRun(request, id, decodeURIComponent(match[2]), deps)
      : updateStepRunRecipe(request, id, decodeURIComponent(match[2]), deps);
    return createStepRun(request, id, deps);
  });
  /** 積まれている段階を、積まれなくなるまで実行する（本番は Cloud Tasks の worker）。 */
  const work = async (executor: StepExecutor) => {
    for (let tasks = queue.drain(); tasks.length > 0; tasks = queue.drain()) {
      for (const task of tasks) await runAttempt({ store, recipes: async () => recipes, executor, queue }, task);
    }
  };
  return { store, queue, deps, recipes, setRecipes(next: typeof recipes) { recipes = next; }, recording, calls, fetchImpl, work };
}

/** `failAt` の段階だけ（やり直せない失敗で）落ちる実行器。ほかの段階は成功する。 */
function executorFailingAt(failAt: number | null, code = "invalid_output", partial?: Block[]): StepExecutor {
  return {
    async run(input) {
      if (input.stepIndex === failAt) throw new StepError(code, false, partial);
      return { blocks: fakeBlocks(input) };
    },
  };
}

const good = executorFailingAt(null);

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(async () => {
  await unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(props: { pageId: string; kind: "rec" | "step"; parentId: string | null }) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <PageSteps pageId={props.pageId} kind={props.kind} parentId={props.parentId} media={null} onBodyReplaced={onBodyReplaced}>
        <p>本文</p>
      </PageSteps>,
    );
  });
  await settle();
}

async function unmount() {
  const current = root;
  root = null;
  await act(async () => current?.unmount());
  container?.remove();
  container = null;
}

/** 進んでいる要求（fetch）と、そのあとの描画を待つ。 */
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
/** 時間を進める（読み直しの間隔）。 */
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
/** この画面へ戻ってくる（別のページを見ていた・タブを離れていた）。戻ったら状態を読み直す。 */
const back = () =>
  act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
  });

/** 帯の段階（名前・状態の言葉・状態の class）。 */
function band(): { label: string; say: string; state: string }[] {
  return [...container!.querySelectorAll<HTMLButtonElement>("ol.es-steps--band > li > button")].map((button) => ({
    label: button.childNodes[1]?.textContent ?? "",
    say: button.querySelector("small")?.textContent ?? "",
    state: /es-step--([a-z]+)/.exec(button.className)?.[1] ?? "",
  }));
}
const note = () => container!.querySelector(".es-stepband-note")?.textContent ?? "";
const bandActions = () => [...container!.querySelectorAll<HTMLButtonElement>(".es-redo button")].map((button) => button.textContent ?? "");
const entry = () => [...container!.querySelectorAll<HTMLButtonElement>(".es-makefrom button")].map((button) => button.textContent ?? "");
const press = (label: string, where: string) => {
  const button = [...container!.querySelectorAll<HTMLButtonElement>(`${where} button`)].find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`${label} is not on the screen`);
  return act(async () => button.click());
};
const pressEntry = (label: string) => press(label, ".es-makefrom");
const pressAction = (label: string) => press(label, ".es-redo");

describe("PageSteps（手順の帯）", () => {
  it("AI レールへ同じ工程一覧と start callback を登録し、選択した工程を既存 API で開始する", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    const registered = frame.registerAiSteps.mock.calls.at(-1)?.[0];
    expect(registered?.ownerId).toBe(api.recording);
    expect(registered?.options.map((option) => option.label)).toEqual(["記事制作", "議事録", "インサイト整理", "コーチング"]);

    let result: Awaited<ReturnType<AttachedAiSteps["start"]>> | undefined;
    await act(async () => {
      result = await registered!.start(registered!.options[0]!.id);
    });
    await settle();
    expect(result).toEqual({ ok: true, message: "「記事制作」を開始しました。進み具合はページの手順に反映されます。" });
    expect(api.calls).toContain(`POST /api/pages/${api.recording}/steps/runs`);
    expect(band().map((step) => step.label)).toEqual(["文字起こし修正", "記事方針", "記事本文"]);
    let stages = frame.registerAiSteps.mock.calls.at(-1)![0];
    expect(stages.options.map((option) => option.label)).toEqual(["文字起こし修正", "記事方針", "記事本文"]);
    expect(stages.options.every((option) => option.disabledReason !== null)).toBe(true);
    await api.work(executorFailingAt(1));
    await wait(4_000);
    stages = frame.registerAiSteps.mock.calls.at(-1)![0];
    expect(stages.options[1]!.disabledReason).toBeNull();
    expect(stages.options[2]!.disabledReason).toContain("手前の段階");
    await act(async () => { result = await stages.start(stages.options[2]!.id); });
    expect(result?.ok).toBe(false);
    await act(async () => { result = await stages.start(stages.options[1]!.id); });
    expect(result?.ok).toBe(true);
    const request = api.fetchImpl.mock.calls.filter((call) => call[1]?.method === "POST").at(-1)!;
    expect(JSON.parse(String(request[1]!.body))).toMatchObject({ recipe: "tpl-1", fromStep: 1 });

  });

  it("polling does not fetch partial text; opening the keyboard disclosure fetches it on demand", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    await pressEntry("記事にする");
    await settle();
    const partial: Block[] = [{ type: "paragraph", content: [{ type: "text", text: "画面で確認する合成の途中出力" }] }];
    await api.work(executorFailingAt(0, "output_too_long", partial));
    await wait(4_000);

    const disclosure = container!.querySelector<HTMLDetailsElement>(".es-stepband-partial");
    expect(disclosure).not.toBeNull();
    expect(disclosure!.querySelector("summary")?.textContent).toContain("途中までの出力を確認");
    expect(container!.textContent).not.toContain("画面で確認する合成の途中出力");
    expect(api.calls.some((call) => call.endsWith("/partial"))).toBe(false);

    await act(async () => {
      disclosure!.open = true;
      disclosure!.dispatchEvent(new Event("toggle"));
      await Promise.resolve();
    });
    await settle();
    expect(api.calls.some((call) => call.endsWith("/partial"))).toBe(true);
    expect(container!.textContent).toContain("画面で確認する合成の途中出力");
  });

  it("shows the pinned revision and asks for a reviewed design update", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    await pressEntry("記事にする");
    await settle();
    expect(container!.textContent).toContain("使用中の手順: 第1版");
    await pressAction("やめる");
    await settle();
    api.setRecipes(api.recipes.map((recipe) => recipe.id === "tpl-1"
      ? { ...recipe, revision: 2, steps: recipe.steps.map((step, index) => index === 0 ? { ...step, name: "新しい段階" } : step) }
      : recipe));
    await unmount();
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    expect(container!.textContent).toContain("手順が新しくなっています。変更内容を見る");
    expect(container!.textContent).toContain("名前: 文字起こし修正 → 新しい段階");
    await press("今の設計に更新", ".es-stepband-note");
    await settle();
    expect(container!.textContent).toContain("使用中の手順: 第2版（現在: 第2版）");
    expect(api.calls.some((call) => call.includes("update-recipe"))).toBe(true);
  });
  it("録音ページでは「この録音から」の入口を出し、押すと手順が始まって帯が出る", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    expect(band()).toEqual([]);
    expect(entry()).toEqual(["記事にする", "議事録にする", "インサイトを整理する", "コーチングにする", "手順を変える"]);

    await pressEntry("記事にする");
    await settle();
    expect(container!.textContent).toContain("記事制作の手順");
    expect(band()).toEqual([
      { label: "文字起こし修正", say: "待機", state: "wait" },
      { label: "記事方針", say: "待機", state: "wait" },
      { label: "記事本文", say: "待機", state: "wait" },
    ]);
    expect(note()).toBe("順番を待っています。画面を閉じても進みます。");
    // 動いている間は入口を出さず、できるのは「やめる」だけ
    expect(entry()).toEqual([]);
    expect(bandActions()).toEqual(["やめる"]);

    // 段階を実行し始めると「作成中」になる
    await api.store.claimAttempt((await currentRun(api)).id, 0);
    await wait(4_000);
    expect(band()[0]).toEqual({ label: "文字起こし修正", say: "作成中", state: "run" });
    expect(note()).toBe("「文字起こし修正」を作成中です。画面を閉じても進みます。");
  });

  it("入口と帯は、設定（#108）で変えた・足した手順に従う（画面は静的な一覧を持たない）", async () => {
    // 既定の tpl-2 の名前を変え、手順を 1 つ足した人
    const api = server([
      { id: "tpl-2", name: "座談会メモ", guide: "", steps: [{ id: "d9c3x7mf", name: "まとめ", instruction: "まとめる。" }] },
      { id: "r-1", name: "対談", guide: "", steps: [{ id: "s-1", name: "書き起こし", instruction: "書き起こす。" }] },
    ]);
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    // 既定の名前のままの手順は決まった言い方、変えた・足した手順はその名前から
    expect(entry()).toEqual(["記事にする", "座談会メモにする", "インサイトを整理する", "コーチングにする", "対談にする", "手順を変える"]);

    // 足した手順を始めると、帯の名前も段階の名前もその人の定義に従う
    await pressEntry("対談にする");
    await settle();
    expect(container!.textContent).toContain("対談の手順");
    expect(band()).toEqual([{ label: "書き起こし", say: "待機", state: "wait" }]);

    // 名前を変えた既定の手順も同じ
    await pressAction("やめる");
    await settle();
    await pressEntry("座談会メモにする");
    await settle();
    expect(container!.textContent).toContain("座談会メモの手順");
    expect(band()).toEqual([{ label: "まとめ", say: "待機", state: "wait" }]);
  });

  it("受入: 手順の途中で画面を閉じても進み、戻ると帯が最新", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    await pressEntry("記事にする");
    await settle();
    expect(band().map((step) => step.say)).toEqual(["待機", "待機", "待機"]);

    // 画面を閉じる
    await unmount();
    const closed = api.calls.length;
    // 閉じている間に、サーバー（worker）が手順を進める。画面はもう何も読まない
    await api.work(good);
    await act(async () => void (await vi.advanceTimersByTimeAsync(120_000)));
    expect(api.calls.length).toBe(closed);

    // 戻ってくると、帯は最新（すべて済み）
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    expect(band()).toEqual([
      { label: "文字起こし修正", say: "済み", state: "done" },
      { label: "記事方針", say: "済み", state: "done" },
      { label: "記事本文", say: "済み", state: "done" },
    ]);
    expect(note()).toBe("すべての段階が済みました。");
    // 終わった手順は読み直さない（最初の 1 回だけ）
    const read = api.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(120_000)));
    expect(api.calls.length).toBe(read);
  });

  it("受入: 上流のサブページを直すと下流に「前提変更」が付き、その段階から作り直すと消える", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    await pressEntry("記事にする");
    await settle();
    await api.work(good);
    const run = await currentRun(api);
    const [first, second, third] = run.steps.map((step) => step.pageId);

    // 段階 1（記事方針）のページを開く
    await unmount();
    await mount({ pageId: second!, kind: "step", parentId: api.recording });
    expect(band().map((step) => step.say)).toEqual(["済み", "済み", "済み"]);

    // 上流（文字起こし修正）を直して、このページへ戻ってくる（終わった手順は読み直さないので、戻ったときに読む）
    api.store.pages.get(first!)!.blocks = [{ type: "paragraph", content: [{ type: "text", text: "手で直した結果" }] }];
    await wait(60_000);
    expect(band().map((step) => step.say)).toEqual(["済み", "済み", "済み"]);
    await back();
    expect(band()).toEqual([
      { label: "文字起こし修正", say: "済み", state: "done" },
      { label: "記事方針", say: "元にしたページが変わりました。", state: "stale" },
      { label: "記事本文", say: "元にしたページが変わりました。", state: "stale" },
    ]);
    expect(note()).toBe("元にしたページが変わりました。「記事方針」から作り直すと印が消えます。");
    expect(bandActions()).toEqual(["「記事方針」からやり直す", "はじめから作り直す"]);

    // その段階から作り直すと、前提変更の印は消える（段階 0 は作り直さない）
    await pressAction("「記事方針」からやり直す");
    await settle();
    expect(band().map((step) => step.state)).toEqual(["done", "wait", "wait"]);
    expect(api.fetchImpl.mock.calls.some(([, init]) => init?.body === JSON.stringify({ recipe: "tpl-1", fromStep: 1 }))).toBe(true);

    await api.work(good);
    await wait(60_000);
    expect(band().map((step) => step.say)).toEqual(["済み", "済み", "済み"]);
    expect(note()).toBe("すべての段階が済みました。");
    expect(third).toBeDefined();
  });

  it("失敗した段階だけやり直せる", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    await pressEntry("記事にする");
    await settle();
    await api.work(executorFailingAt(1));
    await wait(60_000);
    expect(band()).toEqual([
      { label: "文字起こし修正", say: "済み", state: "done" },
      { label: "記事方針", say: "失敗", state: "failed" },
      { label: "記事本文", say: "待機", state: "wait" },
    ]);
    expect(note()).toBe("「記事方針」が失敗しました。AI の答えを本文にできませんでした。手順の指示やお手本を見直すと直ることがあります。");
    // 失敗したあとは、別の手順も始められる
    expect(entry()).toEqual(["記事にする", "議事録にする", "インサイトを整理する", "コーチングにする", "手順を変える"]);

    await pressAction("「記事方針」からやり直す");
    await settle();
    await api.work(good);
    await wait(60_000);
    expect(band().map((step) => step.say)).toEqual(["済み", "済み", "済み"]);
    // 段階 0 は作り直さず、前の結果をそのまま使う（reused）
    expect((await currentRun(api)).steps.map((step) => step.state)).toEqual(["reused", "succeeded", "succeeded"]);
  });

  it("AI がまだ設定されていない失敗では、やり直しのボタンを出さない", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    await pressEntry("記事にする");
    await settle();
    await api.work(executorFailingAt(0, "ai_unavailable"));
    await wait(60_000);

    expect(band()[0]).toEqual({ label: "文字起こし修正", say: "失敗", state: "failed" });
    expect(note()).toBe("「文字起こし修正」が失敗しました。AI がまだ設定されていないので、この段階を作れません。設定が済むまでお待ちください。");
    // 押しても同じ結果になるボタンは出さない。code そのものも出さない
    expect(bandActions()).toEqual([]);
    expect(container!.textContent).not.toContain("ai_unavailable");
    // 録音ページの入口は残る（直ったあとに始め直せる）
    expect(entry()).toEqual(["記事にする", "議事録にする", "インサイトを整理する", "コーチングにする", "手順を変える"]);
  });

  it("今月の上限に達した失敗では、やり直しの代わりに使用量への案内だけを出す", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    await pressEntry("記事にする");
    await settle();
    await api.work(executorFailingAt(0, "quota_exceeded"));
    await wait(60_000);

    expect(note()).toBe("「文字起こし修正」が失敗しました。今月の AI の使用量が上限に達しました。来月まで手順を実行できません。");
    expect(bandActions()).toEqual(["使用量を見る"]);
    await pressAction("使用量を見る");
    expect(router.push).toHaveBeenCalledWith("/settings#es-s-ai");
  });

  it("原因を直せる失敗では、やり直しと手順への案内の両方を出す", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    await pressEntry("記事にする");
    await settle();
    await api.work(executorFailingAt(1, "ai_bad_request"));
    await wait(60_000);

    expect(note()).toBe("「記事方針」が失敗しました。AI がこの指示を受け付けませんでした。手順の指示やお手本を短くすると直ることがあります。");
    expect(bandActions()).toEqual(["「記事方針」からやり直す", "はじめから作り直す", "手順を見る"]);
    await pressAction("手順を見る");
    expect(router.push).toHaveBeenCalledWith("/settings#es-s-steps");
  });

  it("待てば直る失敗では、今までどおりやり直せる", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    await pressEntry("記事にする");
    await settle();
    await api.work(executorFailingAt(0, "ai_timeout"));
    await wait(60_000);

    expect(note()).toBe("「文字起こし修正」が失敗しました。AI の答えを待てる時間を過ぎました。少し待ってもう一度お試しください。");
    expect(bandActions()).toEqual(["「文字起こし修正」からやり直す", "はじめから作り直す"]);
    await pressAction("「文字起こし修正」からやり直す");
    await settle();
    await api.work(good);
    await wait(60_000);
    expect(band().map((step) => step.say)).toEqual(["済み", "済み", "済み"]);
  });

  it("帯の段階を押すとそのサブページへ移り、開いている段階は押しても移らない", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    await pressEntry("記事にする");
    await settle();
    await api.work(good);
    const run = await currentRun(api);
    await unmount();
    await mount({ pageId: run.steps[1]!.pageId, kind: "step", parentId: api.recording });

    await press("記事本文", "ol.es-steps--band");
    expect(router.push).toHaveBeenCalledWith(`/p/${run.steps[2]!.pageId}`);
    router.push.mockClear();
    await press("記事方針", "ol.es-steps--band");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("「やめる」で取消し、そのあともう一度始められる", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    await pressEntry("議事録にする");
    await settle();
    expect(container!.textContent).toContain("議事録の手順");

    await pressAction("やめる");
    await settle();
    expect(note()).toBe("手順を取消しました。もう一度始められます。");
    expect(band().map((step) => step.say)).toEqual(["待機", "待機"]);
    expect(entry()).toEqual(["記事にする", "議事録にする", "インサイトを整理する", "コーチングにする", "手順を変える"]);

    await pressEntry("記事にする");
    await settle();
    expect(container!.textContent).toContain("記事制作の手順");
  });

  it("手順に関わらないページでは、帯も入口も出さず本文だけを並べる", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11", kind: "step", parentId: null });
    expect(container!.textContent).toBe("本文");
    expect(api.calls).toEqual([]);
  });

  it("状態を読めなかったことは帯の下に出し、ログインが切れたら読み直すのをやめる", async () => {
    const api = server();
    const signedOut: AuthProvider = { ...api.deps.auth(), getSession: async () => null };
    vi.stubGlobal("fetch", api.fetchImpl);
    api.deps.auth = () => signedOut;
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    expect(note()).toBe("ログインが切れています。もう一度ログインしてください。");
    const read = api.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(120_000)));
    expect(api.calls.length).toBe(read);
  });

  it("開いている段階が終わったら、本文が入れ替わったことを知らせる（#37 P1）", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    await pressEntry("記事にする");
    await settle();
    const run = await currentRun(api);
    const second = run.steps[1]!.pageId;

    // 録音ページの本文は手順が書き換えないので、録音ページでは知らせない
    await api.work(good);
    await wait(60_000);
    expect(onBodyReplaced).not.toHaveBeenCalled();

    // 実行の途中の段階のページを開いたまま、その段階が終わったとき（上流を直して、その段階から作り直す）
    await unmount();
    api.store.pages.get(run.steps[0]!.pageId)!.blocks = [{ type: "paragraph", content: [{ type: "text", text: "手で直した" }] }];
    await mount({ pageId: second, kind: "step", parentId: api.recording });
    await pressAction("「記事方針」からやり直す");
    await settle();
    // まだ実行していない（待機）ので知らせない
    expect(onBodyReplaced).not.toHaveBeenCalled();
    expect(band()[1]!.state).toBe("wait");

    await api.work(good);
    await wait(60_000);
    expect(band()[1]!.state).toBe("done");
    expect(onBodyReplaced).toHaveBeenCalledTimes(1);

    // 読み直すたびに知らせない（途中 → 済みの境目だけ）
    await back();
    expect(onBodyReplaced).toHaveBeenCalledTimes(1);
    // 済んだページを開き直しただけでも知らせない
    await unmount();
    await mount({ pageId: second, kind: "step", parentId: api.recording });
    expect(onBodyReplaced).toHaveBeenCalledTimes(1);
  });

  it("終わったら通知する（許可されているときだけ。本文は入れない）", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    const made: { title: string; body: string | undefined }[] = [];
    const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
    class FakeNotification {
      static permission: NotificationPermission = "default";
      static requestPermission = requestPermission;
      constructor(title: string, options?: NotificationOptions) {
        made.push({ title, body: options?.body });
      }
    }
    vi.stubGlobal("Notification", FakeNotification);

    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    // 始めるときに許可を聞く（押した操作の中なので聞いてよい）
    await pressEntry("記事にする");
    await settle();
    expect(requestPermission).toHaveBeenCalledTimes(1);

    // まだ許可されていないので、終わっても通知しない
    await api.work(good);
    await wait(60_000);
    expect(made).toEqual([]);

    // 許可されたあと、動いている → 終わったの境目で 1 回だけ通知する
    FakeNotification.permission = "granted";
    await pressAction("はじめから作り直す");
    await settle();
    await api.work(good);
    await wait(60_000);
    expect(made).toEqual([{ title: "NIHO editor", body: "記事制作の手順が終わりました。" }]);
    // 開き直しただけでは通知しない（閉じている間に終わったものを、戻るたびに知らせない）
    await unmount();
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    expect(made).toHaveLength(1);
  });

  it("サイドバーへ、手順のサブページとその状態を知らせる", async () => {
    const api = server();
    vi.stubGlobal("fetch", api.fetchImpl);
    await mount({ pageId: api.recording, kind: "rec", parentId: null });
    await pressEntry("インサイトを整理する");
    await settle();
    const run = await currentRun(api);
    expect(frame.stepPagesChanged).toHaveBeenCalledWith(api.recording, [{ id: run.steps[0]!.pageId, title: "インサイト", stepStatus: "wait" }]);

    await api.work(good);
    await wait(60_000);
    expect(frame.stepPagesChanged).toHaveBeenLastCalledWith(api.recording, [{ id: run.steps[0]!.pageId, title: "インサイト", stepStatus: "done" }]);
  });
});

/** サーバーが持っている今の run（画面の表示とは別に、store の中身を確かめるため）。 */
async function currentRun(api: ReturnType<typeof server>) {
  const listed = await api.store.listRun("user-a", api.recording);
  if (!listed?.run) throw new Error("the test server has no run");
  return listed.run;
}
