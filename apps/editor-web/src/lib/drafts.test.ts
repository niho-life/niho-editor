import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DRAFT_DB_NAME,
  DRAFT_STORE,
  NEW_PAGE_DRAFT_KEY,
  createDraftKeeper,
  createIndexedDbDraftStorage,
  decideRestore,
  readDraft,
  type DraftStorage,
  type PageDraft,
} from "./drafts";
import { UNCREATED_REVISION } from "./page-save";

const PAGE_ID = "00000000-0000-4000-8000-000000000001";
const paragraph = (text: string) => [{ type: "paragraph", content: [{ type: "text", text }] }];
const draftOf = (title: string, text: string, baseRevision = 3): PageDraft => ({
  baseRevision,
  title,
  blocks: paragraph(text),
  savedAt: "2026-10-31T00:00:00.000Z",
});

/** setImmediate で進む fake-indexeddb の処理を待つ。 */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("createIndexedDbDraftStorage", () => {
  it("puts, gets and deletes a draft per page", async () => {
    const storage = createIndexedDbDraftStorage(new IDBFactory())!;
    expect(await storage.get(PAGE_ID)).toBeNull();
    await storage.put(PAGE_ID, draftOf("題", "本文"));
    expect(await storage.get(PAGE_ID)).toEqual(draftOf("題", "本文"));
    expect(await storage.get("00000000-0000-4000-8000-000000000002")).toBeNull();
    await storage.put(PAGE_ID, draftOf("題2", "本文2", 4));
    expect(await storage.get(PAGE_ID)).toEqual(draftOf("題2", "本文2", 4));
    await storage.delete(PAGE_ID);
    expect(await storage.get(PAGE_ID)).toBeNull();
  });

  it("applies operations in the order they were called, without waiting for each", async () => {
    const storage = createIndexedDbDraftStorage(new IDBFactory())!;
    const first = storage.put(PAGE_ID, draftOf("a", "a"));
    const removed = storage.delete(PAGE_ID);
    const last = storage.put(PAGE_ID, draftOf("b", "b"));
    await Promise.all([first, removed, last]);
    expect(await storage.get(PAGE_ID)).toEqual(draftOf("b", "b"));
  });

  it("deletes only a draft that matches the condition, read and deleted in one transaction", async () => {
    const storage = createIndexedDbDraftStorage(new IDBFactory())!;
    await storage.put(PAGE_ID, draftOf("a", "a"));
    await storage.delete(PAGE_ID, (stored) => stored.savedAt === "2026-10-31T09:99:99.999Z");
    expect(await storage.get(PAGE_ID)).toEqual(draftOf("a", "a"));
    await storage.delete(PAGE_ID, (stored) => stored.savedAt === draftOf("a", "a").savedAt);
    expect(await storage.get(PAGE_ID)).toBeNull();
    await expect(storage.delete(PAGE_ID, () => true)).resolves.toBeUndefined();
  });

  it("keeps a new page's draft (not created yet) under its own key", async () => {
    const storage = createIndexedDbDraftStorage(new IDBFactory())!;
    await storage.put(NEW_PAGE_DRAFT_KEY, draftOf("作る前", "作る前", UNCREATED_REVISION));
    expect(await storage.get(NEW_PAGE_DRAFT_KEY)).toEqual(draftOf("作る前", "作る前", UNCREATED_REVISION));
    expect(await storage.get(PAGE_ID)).toBeNull();
    await storage.put(NEW_PAGE_DRAFT_KEY, draftOf("負", "負", -1));
    expect(await storage.get(NEW_PAGE_DRAFT_KEY)).toBeNull();
  });

  it("ignores a stored value that is not a draft", async () => {
    const factory = new IDBFactory();
    const storage = createIndexedDbDraftStorage(factory)!;
    await storage.put(PAGE_ID, draftOf("a", "a"));
    await new Promise<void>((resolve, reject) => {
      const open = factory.open(DRAFT_DB_NAME);
      open.onsuccess = () => {
        const transaction = open.result.transaction(DRAFT_STORE, "readwrite");
        transaction.objectStore(DRAFT_STORE).put({ title: 1 }, PAGE_ID);
        transaction.oncomplete = () => {
          open.result.close();
          resolve();
        };
        transaction.onabort = () => reject(transaction.error);
      };
    });
    expect(await storage.get(PAGE_ID)).toBeNull();
  });

  it("keeps the page's language with the draft, and drops a language it cannot read without losing the title and body", async () => {
    const factory = new IDBFactory();
    const storage = createIndexedDbDraftStorage(factory)!;
    await storage.put(PAGE_ID, { ...draftOf("題", "本文"), lang: "en" });
    expect(await storage.get(PAGE_ID)).toEqual({ ...draftOf("題", "本文"), lang: "en" });
    await new Promise<void>((resolve, reject) => {
      const open = factory.open(DRAFT_DB_NAME);
      open.onsuccess = () => {
        const transaction = open.result.transaction(DRAFT_STORE, "readwrite");
        transaction.objectStore(DRAFT_STORE).put({ ...draftOf("題", "本文"), lang: "fr" }, PAGE_ID);
        transaction.oncomplete = () => {
          open.result.close();
          resolve();
        };
        transaction.onabort = () => reject(transaction.error);
      };
    });
    expect(await storage.get(PAGE_ID)).toEqual(draftOf("題", "本文"));
  });

  it("keeps cover and lead with the draft and compares them to the server content", () => {
    const draft = { ...draftOf("題", "本文"), cover: PAGE_ID, lead: "説明" };
    expect(decideRestore(draft, { title: "題", blocks: paragraph("本文"), revision: 3, cover: PAGE_ID, lead: "説明" })).toEqual({ action: "discard" });
    expect(decideRestore(draft, { title: "題", blocks: paragraph("本文"), revision: 3, cover: null, lead: "説明" })).toMatchObject({ action: "load" });
  });

  it("is null without IndexedDB, and rejects (does not throw) when IndexedDB cannot open", async () => {
    expect(createIndexedDbDraftStorage(undefined)).toBeNull();
    const broken = createIndexedDbDraftStorage({
      open: () => {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as IDBFactory)!;
    await expect(broken.put(PAGE_ID, draftOf("a", "a"))).rejects.toThrow("denied");
    await expect(broken.get(PAGE_ID)).rejects.toThrow("denied");
  });
});

describe("decideRestore", () => {
  const server = { title: "題", blocks: paragraph("サーバー"), revision: 3 };

  it("loads a draft on the same revision, shows the conflict for an older one, and drops one equal to the server", () => {
    expect(decideRestore(null, server)).toEqual({ action: "none" });
    expect(decideRestore(draftOf("題", "サーバー", 2), server)).toEqual({ action: "discard" });
    expect(decideRestore(draftOf("題", "下書き", 3), server)).toEqual({ action: "load", draft: draftOf("題", "下書き", 3) });
    expect(decideRestore(draftOf("題", "下書き", 2), server)).toEqual({ action: "conflict", draft: draftOf("題", "下書き", 2) });
  });

  it("compares the language too: a draft that only changed the language is loaded (or conflicts), an old draft without one is compared by title and body", () => {
    const withLang = { ...server, lang: "ja" as const };
    const english = { ...draftOf("題", "サーバー", 3), lang: "en" as const };
    expect(decideRestore(english, withLang)).toEqual({ action: "load", draft: english });
    expect(decideRestore({ ...english, baseRevision: 2 }, withLang)).toEqual({ action: "conflict", draft: { ...english, baseRevision: 2 } });
    expect(decideRestore({ ...english, lang: "ja" }, withLang)).toEqual({ action: "discard" });
    expect(decideRestore(draftOf("題", "サーバー", 3), withLang)).toEqual({ action: "discard" });
  });

  it("loads a new page's draft against the empty page, and drops an empty one", () => {
    const empty = { title: "", blocks: [], revision: UNCREATED_REVISION };
    expect(decideRestore(draftOf("作る前", "作る前", UNCREATED_REVISION), empty)).toEqual({
      action: "load",
      draft: draftOf("作る前", "作る前", UNCREATED_REVISION),
    });
    expect(decideRestore({ baseRevision: UNCREATED_REVISION, title: "", blocks: [{ type: "paragraph" }], savedAt: "2026-10-31T00:00:00.000Z" }, empty)).toEqual({
      action: "discard",
    });
  });
});

describe("readDraft", () => {
  afterEach(() => vi.useRealTimers());

  it("gives up after the timeout so a stuck IndexedDB does not hold the page", async () => {
    vi.useFakeTimers();
    const stuck: DraftStorage = { get: () => new Promise(() => undefined), put: async () => undefined, delete: async () => undefined };
    const result = readDraft(stuck, PAGE_ID, 2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toMatchObject({ ok: false });
  });

  it("reports a failing get as not ok", async () => {
    const failing: DraftStorage = { get: async () => Promise.reject(new Error("boom")), put: async () => undefined, delete: async () => undefined };
    expect(await readDraft(failing, PAGE_ID)).toMatchObject({ ok: false });
  });
});

describe("createDraftKeeper", () => {
  afterEach(() => vi.useRealTimers());

  function setup(options: { storage?: DraftStorage; composing?: () => boolean; pageId?: string; baseRevision?: number } = {}) {
    const storage = options.storage ?? createIndexedDbDraftStorage(new IDBFactory())!;
    let content = { baseRevision: options.baseRevision ?? 3, title: "題", blocks: paragraph("一") };
    const results: boolean[] = [];
    const read = vi.fn(() => content);
    const keeper = createDraftKeeper({
      storage,
      pageId: options.pageId ?? PAGE_ID,
      read,
      isComposing: options.composing ?? (() => false),
      onResult: (ok) => results.push(ok),
    });
    return { storage, keeper, read, results, set: (next: typeof content) => (content = next) };
  }

  it("writes 300ms after the last change, reading the content only then", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { storage, keeper, read } = setup();
    keeper.touch();
    keeper.touch();
    await vi.advanceTimersByTimeAsync(299);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    await keeper.settled();
    expect(await storage.get(PAGE_ID)).toMatchObject({ baseRevision: 3, title: "題", blocks: paragraph("一") });
  });

  it("does not write while an input method is composing, and writes right after it ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let composing = true;
    const { storage, keeper, read } = setup({ composing: () => composing });
    keeper.touch();
    await vi.advanceTimersByTimeAsync(3000);
    keeper.writeNow();
    expect(read).not.toHaveBeenCalled();
    composing = false;
    keeper.compositionEnded();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await keeper.settled();
    expect(await storage.get(PAGE_ID)).not.toBeNull();
  });

  it("writes at once on writeNow, and only when something changed", async () => {
    const { storage, keeper, read } = setup();
    keeper.writeNow();
    expect(read).not.toHaveBeenCalled();
    keeper.touch();
    keeper.writeNow();
    expect(read).toHaveBeenCalledTimes(1);
    await keeper.settled();
    expect(await storage.get(PAGE_ID)).not.toBeNull();
    keeper.dispose();
  });

  it("deletes the draft on discard and cancels a write that was waiting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { storage, keeper, read } = setup();
    keeper.touch();
    keeper.writeNow();
    await keeper.settled();
    keeper.touch();
    keeper.discard();
    await vi.advanceTimersByTimeAsync(1000);
    await keeper.settled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(await storage.get(PAGE_ID)).toBeNull();
  });

  it("keeps a later write after a discard (the newest content wins)", async () => {
    const { storage, keeper, set } = setup();
    keeper.touch();
    keeper.writeNow();
    keeper.discard();
    set({ baseRevision: 4, title: "題", blocks: paragraph("一二") });
    keeper.touch();
    keeper.writeNow();
    await keeper.settled();
    await tick();
    expect(await storage.get(PAGE_ID)).toMatchObject({ baseRevision: 4, blocks: paragraph("一二") });
  });

  it("reports a failing storage as not kept without throwing, and tries the write again next time", async () => {
    let fail = true;
    const puts: PageDraft[] = [];
    const flaky: DraftStorage = {
      get: async () => null,
      put: async (_id, draft) => {
        if (fail) throw new DOMException("quota", "QuotaExceededError");
        puts.push(draft);
      },
      delete: async () => undefined,
    };
    const { keeper, results } = setup({ storage: flaky });
    keeper.touch();
    expect(() => keeper.writeNow()).not.toThrow();
    await keeper.settled();
    expect(results).toEqual([false]);
    fail = false;
    keeper.writeNow();
    await keeper.settled();
    expect(results).toEqual([false, true]);
    expect(puts).toHaveLength(1);
  });

  it("does not delete a draft that another tab wrote over it, nor one it never wrote", async () => {
    const { storage, keeper } = setup();
    keeper.discard();
    await keeper.settled();
    await storage.put(PAGE_ID, draftOf("別のタブ", "別のタブ"));
    keeper.discard();
    await keeper.settled();
    expect(await storage.get(PAGE_ID)).toEqual(draftOf("別のタブ", "別のタブ"));

    keeper.touch();
    keeper.writeNow();
    await keeper.settled();
    // 同じページを開いた別のタブが、あとから書いた
    await storage.put(PAGE_ID, draftOf("別のタブ", "別のタブの続き"));
    keeper.discard();
    await keeper.settled();
    expect(await storage.get(PAGE_ID)).toEqual(draftOf("別のタブ", "別のタブの続き"));
  });

  it("deletes a draft it loaded when opening the page (adopt)", async () => {
    const { storage, keeper } = setup();
    await storage.put(PAGE_ID, draftOf("前の下書き", "前の下書き"));
    keeper.adopt(draftOf("前の下書き", "前の下書き"));
    keeper.discard();
    await keeper.settled();
    expect(await storage.get(PAGE_ID)).toBeNull();
  });

  it("rewrites on writeNow(force) even when nothing changed since the last write", async () => {
    const { storage, keeper, read } = setup();
    keeper.touch();
    keeper.writeNow();
    await keeper.settled();
    await storage.delete(PAGE_ID);
    keeper.writeNow();
    expect(read).toHaveBeenCalledTimes(1);
    keeper.writeNow(true);
    await keeper.settled();
    expect(read).toHaveBeenCalledTimes(2);
    expect(await storage.get(PAGE_ID)).not.toBeNull();
  });

  it("writes nothing once disabled", async () => {
    const { storage, keeper, read } = setup();
    keeper.disable();
    keeper.touch();
    keeper.writeNow();
    keeper.discard();
    await keeper.settled();
    expect(read).not.toHaveBeenCalled();
    expect(await storage.get(PAGE_ID)).toBeNull();
  });

  it("moves to the created page's id: deletes only what it wrote under the new page's key, and writes later changes under the id", async () => {
    const { storage, keeper, set } = setup({ pageId: NEW_PAGE_DRAFT_KEY, baseRevision: UNCREATED_REVISION });
    keeper.touch();
    keeper.writeNow();
    await keeper.settled();
    expect(await storage.get(NEW_PAGE_DRAFT_KEY)).toMatchObject({ baseRevision: UNCREATED_REVISION, title: "題" });

    // 作った内容が全てサーバーにある（carry なし）
    keeper.rekey(PAGE_ID, false);
    await keeper.settled();
    expect(await storage.get(NEW_PAGE_DRAFT_KEY)).toBeNull();
    expect(await storage.get(PAGE_ID)).toBeNull();

    set({ baseRevision: 1, title: "作ったあと", blocks: paragraph("二") });
    keeper.touch();
    keeper.writeNow();
    await keeper.settled();
    expect(await storage.get(PAGE_ID)).toMatchObject({ baseRevision: 1, title: "作ったあと" });
    expect(await storage.get(NEW_PAGE_DRAFT_KEY)).toBeNull();
  });

  it("leaves another tab's new-page draft alone when it moves to the created page's id", async () => {
    const { storage, keeper } = setup({ pageId: NEW_PAGE_DRAFT_KEY, baseRevision: UNCREATED_REVISION });
    keeper.touch();
    keeper.writeNow();
    await keeper.settled();
    await storage.put(NEW_PAGE_DRAFT_KEY, draftOf("別のタブ", "別のタブ", UNCREATED_REVISION));
    keeper.rekey(PAGE_ID, false);
    await keeper.settled();
    expect(await storage.get(NEW_PAGE_DRAFT_KEY)).toEqual(draftOf("別のタブ", "別のタブ", UNCREATED_REVISION));
  });

  it("carries the last draft to the created page's id when changes are not on the server yet, even after the screen closed", async () => {
    const { storage, keeper, read } = setup({ pageId: NEW_PAGE_DRAFT_KEY, baseRevision: UNCREATED_REVISION });
    keeper.touch();
    keeper.writeNow();
    await keeper.settled();
    keeper.dispose();
    keeper.rekey(PAGE_ID, true);
    await keeper.settled();
    // 閉じたあとは今の内容を読まない。最後に書いた下書きを、そのままの baseRevision で（次に開いたときに帯で比べる）
    expect(read).toHaveBeenCalledTimes(1);
    expect(await storage.get(NEW_PAGE_DRAFT_KEY)).toBeNull();
    expect(await storage.get(PAGE_ID)).toMatchObject({ baseRevision: UNCREATED_REVISION, title: "題", blocks: paragraph("一") });

    // そのあとの保存が届いたら消す
    keeper.discard();
    await keeper.settled();
    expect(await storage.get(PAGE_ID)).toBeNull();
  });
});
