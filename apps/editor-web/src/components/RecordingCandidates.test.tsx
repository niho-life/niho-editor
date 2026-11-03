// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordingCandidateFull, RecordingCandidateSummary, RecordingSnapshot } from "@/lib/recording-client";
import { RecordingCandidates } from "./RecordingCandidates";

const PAGE_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const candidate = (extra: Partial<RecordingCandidateSummary> = {}): RecordingCandidateSummary => ({
  id: FIRST, revision: 3, name: "Deepgram", engine: "deepgram", engineLabel: "Deepgram", language: "ja",
  durationSec: 600, adopted: true, state: "ready", busy: false, segmentCount: 1, preview: ["はじめの段落"],
  createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z", ...extra,
});
const full = (summary: RecordingCandidateSummary, text = "はじめの段落"): RecordingCandidateFull => ({
  ...summary,
  segments: [{ start: 65, end: 70, text, speaker: 1 }],
  speakerNames: { "1": "話し手" },
});
const recording = {
  revision: 8, source: "audio", language: "ja", engine: "fake", durationSec: 610, sourceName: "合成.m4a", sourceSha256: null,
  segments: [{ start: 0, end: 5, text: "採用後", speaker: 1 }], speakerNames: {},
  audio: { status: "uploaded", bytes: 64, contentType: "audio/mp4", expiresAt: "2030-02-01T00:00:00.000Z" },
  createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z",
} as const;

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove(); root = null; container = null; vi.unstubAllGlobals(); vi.useRealTimers();
});

function json(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
type MountOptions = {
  onSnapshot?: (snapshot: RecordingSnapshot) => void; onConflictSnapshot?: (snapshot: RecordingSnapshot) => void;
  onChanged?: () => void; onSeek?: (seconds: number) => void;
  onAdoptingChange?: (adopting: boolean) => void;
  engines?: string[]; defaultEngine?: string | null; adoptDisabled?: boolean;
  adoptedContent?: Pick<RecordingCandidateFull, "segments" | "speakerNames">;
  recordingRevision?: number;
};
async function renderMounted(candidates: RecordingCandidateSummary[], extra: MountOptions = {}) {
  await act(async () => root!.render(<RecordingCandidates
    pageId={PAGE_ID} recordingRevision={extra.recordingRevision ?? 7} candidates={candidates} engines={extra.engines ?? []}
    adoptedContent={extra.adoptedContent}
    defaultEngine={extra.defaultEngine === undefined ? "fake" : extra.defaultEngine}
    onSnapshot={extra.onSnapshot ?? (() => undefined)} onChanged={extra.onChanged ?? (() => undefined)} onSeek={extra.onSeek}
    onConflictSnapshot={extra.onConflictSnapshot}
    onAdoptingChange={extra.onAdoptingChange}
    adoptDisabled={extra.adoptDisabled}
  />));
}
async function mount(candidates: RecordingCandidateSummary[], extra: MountOptions = {}) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await renderMounted(candidates, extra);
}
const button = (text: string) => [...container!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
const click = (text: string) => act(async () => button(text)!.click());
const select = (label: string, value: string) => act(async () => {
  const element = container!.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  element.value = value; element.dispatchEvent(new Event("change", { bubbles: true }));
});
const write = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("RecordingCandidates", () => {
  it("狭幅用の案切替を操作でき、比較と編集の重大なアクセシビリティ違反がない", async () => {
    const a = candidate({ adopted: false });
    const b = candidate({ id: SECOND, name: "比較案", adopted: false });
    vi.stubGlobal("fetch", vi.fn(async (path: string) => json(200, { candidate: full(path.includes(SECOND) ? b : a) })));
    await mount([a, b]);
    await select("比較する案1", a.id);
    await select("比較する案2", b.id);
    await click("案 2");
    expect(button("案 2")?.getAttribute("aria-pressed")).toBe("true");
    expect(container!.querySelector(`[data-candidate-editor="${a.id}"]`)?.getAttribute("data-mobile-hidden")).toBe("true");
    expect(container!.querySelector(`[data-candidate-editor="${b.id}"]`)?.hasAttribute("data-mobile-hidden")).toBe(false);
    const result = await axe.run(container!, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.filter((item) => item.impact === "serious" || item.impact === "critical")).toEqual([]);
  });

  it("生成は明示操作だけで始まり、送信先を明示する", async () => {
    const created = candidate({ id: SECOND, revision: 1, name: "Gemini", engine: "gemini", engineLabel: "Gemini", adopted: false, state: "pending", busy: true, segmentCount: 0 });
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ engine: "gemini" });
      return json(202, { candidate: created, candidates: [candidate(), created], run: { id: "r" }, cannotStart: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    await mount([], { engines: ["deepgram", "gemini"] });
    expect(container!.textContent).toContain("閲覧や比較では採用されません");
    expect(fetchMock).not.toHaveBeenCalled();
    await click("Gemini で案を作る");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("任意の2案を読み、各時刻を共通 seekTo に接続する", async () => {
    const other = candidate({ id: SECOND, revision: 4, name: "Gemini", engine: "gemini", engineLabel: "Gemini", adopted: false });
    vi.stubGlobal("fetch", vi.fn(async (path: string) => json(200, { candidate: path.includes(SECOND) ? full(other, "二つ目") : full(candidate(), "一つ目") })));
    const onSeek = vi.fn();
    await mount([candidate(), other], { onSeek });
    await select("比較する案1", FIRST);
    await select("比較する案2", SECOND);
    expect(container!.querySelectorAll("[data-candidate-editor]")).toHaveLength(2);
    expect(container!.textContent).toContain("一つ目");
    expect(container!.textContent).toContain("二つ目");
    const times = [...container!.querySelectorAll<HTMLButtonElement>('button[aria-label="01:05へ移動"]')];
    await act(async () => times[1]!.click());
    expect(onSeek).toHaveBeenCalledWith(65);
    expect(button("案 1")).toBeTruthy();
    expect(button("案 2")).toBeTruthy();
  });

  it("読み込み中は比較案の選択を止め、選んだ案の読み込みを取りこぼさない", async () => {
    const a = candidate({ adopted: false });
    const b = candidate({ id: SECOND, name: "比較案", adopted: false });
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi.fn(async (path: string) => path.includes(FIRST)
      ? new Promise<Response>((resolve) => { resolveFirst = resolve; })
      : json(200, { candidate: full(b) }));
    vi.stubGlobal("fetch", fetchMock);
    await mount([a, b]);
    await select("比較する案1", FIRST);
    const secondSelect = container!.querySelector<HTMLSelectElement>('select[aria-label="比較する案2"]')!;
    expect(secondSelect.disabled).toBe(true);
    await select("比較する案2", SECOND);
    await act(async () => resolveFirst(json(200, { candidate: full(a) })));
    expect(secondSelect.disabled).toBe(false);
    expect(secondSelect.value).toBe("");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("採用中案の比較本文は候補snapshotではなく録音editorの最新正本を表示する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { candidate: full(candidate(), "古い候補本文") })));
    await mount([candidate()], {
      adoptedContent: { segments: [{ start: 2, end: 4, text: "録音editorの最新本文", speaker: 1 }], speakerNames: { "1": "最新話者" } },
    });
    await select("比較する案1", FIRST);
    expect(container!.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("録音editorの最新本文");
    expect(container!.textContent).toContain("最新話者");
    expect(container!.textContent).not.toContain("古い候補本文");
  });

  it("非採用案の名前・本文・話者名を candidate revision CAS で明示保存する", async () => {
    const other = candidate({ id: SECOND, revision: 4, name: "Gemini", adopted: false });
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({ expectedRevision: 4, name: "比較案", speakerNames: { "1": "聞き手" } });
        expect(body.segments[0].text).toBe("直した本文");
        expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/);
        return json(200, { candidate: { ...full(other, "直した本文"), revision: 5, name: "比較案", speakerNames: { "1": "聞き手" } }, replayed: false });
      }
      return json(200, { candidate: full(other) });
    });
    vi.stubGlobal("fetch", fetchMock);
    await mount([other]);
    await select("比較する案1", SECOND);
    const name = container!.querySelector<HTMLInputElement>('input[value="Gemini"]')!;
    const speaker = container!.querySelector<HTMLInputElement>('input[value="話し手"]')!;
    const text = container!.querySelector<HTMLTextAreaElement>("textarea")!;
    await write(name, "比較案");
    await write(speaker, "聞き手");
    await write(text, "直した本文");
    expect(button("この案を採用")?.disabled).toBe(true);
    await click("変更を保存");
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(true);
  });

  it("409では相手の最新版と自分のdraftを残し、明示確認するまで上書きできない", async () => {
    const other = candidate({ id: SECOND, revision: 4, name: "Gemini", adopted: false });
    let patch = 0;
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        patch += 1;
        const request = JSON.parse(String(init.body));
        if (patch === 1) return json(409, { error: "conflict", candidate: { ...full(other, "相手の本文"), revision: 5 } });
        expect(request.expectedRevision).toBe(5);
        expect(request.segments[0].text).toBe("自分の下書き");
        return json(200, { candidate: { ...full(other, "自分の下書き"), revision: 6 }, replayed: false });
      }
      return json(200, { candidate: full(other) });
    }));
    await mount([other]); await select("比較する案1", SECOND);
    const text = container!.querySelector<HTMLTextAreaElement>("textarea")!;
    await write(text, "自分の下書き");
    await click("変更を保存");
    expect(container!.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("自分の下書き");
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain("入力は残しています");
    expect(container!.querySelector('[aria-label="別の場所で保存された内容"]')?.textContent).toContain("相手の本文");
    expect(button("変更を保存")?.disabled).toBe(true);
    await click("変更を保存");
    expect(patch).toBe(1);
    await click("最新を確認したので、この入力を使う");
    await click("変更を保存");
    expect(patch).toBe(2);
  });

  it("案の選択変更と生成状態の再描画でも未保存draftを保持する", async () => {
    const other = candidate({ id: SECOND, revision: 4, name: "Gemini", adopted: false });
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { candidate: full(other) })));
    await mount([other]);
    await select("比較する案1", SECOND);
    await write(container!.querySelector<HTMLTextAreaElement>("textarea")!, "選択を変えても残す本文");
    await select("比較する案1", "");
    await select("比較する案1", SECOND);
    expect(container!.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("選択を変えても残す本文");

    await act(async () => root!.render(<RecordingCandidates
      pageId={PAGE_ID} recordingRevision={7} candidates={[{ ...other, updatedAt: "2030-01-02T00:00:00.000Z" }]}
      engines={[]} defaultEngine="fake" onSnapshot={() => undefined} onChanged={() => undefined}
    />));
    expect(container!.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("選択を変えても残す本文");
  });

  it("履歴を見て、復元を新版として明示実行する", async () => {
    const other = candidate({ id: SECOND, revision: 4, name: "Gemini", adopted: false });
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/versions")) return json(200, { versions: [{ version: 4, reason: "edit", name: "Gemini", segmentCount: 1, createdAt: "2030-01-02T00:00:00.000Z" }, { version: 2, reason: "initial", name: "旧案", segmentCount: 1, createdAt: "2030-01-01T00:00:00.000Z" }] });
      if (path.endsWith("/versions/2/restore")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ expectedRevision: 4 });
        return json(200, { candidate: { ...full(other, "旧本文"), revision: 5, name: "旧案" }, replayed: false });
      }
      return json(200, { candidate: full(other) });
    });
    vi.stubGlobal("fetch", fetchMock);
    await mount([other]); await select("比較する案1", SECOND); await click("履歴");
    expect(container!.textContent).toContain("版 2 · 初期版");
    await click("この版を復元");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/versions/2/restore"))).toBe(true);
    expect(container!.textContent).toContain("版 2 を新しい版として復元しました");
  });

  it("生成中は編集・復元・採用を無効にする", async () => {
    const pending = candidate({ id: SECOND, adopted: false, state: "pending", busy: true, segmentCount: 0 });
    await mount([candidate({ busy: true }), pending]);
    expect(container!.textContent).toContain("完了するまで編集・復元・採用はできません");
    expect([...container!.querySelectorAll<HTMLButtonElement>("button")].filter((item) => item.textContent?.includes("採用")).every((item) => item.disabled)).toBe(true);
  });

  it("音声が使えなくてもテキストを比較・編集でき、seekだけ無効になる", async () => {
    const other = candidate({ id: SECOND, revision: 4, name: "Gemini", adopted: false });
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { candidate: full(other) })));
    await mount([other]); await select("比較する案1", SECOND);
    expect(container!.textContent).toContain("テキストの比較と編集は続けられます");
    expect(container!.querySelector<HTMLButtonElement>('button[aria-label="01:05へ移動"]')?.disabled).toBe(true);
    expect(container!.querySelector<HTMLTextAreaElement>("textarea")?.readOnly).toBe(false);
  });

  it("閲覧後も採用は別の明示操作で、candidate/recording両revisionを送る", async () => {
    const other = candidate({ id: SECOND, revision: 4, name: "Gemini", adopted: false });
    const onSnapshot = vi.fn();
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/adopt")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ expectedCandidateRevision: 4, expectedRecordingRevision: 7 });
        return json(200, { recording, speakers: [], candidates: [candidate({ adopted: false }), { ...other, adopted: true }] });
      }
      return json(200, { candidate: full(other) });
    });
    vi.stubGlobal("fetch", fetchMock);
    await mount([other], { onSnapshot }); await select("比較する案1", SECOND);
    expect(onSnapshot).not.toHaveBeenCalled();
    await click("この案を採用");
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });

  it("別案を採用した後も以前の採用案を旧本文の編集可能な状態で表示する", async () => {
    const adopted = candidate();
    const nextCandidate = candidate({ id: SECOND, revision: 4, name: "Gemini", adopted: false });
    const oldFull = full(adopted, "以前の採用本文");
    const latestOld = full({ ...adopted, revision: 4, name: "別端末の名前", adopted: false }, "最新の以前案本文");
    const nextFull = full(nextCandidate, "次の候補本文");
    const nextRecording = { ...recording, revision: 9, segments: nextFull.segments, speakerNames: nextFull.speakerNames };
    let nextSnapshot: RecordingSnapshot | null = null;
    let oldCandidateReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/adopt") && init?.method === "POST") {
        return json(200, { recording: nextRecording, speakers: [], candidates: [{ ...adopted, revision: 4, adopted: false }, { ...nextCandidate, adopted: true }] });
      }
      if (path.includes(FIRST)) {
        oldCandidateReads += 1;
        return json(200, { candidate: oldCandidateReads === 1 ? oldFull : latestOld });
      }
      return json(200, { candidate: nextFull });
    }));
    const onSnapshot = (snapshot: RecordingSnapshot) => { nextSnapshot = snapshot; };
    await mount([adopted, nextCandidate], { onSnapshot, adoptedContent: oldFull });
    await select("比較する案1", adopted.id);
    await write(container!.querySelector<HTMLInputElement>(`[data-candidate-editor="${adopted.id}"] input`)!, "自分の未保存名");
    await click("採用する");
    expect(nextSnapshot).not.toBeNull();
    await renderMounted(nextSnapshot!.candidates ?? [], {
      recordingRevision: nextSnapshot!.recording.revision,
      adoptedContent: { segments: nextSnapshot!.recording.segments, speakerNames: nextSnapshot!.recording.speakerNames },
      onSnapshot,
    });
    const oldPane = container!.querySelector<HTMLElement>(`[data-candidate-editor="${adopted.id}"]`)!;
    const oldText = oldPane.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(oldPane.textContent).not.toContain("採用中");
    expect(oldPane.querySelector<HTMLInputElement>("input")?.value).toBe("自分の未保存名");
    expect(oldPane.textContent).toContain("最新を確認したので、この入力を使う");
    expect(oldText.value).toBe("最新の以前案本文");
    expect(oldText.readOnly).toBe(false);
  });

  it("採用の応答を待つ間は親の録音編集を止め、応答後に解除する", async () => {
    const other = candidate({ id: SECOND, revision: 4, name: "Gemini", adopted: false });
    let resolve!: (response: Response) => void;
    const onAdoptingChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (path: string) => path.endsWith("/adopt")
      ? new Promise<Response>((done) => { resolve = done; })
      : json(200, { candidate: full(other) })));
    await mount([other], { onAdoptingChange });
    await select("比較する案1", SECOND);
    await click("この案を採用");
    expect(onAdoptingChange.mock.calls).toEqual([[true]]);
    await act(async () => resolve(json(200, { recording, speakers: [], candidates: [{ ...other, adopted: true }] })));
    expect(onAdoptingChange.mock.calls).toEqual([[true], [false]]);
  });

  it("採用中録音に未保存本文がある間は候補を採用できない", async () => {
    const other = candidate({ id: SECOND, revision: 4, name: "Gemini", adopted: false });
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { candidate: full(other) })));
    await mount([other], { adoptDisabled: true });
    expect(button("採用する")?.disabled).toBe(true);
    await select("比較する案1", SECOND);
    expect(button("この案を採用")?.disabled).toBe(true);
  });

  it("採用409で候補も変わっていたら古い表示を保持し、明示再読込まで採用を止める", async () => {
    const other = candidate({ id: SECOND, revision: 4, name: "Gemini", adopted: false });
    const latest = { ...other, revision: 5 };
    const onConflictSnapshot = vi.fn();
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/adopt") && init?.method === "POST") {
        return json(409, { error: "conflict", recording: { ...recording, revision: 8 }, speakers: [], candidates: [latest] });
      }
      reads += 1;
      return json(200, { candidate: reads === 1 ? full(other, "旧表示") : full(latest, "最新本文") });
    }));
    await mount([other], { onConflictSnapshot });
    await select("比較する案1", SECOND);
    expect(container!.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("旧表示");
    // 一度読み込んだ版を旧版として採用しようとした直後、サーバー側のrevisionだけが進んだ想定にする。
    await click("この案を採用");
    expect(onConflictSnapshot).toHaveBeenCalledTimes(1);
    expect(button("この案を採用")?.disabled).toBe(true);
    expect(button("下書きを破棄して最新を読み直す")).toBeTruthy();
    expect(container!.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("旧表示");
    await click("下書きを破棄して最新を読み直す");
    expect(container!.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("最新本文");
  });
});
