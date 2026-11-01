// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordingCandidateSummary, RecordingSnapshot } from "@/lib/recording-client";
import { RecordingCandidates } from "./RecordingCandidates";

const PAGE_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const candidate = (extra: Partial<RecordingCandidateSummary> = {}): RecordingCandidateSummary => ({
  id: FIRST,
  name: "Deepgram",
  engine: "deepgram",
  engineLabel: "Deepgram",
  language: "ja",
  durationSec: 600,
  adopted: true,
  state: "ready",
  segmentCount: 2,
  preview: ["はじめの段落"],
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
  ...extra,
});

const recording = {
  revision: 3,
  source: "audio",
  language: "ja",
  engine: "fake",
  durationSec: 610,
  sourceName: "合成の会議.m4a",
  sourceSha256: null,
  segments: [{ start: 0, end: 5, text: "別のエンジンの段落", speaker: 1 }],
  speakerNames: {},
  audio: { status: "uploaded", bytes: 64, contentType: "audio/mp4", expiresAt: "2030-02-01T00:00:00.000Z" },
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
};

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function mount(
  candidates: RecordingCandidateSummary[],
  handlers: { onSnapshot?: (snapshot: RecordingSnapshot) => void; onChanged?: () => void; engines?: string[]; defaultEngine?: string | null } = {},
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <RecordingCandidates
        pageId={PAGE_ID}
        candidates={candidates}
        engines={handlers.engines ?? []}
        defaultEngine={handlers.defaultEngine === undefined ? handlers.engines?.[0] ?? "fake" : handlers.defaultEngine}
        onSnapshot={handlers.onSnapshot ?? (() => undefined)}
        onChanged={handlers.onChanged ?? (() => undefined)}
      />,
    );
  });
}

const buttonByText = (text: string) => [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);
const alertText = () => container!.querySelector('[role="alert"]')?.textContent ?? "";
const statusText = () => container!.querySelector('[role="status"]')?.textContent ?? "";
const click = (text: string) => act(async () => buttonByText(text)!.click());

describe("RecordingCandidates（文字起こしの案）", () => {
  it("案を作ると、その案の文字起こしが始まる", async () => {
    const created = candidate({ id: SECOND, name: "開発の偽物", engine: "fake", engineLabel: "開発の偽物", adopted: false, state: "pending", segmentCount: 0, preview: [] });
    const fetchMock = vi.fn(async (path: string) => {
      expect(path).toBe(`/api/pages/${PAGE_ID}/recording/candidates`);
      return json(202, { candidate: created, candidates: [candidate(), created], run: { id: "r", status: "queued" }, cannotStart: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    await mount([], { onChanged });
    await click("別の案を作る");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(statusText()).toContain("開発の偽物 の案を作っています");
  });

  it("エンジンが 2 つ使えるときは、どちらで作るかを選べる", async () => {
    const created = candidate({ id: SECOND, name: "Gemini", engine: "gemini", engineLabel: "Gemini", adopted: false, state: "pending", segmentCount: 0, preview: [] });
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ engine: "gemini" });
      return json(202, { candidate: created, candidates: [candidate(), created], run: { id: "r", status: "queued" }, cannotStart: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    await mount([], { engines: ["deepgram", "gemini"] });
    expect([...container!.querySelectorAll("button")].map((button) => button.textContent?.trim())).toEqual(["Deepgram で案を作る", "Gemini で案を作る"]);
    expect(container!.textContent).toContain("音声は Deepgram に送られます");
    expect(container!.textContent).toContain("音声は Google Gemini に送られます");
    await click("Gemini で案を作る");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statusText()).toContain("Gemini の案を作っています");
  });

  it("エンジンが 1 つだけなら「別の案を作る」（エンジンは送らない）", async () => {
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({});
      return json(202, { candidate: candidate({ id: SECOND, adopted: false }), candidates: [], run: { id: "r" }, cannotStart: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    await mount([], { engines: ["deepgram"] });
    expect(buttonByText("別の案を作る")).toBeTruthy();
    await click("別の案を作る");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("送信先が分からなければ案を開始しない", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await mount([], { defaultEngine: null });
    expect(buttonByText("別の案を作る")?.getAttribute("aria-disabled")).toBe("true");
    await click("別の案を作る");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(alertText()).toContain("送信先を確認できません");
  });

  it("始められなかったときは理由を出す（案は残る）", async () => {
    const created = candidate({ id: SECOND, adopted: false, state: "pending", segmentCount: 0 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(202, { candidate: created, candidates: [candidate(), created], run: null, cannotStart: "audio_not_ready" })),
    );
    await mount([]);
    await click("別の案を作る");
    expect(alertText()).toBe("音声の取り込みが終わっていません。");
  });

  it("案の一覧に状態を文で出し、できた案だけ見る・採用できる", async () => {
    await mount([candidate(), candidate({ id: SECOND, name: "開発の偽物", adopted: false, state: "pending", segmentCount: 0 })]);
    const rows = [...container!.querySelectorAll("[data-candidate]")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("できました");
    expect(rows[0]!.textContent).toContain("2 段落");
    expect(rows[0]!.textContent).toContain("採用中");
    expect(rows[1]!.textContent).toContain("作っています");
    // 採用中の案には「採用する」を出さない。作っている案には「見る」も出さない
    expect(rows[0]!.querySelector("button")!.textContent).toBe("見る");
    expect(rows[1]!.querySelector("button")).toBeNull();
  });

  it("「見る」で本文を読み、そこから採用できる", async () => {
    const other = candidate({ id: SECOND, name: "開発の偽物", adopted: false });
    const full = { ...other, segments: [{ start: 65, end: 70, text: "別のエンジンの段落", speaker: 1 }], speakerNames: { "1": "話し手" } };
    const fetchMock = vi.fn(async (path: string) =>
      path.endsWith("/adopt") ? json(200, { recording, speakers: [], candidates: [candidate({ adopted: false }), { ...other, adopted: true }] }) : json(200, { candidate: full }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSnapshot = vi.fn();
    await mount([candidate(), other], { onSnapshot });
    await click("見る");
    const preview = container!.querySelector(`[data-candidate-preview="${SECOND}"]`);
    expect(preview?.textContent).toContain("[01:05] 話し手: 別のエンジンの段落");

    await click("この案を採用する");
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(`/api/pages/${PAGE_ID}/recording/candidates/${SECOND}/adopt`);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot.mock.calls[0]![0].recording.revision).toBe(3);
    expect(statusText()).toContain("開発の偽物 を採用しました");
    // 採用したら本文の欄は閉じる（上の文字起こしが入れ替わる）
    expect(container!.querySelector("[data-candidate-preview]")).toBeNull();
  });

  it("できていない案を採用しようとしたら理由を出す", async () => {
    const other = candidate({ id: SECOND, adopted: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(409, { error: "not_ready" })),
    );
    await mount([candidate(), other]);
    await click("採用する");
    expect(alertText()).toBe("この案はまだできていません。できてから採用できます。");
  });

  it("要らない案は、1 回確かめてから消せる（採用中・作っている途中は出さない）", async () => {
    const other = candidate({ id: SECOND, name: "開発の偽物", adopted: false });
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      expect(path).toBe(`/api/pages/${PAGE_ID}/recording/candidates/${SECOND}`);
      expect(init?.method).toBe("DELETE");
      return json(200, { candidates: [candidate()] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    await mount([candidate(), other, candidate({ id: "33333333-3333-4333-8333-333333333333", adopted: false, state: "pending", segmentCount: 0 })], { onChanged });
    // 採用中の案と、作っている途中の案には「消す」を出さない
    const rows = [...container!.querySelectorAll("[data-candidate]")];
    const labels = (row: Element) => [...row.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(labels(rows[0]!)).toEqual(["見る"]);
    expect(labels(rows[1]!)).toEqual(["見る", "採用する", "消す"]);
    expect(labels(rows[2]!)).toEqual([]);

    await click("消す");
    expect(rows[1]!.textContent).toContain("この案を消しますか");
    // やめれば消さない
    await click("やめる");
    expect(fetchMock).not.toHaveBeenCalled();
    await click("消す");
    await act(async () => [...rows[1]!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "消す")!.click());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(statusText()).toContain("開発の偽物 を消しました");
  });

  it("採用中の案を消そうとしたら、server の理由を出す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(409, { error: "adopted" })),
    );
    await mount([candidate(), candidate({ id: SECOND, adopted: false })]);
    // 1 回目で確かめる欄が開き（行の「消す」は欄の「消す」に替わる）、2 回目で送る
    await click("消す");
    await click("消す");
    expect(alertText()).toBe("採用中の案は消せません。別の案を採用してから消してください。");
  });

  it("できなかった案は「もう一度」で作り直せる", async () => {
    const failed = candidate({ id: SECOND, name: "開発の偽物", adopted: false, state: "failed", segmentCount: 0, preview: [] });
    const fetchMock = vi.fn(async (path: string) => {
      expect(path).toBe(`/api/pages/${PAGE_ID}/recording/candidates/${SECOND}/transcribe`);
      return json(202, { run: { id: "r", status: "queued" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    await mount([candidate(), failed], { onChanged });
    expect(container!.querySelector(`[data-candidate="${SECOND}"]`)?.textContent).toContain("できませんでした");
    await click("もう一度");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(statusText()).toContain("開発の偽物 をもう一度作っています");
  });

  it("作っている途中の案があるあいだは録音を読み直し続け、できたら止める（「作っています」のまま残さない）", async () => {
    vi.useFakeTimers();
    try {
      const building = candidate({ id: SECOND, name: "開発の偽物", adopted: false, state: "pending", segmentCount: 0, preview: [] });
      const onChanged = vi.fn();
      await mount([candidate(), building], { onChanged });
      expect(onChanged).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTime(4000));
      expect(onChanged).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTime(8000));
      expect(onChanged).toHaveBeenCalledTimes(3);

      // できあがって一覧が変わったら、もう読み直さない
      await act(async () => {
        root!.render(
          <RecordingCandidates
            pageId={PAGE_ID}
            candidates={[candidate(), { ...building, state: "ready" }]}
            engines={[]}
            onSnapshot={() => undefined}
            onChanged={onChanged}
          />,
        );
      });
      await act(async () => vi.advanceTimersByTime(20000));
      expect(onChanged).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("作っている途中の案が無ければ、読み直さない", async () => {
    vi.useFakeTimers();
    try {
      const onChanged = vi.fn();
      await mount([candidate()], { onChanged });
      await act(async () => vi.advanceTimersByTime(30000));
      expect(onChanged).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
