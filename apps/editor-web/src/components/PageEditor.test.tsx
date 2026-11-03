// @vitest-environment jsdom
import { createRequire } from "node:module";
import type { Editor } from "@tiptap/core";
import { IDBFactory } from "fake-indexeddb";
import { act, StrictMode, version as reactVersion } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NEW_PAGE_DRAFT_KEY, createIndexedDbDraftStorage, type DraftStorage, type PageDraft } from "@/lib/drafts";
import { MAX_TITLE_CHARS } from "@/lib/page-limits";
import { PageEditor, type EditablePage, type PageEditorEvents } from "./PageEditor";

const appRequire = createRequire(import.meta.url);

/** niho-docs-ui の中から見たときの解決先（install-links で複製した node_modules/niho-docs-ui から）。 */
function resolveFromDocsUi(specifier: string): string {
  return createRequire(appRequire.resolve("niho-docs-ui/package.json")).resolve(specifier);
}

beforeAll(() => {
  // jsdom に無い描画の API（ProseMirror・浮かぶメニューの位置の計算が読む）
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Element.prototype.scrollIntoView = () => undefined;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (navigator as { onLine?: boolean }).onLine;
  delete (navigator as { clipboard?: unknown }).clipboard;
});

const PAGE_ID = "00000000-0000-4000-8000-000000000001";
const UPDATED_AT = "2026-10-31T03:40:00.000Z";
const paragraph = (text: string) => [{ type: "paragraph", content: [{ type: "text", text }] }];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** 端末のローカル時刻の HH:mm（帯の文言の期待値）。 */
function clock(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function conflictBody(page: { title: string; blocks: unknown[]; revision: number; updatedAt: string }) {
  return { error: "conflict", page: { id: PAGE_ID, ...page } };
}

/** 題名の欄に打つ（React の onChange を通す）。 */
function typeTitle(value: string) {
  const title = container!.querySelector<HTMLTextAreaElement>("textarea.page-title")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(title, value);
  title.dispatchEvent(new Event("input", { bubbles: true }));
}

function bodyEditor(): Editor {
  return (container!.querySelector(".ProseMirror") as HTMLElement & { editor: Editor }).editor;
}

/** 本文の上の保存状態の表示（見える文字だけ。読み上げはヘッダーの状態の丸が持つ）。 */
const status = () => container!.querySelector("[data-save-state]");
const alertBand = () => container!.querySelector('[data-conflict-band] [role="alert"]');
const button = (label: string) => [...container!.querySelectorAll("button")].find((element) => element.textContent === label)!;

/** fake-indexeddb（setImmediate で進む）の処理を進める。 */
async function settleIdb() {
  await act(async () => {
    for (let index = 0; index < 10; index++) await new Promise<void>((resolve) => setImmediate(resolve));
  });
}

async function renderEditor(page: Partial<EditablePage> & { revision: number }, options: { drafts?: DraftStorage | null; events?: PageEditorEvents } = {}) {
  // 自動保存・下書きの時計だけを差し替える（開いたときに下書きを載せると、その時点で自動保存の時計が動く）
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const full: EditablePage = { id: PAGE_ID, title: "合成の題名", blocks: [], updatedAt: UPDATED_AT, ...page };
  await act(async () => {
    root!.render(<PageEditor page={full} drafts={options.drafts === undefined ? null : options.drafts} {...options.events} />);
  });
  // 端末の下書きを読み終えて書けるようになるまで待つ
  for (let index = 0; index < 100; index++) {
    if (container.querySelector(".ProseMirror")?.getAttribute("contenteditable") === "true") break;
    await settleIdb();
  }
  expect(container.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("true");
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function waitForAutosave() {
  await advance(1000);
}

/** 保存の要求を受けて revision を 1 つ進める fetch。 */
function acceptingFetch() {
  const bodies: Array<Record<string, unknown>> = [];
  const inits: RequestInit[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(`/api/pages/${PAGE_ID}`);
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    inits.push(init);
    return json(200, { page: { id: PAGE_ID, revision: (body.baseRevision as number) + 1 } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, bodies, inits };
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
}

describe("niho-docs-ui on React 19", () => {
  it("resolves react, react-dom and TipTap from niho-docs-ui to this app's single copy", () => {
    expect(reactVersion.startsWith("19.")).toBe(true);
    for (const specifier of ["react", "react-dom", "react/jsx-runtime", "@tiptap/react", "@tiptap/core", "@tiptap/pm/state", "@niho/docs-core", "niho-ui/cn"]) {
      expect(resolveFromDocsUi(specifier), specifier).toBe(appRequire.resolve(specifier));
    }
    expect(createRequire(resolveFromDocsUi("react"))("./package.json").version).toBe(reactVersion);
  });

  it("renders the page editor with the stored blocks and no invalid hook call", async () => {
    const errors = vi.spyOn(console, "error");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const blocks = [{ type: "paragraph", content: [{ type: "text", text: "合成の本文" }] }];
    await act(async () => {
      root!.render(<PageEditor page={{ id: PAGE_ID, title: "合成の題名", blocks, revision: 1, updatedAt: UPDATED_AT }} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const messages = errors.mock.calls.map((call) => call.map(String).join(" "));
    expect(messages.filter((message) => /Invalid hook call|more than one copy of React|older version of React/i.test(message))).toEqual([]);
    expect(container.querySelector(".be")).not.toBeNull();
    const body = container.querySelector(".ProseMirror");
    expect(body?.getAttribute("contenteditable")).toBe("true");
    expect(body?.getAttribute("role")).toBe("textbox");
    expect(body?.getAttribute("aria-multiline")).toBe("true");
    expect(body?.textContent).toContain("合成の本文");
    expect(container.querySelector<HTMLTextAreaElement>("textarea.page-title")?.value).toBe("合成の題名");
    expect(status()?.textContent).toBe("保存済み");
    // 読み上げはヘッダーの状態の丸（aria-live）に任せる。ここを live region にすると同じ言葉を二重に読み上げる
    expect(status()?.getAttribute("role")).toBeNull();
    expect(status()?.getAttribute("aria-live")).toBeNull();
    // jsdom には IndexedDB が無い: 端末への保持なしとして続ける
    expect(status()?.getAttribute("data-drafts")).toBe("none");
  });

  it("caps the title at the server limit so an over-long title never enters autosave", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<PageEditor page={{ id: PAGE_ID, title: "合成の題名", blocks: [], revision: 1, updatedAt: UPDATED_AT }} />);
    });
    const title = container.querySelector<HTMLTextAreaElement>("textarea.page-title")!;
    const set = (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(title, value);
      title.dispatchEvent(new Event("input", { bubbles: true }));
    };

    await act(async () => set("あ".repeat(MAX_TITLE_CHARS + 1)));
    expect(Array.from(title.value)).toHaveLength(MAX_TITLE_CHARS);
    expect(container.textContent).toContain(`題名は ${MAX_TITLE_CHARS} 字までです。`);

    await act(async () => set("あ".repeat(MAX_TITLE_CHARS - 1)));
    expect(Array.from(title.value)).toHaveLength(MAX_TITLE_CHARS - 1);
    expect(container.textContent).not.toContain("字までです");
  });
});

describe("PageEditor autosave", () => {
  it("sends every autosave with the page's revision as baseRevision and advances it from each response", async () => {
    const { bodies } = acceptingFetch();
    await renderEditor({ revision: 5 });
    await act(async () => typeTitle("一"));
    await waitForAutosave();
    await act(async () => typeTitle("一二"));
    await waitForAutosave();
    expect(bodies).toEqual([
      { title: "一", baseRevision: 5 },
      { title: "一二", baseRevision: 6 },
    ]);
    expect(status()?.textContent).toBe("保存済み");
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not turn the body into JSON on every input (only when it saves)", async () => {
    acceptingFetch();
    const longText = "あ".repeat(10_000);
    await renderEditor({ revision: 1, blocks: paragraph(longText) });
    const editor = bodyEditor();
    const getJSON = vi.spyOn(editor, "getJSON");
    for (const char of "続けて入力する文字") {
      await act(async () => {
        editor.commands.insertContent(char);
      });
    }
    expect(getJSON).not.toHaveBeenCalled();
    await waitForAutosave();
    expect(getJSON).toHaveBeenCalledTimes(1);
  });

  it("saves at once on ⌘S and Ctrl+S, instead of the browser's save dialog", async () => {
    const { bodies } = acceptingFetch();
    await renderEditor({ revision: 1 });
    await act(async () => typeTitle("今すぐ"));
    const meta = new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(meta);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(meta.defaultPrevented).toBe(true);
    expect(bodies).toEqual([{ title: "今すぐ", baseRevision: 1 }]);

    await act(async () => typeTitle("今すぐ2"));
    const ctrl = new KeyboardEvent("keydown", { key: "S", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      container!.querySelector("textarea")!.dispatchEvent(ctrl);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(ctrl.defaultPrevented).toBe(true);
    expect(bodies.at(-1)).toEqual({ title: "今すぐ2", baseRevision: 2 });
    expect(status()?.textContent).toBe("保存済み");
  });

  it("hands the frame a save-now that sends what is pending and resolves after it reached the server (#39), and takes it back on unmount", async () => {
    const { bodies } = acceptingFetch();
    const unregister = vi.fn();
    let saveNow: (() => Promise<boolean>) | null = null;
    await renderEditor({ revision: 1 }, { events: { registerSaveNow: (fn) => ((saveNow = fn), unregister) } });
    expect(saveNow).not.toBeNull();
    await act(async () => typeTitle("公開の直前"));
    let saved: boolean | null = null;
    await act(async () => {
      saved = await saveNow!();
    });
    expect(saved).toBe(true);
    expect(bodies).toEqual([{ title: "公開の直前", baseRevision: 1 }]);
    await act(async () => root!.unmount());
    root = null;
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("shows offline when the network fails, keeps retrying, and saves when the browser comes back online", async () => {
    const { fetchMock, bodies } = acceptingFetch();
    const accept = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    setOnline(false);
    await renderEditor({ revision: 2 });
    await act(async () => typeTitle("圏外で書いた"));
    await waitForAutosave();
    expect(status()?.textContent).toBe("オフライン・この端末に保持");
    expect(status()?.getAttribute("data-save-state")).toBe("offline");
    await advance(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockImplementation(accept);
    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(bodies).toEqual([{ title: "圏外で書いた", baseRevision: 2 }]);
    expect(status()?.textContent).toBe("保存済み");
  });

  it("says the save failed and retries a server error after five seconds", async () => {
    const { fetchMock, bodies } = acceptingFetch();
    const accept = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementationOnce(async () => json(503, { error: "unavailable" }));
    await renderEditor({ revision: 2 });
    await act(async () => typeTitle("a"));
    await waitForAutosave();
    expect(status()?.textContent).toBe("保存に失敗しました。もう一度試します");
    fetchMock.mockImplementation(accept);
    await advance(4999);
    expect(bodies).toEqual([]);
    await advance(1);
    expect(bodies).toEqual([{ title: "a", baseRevision: 2 }]);
    expect(status()?.textContent).toBe("保存済み");
  });

  it("says the sign-in expired on a 401 and does not resend by itself", async () => {
    const fetchMock = vi.fn(async () => json(401, { error: "unauthorized" }));
    vi.stubGlobal("fetch", fetchMock);
    await renderEditor({ revision: 2 });
    await act(async () => typeTitle("ログイン切れ"));
    await waitForAutosave();
    expect(status()?.textContent).toBe("ログインが切れました。本文はこの端末に残しています");
    expect(status()?.getAttribute("data-save-state")).toBe("signedOut");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tries a keepalive save at once when the page is hidden", async () => {
    const { bodies, inits } = acceptingFetch();
    await renderEditor({ revision: 4 });
    await act(async () => typeTitle("閉じる直前"));
    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(bodies).toEqual([{ title: "閉じる直前", baseRevision: 4 }]);
    expect(inits[0]?.keepalive).toBe(true);
  });
});

describe("PageEditor conflict band", () => {
  const LATEST = { title: "別の画面", blocks: paragraph("別の画面の本文"), revision: 9, updatedAt: "2026-10-31T03:40:00.000Z" };

  /** 1 回目の保存を 409 にして帯を出す。以後の応答は `next`。 */
  async function renderConflicted(next: (body: Record<string, unknown>) => Response) {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      return bodies.length === 1 ? json(409, conflictBody(LATEST)) : next(body);
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderEditor({ revision: 3, blocks: paragraph("この画面の本文") });
    await act(async () => typeTitle("この画面"));
    await waitForAutosave();
    return { fetchMock, bodies };
  }

  it("stops autosave on a 409, shows when the other screen saved, and keeps the text editable", async () => {
    const { fetchMock } = await renderConflicted(() => json(500, {}));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(alertBand()?.querySelector("p")?.textContent).toBe(`${clock(LATEST.updatedAt)} に別の画面で保存されました`);
    expect(status()?.textContent).toBe("保存を止めています");
    expect(status()?.getAttribute("data-save-state")).toBe("conflict");
    for (const label of ["最新版を見る", "本文をコピー", "この内容で上書き"]) expect(button(label).getAttribute("type")).toBe("button");

    await act(async () => typeTitle("この画面の続き"));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true }));
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container!.querySelector<HTMLTextAreaElement>("textarea.page-title")?.value).toBe("この画面の続き");
    expect(container!.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("true");
  });

  it("shows the latest version read-only without changing this screen's text", async () => {
    await renderConflicted(() => json(500, {}));
    await act(async () => button("最新版を見る").click());
    const dialog = container!.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // ダイアログは data-docs-app-root の中に置く（スタイルの規約）
    expect(dialog!.closest("[data-docs-app-root]")).not.toBeNull();
    expect(dialog!.textContent).toContain("別の画面");
    const latestBody = dialog!.querySelector(".ProseMirror");
    expect(latestBody?.textContent).toBe("別の画面の本文");
    expect(latestBody?.getAttribute("contenteditable")).toBe("false");
    // 自分の本文・題名はそのまま
    expect(bodyEditor().getText()).toBe("この画面の本文");
    expect(container!.querySelector<HTMLTextAreaElement>("textarea.page-title")?.value).toBe("この画面");

    await act(async () => button("閉じる").click());
    expect(container!.querySelector('[role="dialog"]')).toBeNull();
    expect(bodyEditor().getText()).toBe("この画面の本文");
  });

  it("copies this screen's title and body as plain text, and says whether it worked", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await renderConflicted(() => json(500, {}));
    await act(async () => button("本文をコピー").click());
    expect(writeText).toHaveBeenCalledWith("この画面\n\nこの画面の本文");
    expect(container!.querySelector("[data-copy-result]")?.textContent).toBe("本文をコピーしました");
    expect(container!.querySelector("[data-copy-result]")?.getAttribute("aria-live")).toBe("polite");

    writeText.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await act(async () => button("本文をコピー").click());
    expect(container!.querySelector("[data-copy-result]")?.textContent).toBe("コピーできませんでした");
  });

  it("overwrites with this screen's title and body on the latest revision, then autosaves normally", async () => {
    const { bodies } = await renderConflicted((body) => json(200, { page: { id: PAGE_ID, revision: (body.baseRevision as number) + 1 } }));
    await act(async () => {
      button("この内容で上書き").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(bodies[1]).toEqual({ title: "この画面", blocks: paragraph("この画面の本文"), baseRevision: 9, overwrite: true });
    expect(container!.querySelector("[data-conflict-band]")).toBeNull();
    expect(status()?.textContent).toBe("保存済み");

    await act(async () => typeTitle("上書きのあと"));
    await waitForAutosave();
    expect(bodies[2]).toEqual({ title: "上書きのあと", baseRevision: 10 });
  });

  it("keeps the band with the newest page when another save beat the overwrite", async () => {
    const NEWER = { ...LATEST, title: "さらに別の画面", revision: 12, updatedAt: "2026-10-31T05:07:00.000Z" };
    const { bodies } = await renderConflicted((body) =>
      body.baseRevision === 9 ? json(409, conflictBody(NEWER)) : json(200, { page: { id: PAGE_ID, revision: (body.baseRevision as number) + 1 } }),
    );
    await act(async () => {
      button("この内容で上書き").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(alertBand()?.querySelector("p")?.textContent).toBe(`${clock(NEWER.updatedAt)} に別の画面で保存されました`);
    expect(status()?.textContent).toBe("保存を止めています");
    await act(async () => {
      button("この内容で上書き").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(bodies.at(-1)).toMatchObject({ title: "この画面", baseRevision: 12, overwrite: true });
    expect(container!.querySelector("[data-conflict-band]")).toBeNull();
  });

  it("treats a 409 that holds exactly what it is sending as saved (its own earlier save)", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (calls === 1) throw new TypeError("network connection was lost");
      // 1 回目は届いていた（revision 3 → 4）
      return json(409, conflictBody({ title: body.title as string, blocks: [], revision: 4, updatedAt: UPDATED_AT }));
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderEditor({ revision: 3 });
    await act(async () => typeTitle("届いていた"));
    await waitForAutosave();
    expect(status()?.textContent).toBe("オフライン・この端末に保持");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container!.querySelector("[data-conflict-band]")).toBeNull();
    expect(status()?.textContent).toBe("保存済み");
  });
});

describe("PageEditor drafts on this device (IndexedDB)", () => {
  const draftOf = (baseRevision: number, title: string, text: string): PageDraft => ({
    baseRevision,
    title,
    blocks: paragraph(text),
    savedAt: "2026-10-31T00:00:00.000Z",
  });

  it("writes a draft while typing, and deletes it once the server has that content", async () => {
    acceptingFetch();
    const drafts = createIndexedDbDraftStorage(new IDBFactory())!;
    await renderEditor({ revision: 1, title: "", blocks: [] }, { drafts });
    await act(async () => {
      bodyEditor().commands.insertContent("端末に残す");
    });
    await act(async () => typeTitle("題"));
    await advance(300);
    await settleIdb();
    expect(await drafts.get(PAGE_ID)).toMatchObject({ baseRevision: 1, title: "題", blocks: paragraph("端末に残す") });
    expect(status()?.getAttribute("data-drafts")).toBe("kept");

    await advance(700);
    await settleIdb();
    expect(status()?.textContent).toBe("保存済み");
    expect(await drafts.get(PAGE_ID)).toBeNull();
  });

  it("keeps the draft when new input arrives while the save is in flight, rewritten on the new revision", async () => {
    let release: () => void = () => undefined;
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        await new Promise<void>((resolve) => (release = resolve));
        return json(200, { page: { id: PAGE_ID, revision: (body.baseRevision as number) + 1 } });
      }),
    );
    const drafts = createIndexedDbDraftStorage(new IDBFactory())!;
    await renderEditor({ revision: 1, title: "" }, { drafts });
    await act(async () => typeTitle("一"));
    await waitForAutosave();
    expect(bodies).toHaveLength(1);
    await act(async () => typeTitle("一二"));
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    await advance(300);
    await settleIdb();
    expect(await drafts.get(PAGE_ID)).toMatchObject({ baseRevision: 2, title: "一二" });

    await waitForAutosave();
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    await settleIdb();
    expect(bodies.at(-1)).toEqual({ title: "一二", baseRevision: 2 });
    expect(await drafts.get(PAGE_ID)).toBeNull();
  });

  it("restores a draft on the same revision and saves it again", async () => {
    const { bodies } = acceptingFetch();
    const drafts = createIndexedDbDraftStorage(new IDBFactory())!;
    await drafts.put(PAGE_ID, draftOf(7, "下書きの題", "下書きの本文"));
    await renderEditor({ revision: 7, title: "サーバーの題", blocks: paragraph("サーバーの本文") }, { drafts });
    expect(container!.querySelector<HTMLTextAreaElement>("textarea.page-title")?.value).toBe("下書きの題");
    expect(bodyEditor().getText()).toBe("下書きの本文");
    expect(container!.querySelector("[data-conflict-band]")).toBeNull();
    // 載せたことは Undo で戻らない
    await act(async () => {
      bodyEditor().commands.undo();
    });
    expect(bodyEditor().getText()).toBe("下書きの本文");

    await waitForAutosave();
    expect(bodies).toEqual([{ title: "下書きの題", blocks: paragraph("下書きの本文"), baseRevision: 7 }]);
    await settleIdb();
    expect(await drafts.get(PAGE_ID)).toBeNull();
  });

  it("shows the conflict band for a draft on an older revision, keeping the draft and this screen's text", async () => {
    const { fetchMock, bodies } = acceptingFetch();
    const drafts = createIndexedDbDraftStorage(new IDBFactory())!;
    await drafts.put(PAGE_ID, draftOf(5, "下書きの題", "下書きの本文"));
    const serverUpdatedAt = "2026-10-31T09:05:00.000Z";
    await renderEditor({ revision: 6, title: "別の画面の題", blocks: paragraph("別の画面の本文"), updatedAt: serverUpdatedAt }, { drafts });
    expect(alertBand()?.querySelector("p")?.textContent).toBe(`${clock(serverUpdatedAt)} に別の画面で保存されました`);
    expect(bodyEditor().getText()).toBe("下書きの本文");
    expect(container!.querySelector<HTMLTextAreaElement>("textarea.page-title")?.value).toBe("下書きの題");
    expect(status()?.textContent).toBe("保存を止めています");

    // 書き続けても送らない。下書きは古い revision のまま残る（次に開いても帯が出る）
    await act(async () => {
      bodyEditor().commands.insertContent("追記");
    });
    await advance(5000);
    await settleIdb();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await drafts.get(PAGE_ID)).toMatchObject({ baseRevision: 5, title: "下書きの題" });

    await act(async () => button("最新版を見る").click());
    expect(container!.querySelector('[role="dialog"] .ProseMirror')?.textContent).toBe("別の画面の本文");
    await act(async () => button("閉じる").click());

    await act(async () => {
      button("この内容で上書き").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(bodies).toEqual([{ title: "下書きの題", blocks: paragraph("下書きの本文追記"), baseRevision: 6, overwrite: true }]);
    await settleIdb();
    expect(await drafts.get(PAGE_ID)).toBeNull();
    expect(container!.querySelector("[data-conflict-band]")).toBeNull();
  });

  it("drops a draft that already matches the server without loading or saving it", async () => {
    const { fetchMock } = acceptingFetch();
    const drafts = createIndexedDbDraftStorage(new IDBFactory())!;
    await drafts.put(PAGE_ID, draftOf(2, "同じ題", "同じ本文"));
    await renderEditor({ revision: 3, title: "同じ題", blocks: paragraph("同じ本文") }, { drafts });
    await settleIdb();
    expect(await drafts.get(PAGE_ID)).toBeNull();
    expect(container!.querySelector("[data-conflict-band]")).toBeNull();
    await advance(5000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(status()?.textContent).toBe("保存済み");
  });

  it("keeps working without a device draft when IndexedDB fails", async () => {
    const { bodies } = acceptingFetch();
    const failing: DraftStorage = {
      get: async () => null,
      put: async () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      delete: async () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };
    await renderEditor({ revision: 1 }, { drafts: failing });
    await act(async () => typeTitle("端末に書けない"));
    await advance(300);
    await settleIdb();
    expect(status()?.getAttribute("data-drafts")).toBe("none");
    await advance(700);
    expect(bodies).toEqual([{ title: "端末に書けない", baseRevision: 1 }]);
    expect(status()?.textContent).toBe("保存済み");
  });

  it("does not write over a draft it could not read", async () => {
    acceptingFetch();
    const puts: PageDraft[] = [];
    const unreadable: DraftStorage = {
      get: async () => {
        throw new DOMException("broken", "UnknownError");
      },
      put: async (_id, draft) => {
        puts.push(draft);
      },
      delete: async () => undefined,
    };
    await renderEditor({ revision: 1 }, { drafts: unreadable });
    await act(async () => typeTitle("a"));
    await advance(1000);
    await settleIdb();
    expect(puts).toEqual([]);
    expect(status()?.getAttribute("data-drafts")).toBe("none");
    expect(status()?.textContent).toBe("保存済み");
  });

  it("writes the draft at once when the page is hidden", async () => {
    // 保存の応答は返さない（応答で下書きが消える前に読む）
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const drafts = createIndexedDbDraftStorage(new IDBFactory())!;
    await renderEditor({ revision: 1, title: "" }, { drafts });
    await act(async () => typeTitle("隠れる直前"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settleIdb();
      // 300ms を待たずに書き込みが始まっている
      expect(await drafts.get(PAGE_ID)).toMatchObject({ title: "隠れる直前" });
    } finally {
      delete (document as { visibilityState?: string }).visibilityState;
    }
  });
});

describe("a new page (id null)", () => {
  const CREATED = "00000000-0000-4000-8000-0000000000aa";
  const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

  it("is created by the first save after composition ends, then PATCHed by id with the created revision, without remounting the editor", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push({ url, method: String(init.method), body });
        // 作ったページは revision 1。PATCH の応答は baseRevision の次
        return init.method === "POST" ? json(201, { page: { id: CREATED, revision: 1 } }) : json(200, { page: { id: CREATED, revision: (body.baseRevision as number) + 1 } });
      }),
    );
    try {
      const onCreated = vi.fn();
      const onSaved = vi.fn();
      const onTitleChange = vi.fn();
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () => {
        root!.render(<PageEditor page={{ id: null, title: "", blocks: [], revision: null }} onCreated={onCreated} onSaved={onSaved} onTitleChange={onTitleChange} />);
      });
      await wait(0);
      const body = container.querySelector(".ProseMirror");
      const title = container.querySelector<HTMLTextAreaElement>("textarea.page-title")!;
      expect(body).not.toBeNull();
      const set = (value: string) => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(title, value);
        title.dispatchEvent(new Event("input", { bubbles: true }));
      };

      // 変換中は作らない
      await act(async () => {
        title.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        set("ごうせい");
      });
      expect(onTitleChange).toHaveBeenLastCalledWith("ごうせい");
      await wait(1200);
      expect(calls).toEqual([]);

      await act(async () => {
        set("合成の題名");
        title.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      });
      await wait(1200);
      expect(calls).toEqual([{ url: "/api/pages", method: "POST", body: { title: "合成の題名" } }]);
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onCreated).toHaveBeenCalledWith(CREATED);

      await act(async () => set("合成の題名 2"));
      await wait(1200);
      await act(async () => set("合成の題名 3"));
      await wait(1200);
      expect(calls.slice(1)).toEqual([
        { url: `/api/pages/${CREATED}`, method: "PATCH", body: { title: "合成の題名 2", baseRevision: 1 } },
        { url: `/api/pages/${CREATED}`, method: "PATCH", body: { title: "合成の題名 3", baseRevision: 2 } },
      ]);
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onSaved).toHaveBeenCalledTimes(3);
      expect(container.querySelector(".ProseMirror")).toBe(body);
      expect(container.querySelector("textarea.page-title")).toBe(title);
      expect(title.value).toBe("合成の題名 3");
      expect(status()?.textContent).toBe("保存済み");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops autosave and shows the band when another screen saved the created page first (409 on the PATCH after the POST)", async () => {
    const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
    const otherUpdatedAt = "2026-10-31T00:00:00.000Z";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push({ url, method: String(init.method), body });
        if (init.method === "POST") return json(201, { page: { id: CREATED, revision: 1 } });
        // 上書きだけは受ける
        return body.overwrite === true
          ? json(200, { page: { id: CREATED, revision: (body.baseRevision as number) + 1 } })
          : json(409, { error: "conflict", page: { id: CREATED, title: "別の画面", blocks: [], revision: 2, updatedAt: otherUpdatedAt } });
      }),
    );
    const onSaved = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<PageEditor page={{ id: null, title: "", blocks: [], revision: null }} onSaved={onSaved} />);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => typeTitle("作った"));
    await waitForAutosave();
    await act(async () => typeTitle("作ったあと"));
    await waitForAutosave();
    expect(calls).toEqual([
      { url: "/api/pages", method: "POST", body: { title: "作った" } },
      { url: `/api/pages/${CREATED}`, method: "PATCH", body: { title: "作ったあと", baseRevision: 1 } },
    ]);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(alertBand()?.querySelector("p")?.textContent).toBe(`${clock(otherUpdatedAt)} に別の画面で保存されました`);
    expect(status()?.textContent).toBe("保存を止めています");

    await act(async () => typeTitle("作ったあとの続き"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls).toHaveLength(2);

    // 上書きは作ったページへ、競合の応答の revision の上に送る
    await act(async () => {
      button("この内容で上書き").click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls[2]).toMatchObject({ url: `/api/pages/${CREATED}`, method: "PATCH", body: { title: "作ったあとの続き", baseRevision: 2, overwrite: true } });
    expect(container.querySelector("[data-conflict-band]")).toBeNull();
    expect(onSaved).toHaveBeenCalledTimes(2);
  });

  describe("drafts on this device before the page exists", () => {
    const NEW_DRAFT: PageDraft = { baseRevision: 0, title: "閉じる前の題", blocks: paragraph("閉じる前の本文"), savedAt: "2026-10-31T00:00:00.000Z" };

    async function renderNewPage(drafts: DraftStorage, events: PageEditorEvents = {}, createOnOpen = false) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () => {
        root!.render(<StrictMode><PageEditor page={{ id: null, title: "", blocks: [], revision: null }} drafts={drafts} createOnOpen={createOnOpen} {...events} /></StrictMode>);
      });
      for (let index = 0; index < 100; index++) {
        if (container.querySelector(".ProseMirror")?.getAttribute("contenteditable") === "true") break;
        await settleIdb();
      }
      expect(container.querySelector(".ProseMirror")?.getAttribute("contenteditable")).toBe("true");
    }

    /** POST で作り、PATCH で revision を 1 つ進める fetch。`hold` なら応答を `release` まで待たせる。`failPatch` なら PATCH は届かない。 */
    function creatingFetch(options: { hold?: boolean; failPatch?: boolean } = {}) {
      const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
      const waiting: Array<() => void> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          calls.push({ url, method: String(init.method), body });
          if (options.hold) await new Promise<void>((resolve) => waiting.push(resolve));
          if (init.method === "POST") return json(201, { page: { id: CREATED, revision: 1 } });
          if (options.failPatch) throw new TypeError("Failed to fetch");
          return json(200, { page: { id: CREATED, revision: (body.baseRevision as number) + 1 } });
        }),
      );
      const release = async () => {
        await act(async () => {
          waiting.shift()?.();
          await vi.advanceTimersByTimeAsync(0);
        });
      };
      return { calls, release };
    }

    it("開いた直後に空の下書きを 1 回だけ作り、作成中の入力は同じページに保存する", async () => {
      const { calls, release } = creatingFetch({ hold: true });
      const drafts = createIndexedDbDraftStorage(new IDBFactory())!;
      const onCreated = vi.fn();
      await renderNewPage(drafts, { onCreated }, true);
      expect(calls).toEqual([{ url: "/api/pages", method: "POST", body: { title: "", blocks: [{ type: "paragraph" }] } }]);
      await act(async () => typeTitle("作成中の入力"));
      await release();
      await waitForAutosave();
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({ url: `/api/pages/${CREATED}`, method: "PATCH", body: { title: "作成中の入力", baseRevision: 1 } });
      await release();
      expect(onCreated).toHaveBeenCalledExactlyOnceWith(CREATED);
    });

    it("開いた直後の作成に失敗しても入力を保ち、同じ保存キューで再試行する", async () => {
      const { calls } = creatingFetch();
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
      const onCreated = vi.fn();
      await renderNewPage(createIndexedDbDraftStorage(new IDBFactory())!, { onCreated }, true);
      expect(status()?.textContent).toBe("オフライン・この端末に保持");
      await act(async () => typeTitle("再試行する題名"));
      await waitForAutosave();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: "POST", body: { title: "再試行する題名" } });
      expect(onCreated).toHaveBeenCalledExactlyOnceWith(CREATED);
    });

    it("keeps the text on this device before the page exists, and drops it once the page is created with it", async () => {
      const { calls } = creatingFetch();
      const drafts = createIndexedDbDraftStorage(new IDBFactory())!;
      await renderNewPage(drafts);
      await act(async () => {
        bodyEditor().commands.insertContent("端末の本文");
      });
      await act(async () => typeTitle("作る前"));
      await advance(300);
      await settleIdb();
      expect(await drafts.get(NEW_PAGE_DRAFT_KEY)).toMatchObject({ baseRevision: 0, title: "作る前", blocks: paragraph("端末の本文") });
      expect(status()?.getAttribute("data-drafts")).toBe("kept");

      await advance(700);
      await settleIdb();
      expect(calls).toEqual([{ url: "/api/pages", method: "POST", body: { title: "作る前", blocks: paragraph("端末の本文") } }]);
      expect(status()?.textContent).toBe("保存済み");
      expect(await drafts.get(NEW_PAGE_DRAFT_KEY)).toBeNull();
      expect(await drafts.get(CREATED)).toBeNull();
    });

    it("restores the text kept before a page existed, and creates the page with it", async () => {
      const { calls } = creatingFetch();
      const drafts = createIndexedDbDraftStorage(new IDBFactory())!;
      await drafts.put(NEW_PAGE_DRAFT_KEY, NEW_DRAFT);
      const onCreated = vi.fn();
      const onTitleChange = vi.fn();
      await renderNewPage(drafts, { onCreated, onTitleChange }, true);
      expect(container!.querySelector<HTMLTextAreaElement>("textarea.page-title")?.value).toBe("閉じる前の題");
      expect(bodyEditor().getText()).toBe("閉じる前の本文");
      expect(onTitleChange).toHaveBeenCalledWith("閉じる前の題");
      expect(container!.querySelector("[data-conflict-band]")).toBeNull();

      await waitForAutosave();
      await settleIdb();
      expect(calls).toEqual([{ url: "/api/pages", method: "POST", body: { title: "閉じる前の題", blocks: paragraph("閉じる前の本文") } }]);
      expect(onCreated).toHaveBeenCalledWith(CREATED);
      expect(await drafts.get(NEW_PAGE_DRAFT_KEY)).toBeNull();
      expect(await drafts.get(CREATED)).toBeNull();
    });

    it("moves input made while the page is being created to the created page's draft, on the created revision", async () => {
      const { calls, release } = creatingFetch({ hold: true });
      const drafts = createIndexedDbDraftStorage(new IDBFactory())!;
      await renderNewPage(drafts);
      await act(async () => typeTitle("一"));
      await waitForAutosave();
      expect(calls).toHaveLength(1);
      await act(async () => typeTitle("一二"));
      await release();
      await advance(300);
      await settleIdb();
      expect(await drafts.get(NEW_PAGE_DRAFT_KEY)).toBeNull();
      expect(await drafts.get(CREATED)).toMatchObject({ baseRevision: 1, title: "一二" });

      await waitForAutosave();
      await release();
      await settleIdb();
      expect(calls.at(-1)).toEqual({ url: `/api/pages/${CREATED}`, method: "PATCH", body: { title: "一二", baseRevision: 1 } });
      expect(await drafts.get(CREATED)).toBeNull();
    });

    it("keeps unsent text under the created page when the screen closes while the page is being created", async () => {
      const { calls, release } = creatingFetch({ hold: true, failPatch: true });
      const drafts = createIndexedDbDraftStorage(new IDBFactory())!;
      await renderNewPage(drafts);
      await act(async () => typeTitle("一"));
      await waitForAutosave();
      await act(async () => typeTitle("一二"));
      await act(async () => root!.unmount());
      root = null;
      await settleIdb();
      expect(await drafts.get(NEW_PAGE_DRAFT_KEY)).toMatchObject({ baseRevision: 0, title: "一二" });

      // 作れた。閉じたあとの送り直し（PATCH）は届かない
      await release();
      await release();
      await settleIdb();
      expect(calls.map((call) => call.method)).toEqual(["POST", "PATCH"]);
      expect(await drafts.get(NEW_PAGE_DRAFT_KEY)).toBeNull();
      // 作った内容より新しいかは分からないので、もとの revision のまま（次に開いたときに帯で比べる）
      expect(await drafts.get(CREATED)).toMatchObject({ baseRevision: 0, title: "一二" });
    });
  });
});
