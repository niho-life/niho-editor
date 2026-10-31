// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RecordingData } from "@niho/editor-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendTranscript } from "@/recording/append-transcript";
import { editSegments } from "@/recording/edit-segments";
import { listSpeakers, mergeSpeakers, renameSpeaker } from "@/recording/speakers";
import { readVtt } from "@/recording/vtt-import";
import { RecordingTranscript } from "./RecordingTranscript";

const PAGE_ID = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const CONFLICT_TEXT = "別の場所で先に直されました。最新に合わせました";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Patch = {
  baseRevision: number;
  edits?: { index: number; text: string }[];
  renameSpeaker?: { speaker: number; name: string | null };
  mergeSpeakers?: { from: number; into: number };
  appendVtt?: { name: string; vtt: string };
};

/** 本物の純粋な関数（edit-segments・speakers）で動く、revision つきの録音の API の代わり。 */
function createServer(initial?: Partial<RecordingData>) {
  const state = {
    revision: 1,
    durationSec: 125,
    data: {
      segments: [
        { start: 0, end: 4, text: "最初の段落です。", speaker: 1 },
        { start: 4, end: 9, text: "二つ目の段落です。", speaker: 2 },
        { start: 9, end: 12, text: "三つ目の段落です。", speaker: 1 },
        { start: 12, end: 15, text: "四つ目の段落です。", speaker: 3 },
      ],
      speakerNames: { "1": "Takuya", "2": "Mika" },
      ...initial,
    } as RecordingData,
    patches: [] as Patch[],
    gets: 0,
    status: 200,
    /** 値を入れると、次の PATCH はそれが呼ばれるまで返さない。 */
    hold: null as Promise<void> | null,
    /** 読み取り（GET）の応答にだけ付く欄（音声の列・案の一覧。変更の応答には入らない）と、録音の audio。 */
    getOnly: null as null | { audio: unknown; audios: unknown[]; candidates: unknown[] },
  };
  const snapshot = () => ({
    recording: {
      revision: state.revision,
      source: "vtt",
      language: "ja",
      engine: null,
      durationSec: state.durationSec,
      sourceName: "dinner.vtt",
      sourceSha256: null,
      segments: state.data.segments,
      speakerNames: state.data.speakerNames,
      audio: state.getOnly?.audio ?? null,
      createdAt: "2026-10-30T00:00:00.000Z",
      updatedAt: "2026-10-30T00:00:00.000Z",
    },
    speakers: listSpeakers(state.data),
  });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
    if (state.status !== 200) return json(state.status, { error: "x" });
    if (init?.method === "GET") {
      state.gets += 1;
      return json(200, state.getOnly ? { ...snapshot(), audios: state.getOnly.audios, candidates: state.getOnly.candidates } : snapshot());
    }
    const patch = JSON.parse(init!.body as string) as Patch;
    state.patches.push(patch);
    if (state.hold) await state.hold;
    if (patch.baseRevision !== state.revision) return json(409, { error: "conflict", ...snapshot() });
    const appended = patch.appendVtt ? readVtt(patch.appendVtt) : null;
    if (appended && !appended.ok) return json(400, { error: "bad_request", reason: appended.reason });
    const result = patch.edits
      ? editSegments(state.data, patch.edits)
      : patch.renameSpeaker
        ? renameSpeaker(state.data, patch.renameSpeaker.speaker, patch.renameSpeaker.name)
        : appended
          ? appendTranscript({ ...state.data, durationSec: state.durationSec }, appended.value)
          : mergeSpeakers(state.data, patch.mergeSpeakers!.from, patch.mergeSpeakers!.into);
    if ("rejected" in result) return json(400, { error: "bad_request", reason: result.rejected });
    state.data = { segments: result.segments, speakerNames: result.speakerNames };
    if (result.durationSec !== undefined && result.durationSec !== null) state.durationSec = result.durationSec;
    state.revision += 1;
    return json(200, snapshot());
  });
  /** 別の画面が先に直した（この画面は知らない）。 */
  const external = (mutate: (data: RecordingData) => RecordingData) => {
    state.data = mutate(state.data);
    state.revision += 1;
  };
  return { state, fetchMock, external };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error("condition not met");
}

async function mount(server = createServer()) {
  vi.stubGlobal("fetch", server.fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<RecordingTranscript pageId={PAGE_ID} />);
  });
  return server;
}

const paragraphs = () => [...container!.querySelectorAll<HTMLElement>(".es-seg p")];
const whoOf = () => [...container!.querySelectorAll(".es-who > span")].map((node) => node.textContent);
const status = () => container!.querySelector("[data-save-state]")!;
const chip = (name: string) => container!.querySelector<HTMLButtonElement>(`button[aria-label="${name} の名前を変える"]`)!;
const buttonByText = (text: string) => [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text)!;
const notice = () => container!.querySelector("[data-transcript-notice]")?.textContent ?? "";

function write(element: HTMLElement, text: string) {
  act(() => {
    element.textContent = text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const blur = (element: HTMLElement) => act(() => element.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const compose = (element: HTMLElement, type: "compositionstart" | "compositionend") => act(() => element.dispatchEvent(new Event(type, { bubbles: true })));
async function edit(index: number, text: string) {
  write(paragraphs()[index]!, text);
  blur(paragraphs()[index]!);
  await settle();
}
function setValue(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const submitName = async () => {
  await act(async () => container!.querySelector<HTMLFormElement>(".es-spkform")!.requestSubmit());
  await settle();
};

describe("RecordingTranscript: loading", () => {
  it("shows a loading state, then the transcript: paragraphs, speakers, length, timestamps, saved", async () => {
    const server = createServer();
    vi.stubGlobal("fetch", server.fetchMock);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<RecordingTranscript pageId={PAGE_ID} />);
    });
    await until(() => paragraphs().length === 4);
    expect(server.fetchMock).toHaveBeenCalledWith(`/api/pages/${PAGE_ID}/recording`, expect.objectContaining({ method: "GET" }));
    expect(paragraphs().map((node) => node.textContent)).toEqual(["最初の段落です。", "二つ目の段落です。", "三つ目の段落です。", "四つ目の段落です。"]);
    // 名前の無い話者は「話者N」。色は番号の順
    expect(whoOf()).toEqual(["Takuya", "Mika", "Takuya", "話者3"]);
    expect([...container!.querySelectorAll(".es-seg .es-tone")].map((node) => node.className.match(/es-tone--(\w)/)![1])).toEqual(["a", "b", "a", "c"]);
    expect([...container!.querySelectorAll(".es-who time")].map((node) => node.textContent)).toEqual(["00:00", "00:04", "00:09", "00:12"]);
    expect(container!.querySelector(".es-time")?.textContent).toBe("長さ 02:05");
    expect(status().textContent).toBe("保存済み");
    // 再生は無い
    expect(container!.querySelector('[aria-label="再生"]')).toBeNull();
    expect(container!.querySelector(".es-wave")).toBeNull();
    // 手順の入口（この録音から）は出さない
    expect(container!.textContent).not.toContain("この録音から");
  });

  it("says so when the page has no transcript (404)", async () => {
    const server = createServer();
    server.state.status = 404;
    await mount(server);
    await until(() => container!.querySelector("[data-transcript=missing]") !== null);
    expect(container!.textContent).toContain("このページには文字起こしがありません。");
  });

  it("shows a failure in Japanese and loads again on request", async () => {
    const server = createServer();
    server.state.status = 503;
    await mount(server);
    await until(() => container!.querySelector("[data-transcript=failed]") !== null);
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain("サーバーが使えません");
    server.state.status = 200;
    await act(async () => buttonByText("もう一度読み込む").click());
    await until(() => paragraphs().length === 4);
    expect(server.state.gets).toBe(1);
  });
});

describe("RecordingTranscript: editing paragraphs", () => {
  it("saves a fixed paragraph on blur with the loaded revision, and the next one with the revision it got back", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    await edit(1, "二つ目の段落を直しました。");
    expect(server.state.patches).toEqual([{ baseRevision: 1, edits: [{ index: 1, text: "二つ目の段落を直しました。" }] }]);
    expect(status().textContent).toBe("保存済み");
    expect(server.state.data.segments[1]!.text).toBe("二つ目の段落を直しました。");
    await edit(3, "四つ目も直しました。");
    expect(server.state.patches[1]).toEqual({ baseRevision: 2, edits: [{ index: 3, text: "四つ目も直しました。" }] });
    expect(paragraphs()[1]!.textContent).toBe("二つ目の段落を直しました。");
    expect(paragraphs()[3]!.textContent).toBe("四つ目も直しました。");
  });

  it("does not send when nothing changed", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    blur(paragraphs()[0]!);
    write(paragraphs()[0]!, "別の文章");
    write(paragraphs()[0]!, "最初の段落です。");
    blur(paragraphs()[0]!);
    await settle();
    expect(server.state.patches).toEqual([]);
  });

  it("sends the same operations one at a time: the second waits for the first and uses its revision", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    let release!: () => void;
    server.state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    write(paragraphs()[0]!, "一回目");
    blur(paragraphs()[0]!);
    await settle();
    write(paragraphs()[2]!, "二回目");
    blur(paragraphs()[2]!);
    await settle();
    expect(status().textContent).toBe("保存中");
    // 一回目がまだ返っていない間は、二回目を送らない
    expect(server.state.patches).toHaveLength(1);
    server.state.hold = null;
    release();
    await until(() => server.state.patches.length === 2);
    await until(() => status().textContent === "保存済み");
    expect(server.state.patches[1]).toEqual({ baseRevision: 2, edits: [{ index: 2, text: "二回目" }] });
    expect(server.state.data.segments.map((segment) => segment.text)).toEqual(["一回目", "二つ目の段落です。", "二回目", "四つ目の段落です。"]);
  });

  it("does not confirm while composing (IME): it sends after the composition ends", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    const first = paragraphs()[0]!;
    compose(first, "compositionstart");
    write(first, "にゅうりょくちゅう");
    blur(first);
    await settle();
    expect(server.state.patches).toEqual([]);
    compose(first, "compositionend");
    await settle();
    expect(server.state.patches).toEqual([{ baseRevision: 1, edits: [{ index: 0, text: "にゅうりょくちゅう" }] }]);
  });
});

describe("RecordingTranscript: someone fixed it elsewhere first (409)", () => {
  it("keeps what I wrote, takes the latest for the rest, says so, and sends again on request", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    // 別の画面が、3 つ目の段落を直し、話者の名前も変えた
    server.external((data) => ({
      segments: data.segments.map((segment, index) => (index === 2 ? { ...segment, text: "別の画面で直した三つ目。" } : segment)),
      speakerNames: { ...data.speakerNames, "2": "Mika Sato" },
    }));
    await edit(1, "私が直した二つ目。");
    // 自分の文章は消えない。ほかの段落と話者の名前は最新になる
    expect(paragraphs()[1]!.textContent).toBe("私が直した二つ目。");
    expect(paragraphs()[2]!.textContent).toBe("別の画面で直した三つ目。");
    expect(whoOf()[1]).toBe("Mika Sato");
    expect(notice()).toContain(CONFLICT_TEXT);
    expect(status().textContent).toContain("保存されていない段落が 1 つあります");
    // サーバーには書かれていない。自動では送り直さない
    expect(server.state.data.segments[1]!.text).toBe("二つ目の段落です。");
    expect(server.state.patches).toHaveLength(1);

    await act(async () => buttonByText("もう一度保存").click());
    await settle();
    expect(server.state.patches[1]).toEqual({ baseRevision: 2, edits: [{ index: 1, text: "私が直した二つ目。" }] });
    expect(server.state.data.segments[1]!.text).toBe("私が直した二つ目。");
    expect(status().textContent).toBe("保存済み");
    expect(notice()).toBe("");
    expect(paragraphs()[1]!.textContent).toBe("私が直した二つ目。");
  });

  it("confirming another paragraph does not send the held one; confirming the same one again does", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    server.external((data) => ({ segments: data.segments, speakerNames: { ...data.speakerNames, "1": "T" } }));
    await edit(0, "止められた文章");
    expect(server.state.patches).toHaveLength(1);
    await edit(3, "別の段落");
    expect(server.state.patches[1]).toEqual({ baseRevision: 2, edits: [{ index: 3, text: "別の段落" }] });
    expect(server.state.data.segments[0]!.text).toBe("最初の段落です。");
    expect(status().textContent).toContain("保存されていない段落が 1 つあります");
    // 書き直して確定すると送る
    await edit(0, "止められた文章を書き直した");
    expect(server.state.patches[2]).toEqual({ baseRevision: 3, edits: [{ index: 0, text: "止められた文章を書き直した" }] });
    expect(status().textContent).toBe("保存済み");
  });

  it("holds every draft on a conflict, including paragraphs fixed while the save was in flight: none is laid over the latest without asking", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    let release!: () => void;
    server.state.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 別の画面が 2 つ目の段落を直した（この画面は知らない）。1 つ目を送ると競合になる
    server.external((data) => ({
      segments: data.segments.map((segment, index) => (index === 1 ? { ...segment, text: "別の画面で直した二つ目。" } : segment)),
      speakerNames: data.speakerNames,
    }));
    await edit(0, "私の一つ目");
    expect(server.state.patches).toHaveLength(1);
    // 送っている間に、別の段落（別の画面が直したもの）と、送っている段落をもう一度直す。どちらも順番を待つ
    await edit(1, "私の二つ目");
    await edit(0, "私の一つ目（書き直し）");
    server.state.hold = null;
    release();
    await until(() => status().textContent?.includes("保存されていない段落") ?? false);
    await settle(20);
    // 待っていた送信は出ない（別の画面の二つ目を、確かめないまま上書きしない）
    expect(server.state.patches).toHaveLength(1);
    expect(server.state.data.segments[1]!.text).toBe("別の画面で直した二つ目。");
    expect(status().textContent).toContain("保存されていない段落が 2 つあります");
    expect(paragraphs()[0]!.textContent).toBe("私の一つ目（書き直し）");
    expect(paragraphs()[1]!.textContent).toBe("私の二つ目");
    // 確かめて「もう一度保存」を押すと、2 つとも最新の版の上に送る
    await act(async () => buttonByText("もう一度保存").click());
    await settle();
    expect(server.state.patches[1]).toEqual({
      baseRevision: 2,
      edits: [
        { index: 0, text: "私の一つ目（書き直し）" },
        { index: 1, text: "私の二つ目" },
      ],
    });
    expect(status().textContent).toBe("保存済み");
  });

  it("keeps the text and offers to try again when the save fails (not a conflict)", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    server.state.status = 503;
    await edit(0, "失敗する文章");
    expect(paragraphs()[0]!.textContent).toBe("失敗する文章");
    expect(notice()).toContain("サーバーが使えません");
    expect(status().textContent).toContain("保存されていない段落が 1 つあります");
    server.state.status = 200;
    await act(async () => buttonByText("もう一度保存").click());
    await settle();
    expect(server.state.data.segments[0]!.text).toBe("失敗する文章");
    expect(status().textContent).toBe("保存済み");
  });

  it("explains a rejected paragraph (too long) and keeps it", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    await edit(0, "あ".repeat(5001));
    expect(notice()).toContain("5,000 字");
    expect(paragraphs()[0]!.textContent).toHaveLength(5001);
    expect(server.state.data.segments[0]!.text).toBe("最初の段落です。");
  });
});

describe("RecordingTranscript: leaving with unsaved writing", () => {
  const unload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it("counts a paragraph I am still typing in (not confirmed yet): it says so and closing the tab asks first", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    expect(status().textContent).toBe("保存済み");
    expect(unload()).toBe(false);

    write(paragraphs()[1]!, "書いている途中");
    expect(server.state.patches).toHaveLength(0);
    expect(status().textContent).toBe("保存待ち");
    expect(unload()).toBe(true);

    // 確定すると下書きになり、送られて、保存済みに戻る
    blur(paragraphs()[1]!);
    await until(() => status().textContent === "保存済み");
    expect(server.state.patches).toHaveLength(1);
    expect(unload()).toBe(false);
  });

  it("does not ask after typing is undone before it is confirmed", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    write(paragraphs()[0]!, "変えた");
    write(paragraphs()[0]!, "最初の段落です。");
    expect(unload()).toBe(true);
    blur(paragraphs()[0]!);
    await settle();
    expect(server.state.patches).toHaveLength(0);
    expect(status().textContent).toBe("保存済み");
    expect(unload()).toBe(false);
  });

  it("keeps asking while composing (IME) with focus gone, until the composition ends", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    compose(paragraphs()[2]!, "compositionstart");
    write(paragraphs()[2]!, "へんかんちゅう");
    blur(paragraphs()[2]!);
    expect(unload()).toBe(true);
    expect(server.state.patches).toHaveLength(0);
    compose(paragraphs()[2]!, "compositionend");
    await until(() => status().textContent === "保存済み");
    expect(server.state.patches).toHaveLength(1);
    expect(unload()).toBe(false);
  });
});

describe("RecordingTranscript: speakers", () => {
  it("変更の応答には音声の列と案の一覧が入らないので、直したあとも直前のものを残す（空に戻さない）", async () => {
    const server = createServer();
    server.state.getOnly = {
      audio: { status: "uploaded", bytes: 64, contentType: "audio/mp4", expiresAt: "2030-02-01T00:00:00.000Z" },
      audios: [{ index: 0, status: "uploaded", durationSec: 125, offsetSec: 0, sourceName: "dinner.m4a", expiresAt: "2030-02-01T00:00:00.000Z" }],
      candidates: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Deepgram",
          engine: "deepgram",
          engineLabel: "Deepgram",
          language: "ja",
          durationSec: 125,
          adopted: true,
          state: "ready",
          segmentCount: 4,
          preview: [],
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
        },
      ],
    };
    await mount(server);
    await until(() => paragraphs().length === 4);
    expect(container!.querySelector('[data-recording-candidates="1"]')).not.toBeNull();
    const audiosBefore = container!.querySelector("[data-recording-audios]")?.outerHTML ?? "";

    await edit(1, "二つ目の段落を直しました。");
    expect(server.state.patches).toHaveLength(1);
    // 直したあとも、案の一覧（1 件）と音声の列がそのまま出ている
    expect(container!.querySelector('[data-recording-candidates="1"]')).not.toBeNull();
    expect(container!.querySelector("[data-recording-audios]")?.outerHTML ?? "").toBe(audiosBefore);
    // 話者の名前を変えたあとも同じ
    act(() => chip("話者3").click());
    setValue(container!.querySelector<HTMLInputElement>(".es-spkform input")!, "Haruka");
    await submitName();
    expect(container!.querySelector('[data-recording-candidates="1"]')).not.toBeNull();
  });

  it("renames a speaker; every paragraph shows the new name", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    act(() => chip("話者3").click());
    setValue(container!.querySelector<HTMLInputElement>(".es-spkform input")!, "Haruka");
    await submitName();
    expect(server.state.patches).toEqual([{ baseRevision: 1, renameSpeaker: { speaker: 3, name: "Haruka" } }]);
    expect(whoOf()).toEqual(["Takuya", "Mika", "Takuya", "Haruka"]);
    expect(container!.querySelector(".es-spkform")).toBeNull();
    // 名前を外すと「話者N」に戻る
    act(() => chip("Haruka").click());
    setValue(container!.querySelector<HTMLInputElement>(".es-spkform input")!, "");
    await submitName();
    expect(server.state.patches[1]).toEqual({ baseRevision: 2, renameSpeaker: { speaker: 3, name: null } });
    expect(whoOf()[3]).toBe("話者3");
  });

  it("shows why a name cannot be used and keeps the form open with what was typed", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    act(() => chip("Mika").click());
    setValue(container!.querySelector<HTMLInputElement>(".es-spkform input")!, "話者5");
    await submitName();
    expect(container!.querySelector(".es-spkform")).not.toBeNull();
    expect(container!.querySelector(".es-spkform [role=alert]")?.textContent).toContain("「話者1」の形");
    expect(container!.querySelector<HTMLInputElement>(".es-spkform input")!.value).toBe("話者5");
    expect(server.state.data.speakerNames["2"]).toBe("Mika");
  });

  it("on a conflict while renaming, takes the latest, tells me, and lets me decide again", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    server.external((data) => ({
      segments: data.segments.map((segment, index) => (index === 0 ? { ...segment, text: "別の画面の一つ目" } : segment)),
      speakerNames: data.speakerNames,
    }));
    act(() => chip("Mika").click());
    setValue(container!.querySelector<HTMLInputElement>(".es-spkform input")!, "Mika Sato");
    await submitName();
    expect(container!.querySelector(".es-spkform [role=alert]")?.textContent).toContain(CONFLICT_TEXT);
    expect(paragraphs()[0]!.textContent).toBe("別の画面の一つ目");
    expect(container!.querySelector<HTMLInputElement>(".es-spkform input")!.value).toBe("Mika Sato");
    await submitName();
    expect(server.state.patches[1]).toEqual({ baseRevision: 2, renameSpeaker: { speaker: 2, name: "Mika Sato" } });
    expect(whoOf()[1]).toBe("Mika Sato");
  });

  it("merges one speaker into another after one confirmation: their paragraphs move and the speaker disappears", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    act(() => chip("話者3").click());
    const select = container!.querySelector<HTMLSelectElement>('select[aria-label="まとめる先の話者"]')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(["Takuya", "Mika"]);
    act(() => buttonByText("まとめる").click());
    expect(server.state.patches).toEqual([]);
    expect(container!.querySelector(".es-spkform-merge")?.textContent).toContain("「話者3」の段落をすべて「Takuya」にまとめます。元には戻せません。");
    await act(async () => buttonByText("まとめる").click());
    await settle();
    expect(server.state.patches).toEqual([{ baseRevision: 1, mergeSpeakers: { from: 3, into: 1 } }]);
    expect(whoOf()).toEqual(["Takuya", "Mika", "Takuya", "Takuya"]);
    expect(chip("話者3")).toBeNull();
    expect(container!.querySelector(".es-spkform")).toBeNull();
    // まとめたあとの段落の色は、まとめ先の話者の色
    expect([...container!.querySelectorAll(".es-seg .es-tone")].map((node) => node.className.match(/es-tone--(\w)/)![1])).toEqual(["a", "b", "a", "a"]);
  });
});

describe("RecordingTranscript: timestamps", () => {
  it("hides and shows the times, and remembers the choice on this device", async () => {
    await mount();
    await until(() => paragraphs().length === 4);
    expect(container!.querySelectorAll(".es-who time")).toHaveLength(4);
    const toggle = buttonByText("タイムスタンプ");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    act(() => toggle.click());
    expect(container!.querySelectorAll(".es-who time")).toHaveLength(0);
    expect(buttonByText("タイムスタンプ").getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem("editor:transcript-timestamps")).toBe("off");
    // 開き直しても隠れたまま
    await act(async () => root!.unmount());
    container!.remove();
    await mount();
    await until(() => paragraphs().length === 4);
    expect(container!.querySelectorAll(".es-who time")).toHaveLength(0);
    act(() => buttonByText("タイムスタンプ").click());
    expect(container!.querySelectorAll(".es-who time")).toHaveLength(4);
    expect(window.localStorage.getItem("editor:transcript-timestamps")).toBe("on");
  });

  it("works when the device blocks storage", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    await mount();
    await until(() => paragraphs().length === 4);
    expect(container!.querySelectorAll(".es-who time")).toHaveLength(4);
    act(() => buttonByText("タイムスタンプ").click());
    expect(container!.querySelectorAll(".es-who time")).toHaveLength(0);
  });
});

describe("RecordingTranscript（あとの .vtt を足す）", () => {
  const VTT = (text: string) => ["WEBVTT", "", "00:00:00.000 --> 00:00:03.000", `<v Takuya>${text}`, "", ""].join("\n");
  const appendInput = () => container!.querySelector<HTMLInputElement>('[data-recording-append] input[type="file"]')!;
  const appendError = () => container!.querySelector('[data-recording-append-error=""]')?.textContent ?? "";

  async function pick(files: File[]) {
    const input = appendInput();
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("複数の .vtt を選んだ順に足し、前の音声の長さだけ時刻をずらしてつなぐ", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    expect(appendInput().multiple).toBe(true);

    await pick([new File([VTT("続きです")], "2.vtt", { type: "text/vtt" }), new File([VTT("もっと続きます")], "3.vtt", { type: "text/vtt" })]);
    await until(() => paragraphs().length === 6);
    expect(server.state.patches.map((patch) => [patch.baseRevision, patch.appendVtt?.name])).toEqual([
      [1, "2.vtt"],
      [2, "3.vtt"],
    ]);
    // 1 本目の録音は 125 秒。2 本目は 125 秒から、3 本目は 128 秒から
    expect(server.state.data.segments.slice(4).map((segment) => [segment.start, segment.end, segment.text])).toEqual([
      [125, 128, "続きです"],
      [128, 131, "もっと続きます"],
    ]);
    // 同じ名前の話者（Takuya）は 1 本目と同じ番号のまま
    expect(server.state.data.segments.slice(4).map((segment) => segment.speaker)).toEqual([1, 1]);
    expect(server.state.durationSec).toBe(131);
    expect(container!.textContent).toContain("2 件の文字起こしを足しました");
    expect(appendError()).toBe("");
  });

  it("途中で失敗したら、そこで止めて何件足せたかを知らせる", async () => {
    const server = await mount();
    await until(() => paragraphs().length === 4);
    await pick([new File([VTT("続きです")], "2.vtt", { type: "text/vtt" }), new File(["これは字幕ではありません"], "3.vtt", { type: "text/vtt" })]);
    await until(() => appendError() !== "");
    expect(appendError()).toContain("1 件足しました");
    expect(appendError()).toContain("3.vttは足せませんでした");
    expect(server.state.data.segments).toHaveLength(5);
  });

  it("音声ファイルは足せないと言う（足せるのは .vtt）", async () => {
    await mount();
    await until(() => paragraphs().length === 4);
    await pick([new File([new Uint8Array([1])], "音声.m4a", { type: "audio/mp4" })]);
    await until(() => appendError() !== "");
    expect(appendError()).toBe("足せるのは文字起こし済みの .vtt ファイルです。");
  });
});
