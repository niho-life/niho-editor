// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./pages-client", async (original) => ({
  ...(await original<typeof import("./pages-client")>()),
  discardPageRequest: vi.fn(),
}));

import {
  LEFT_EMPTY_PAGES_KEY,
  LEFT_EMPTY_PAGES_MAX,
  TAB_CREATED_PAGES_KEY,
  addLeftEmptyCandidate,
  discardLeftEmptyCandidates,
  dropLeftEmptyCandidate,
  isTabCreatedPage,
  markTabCreatedPage,
  returnLeftEmptyCandidates,
  takeLeftEmptyCandidates,
  unmarkTabCreatedPage,
} from "./left-empty-pages";
import { PageRequestError, discardPageRequest } from "./pages-client";

// 合成のページの id だけを使う
const id = (index: number) => `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
const discard = vi.mocked(discardPageRequest);
const stored = () => JSON.parse(window.localStorage.getItem(LEFT_EMPTY_PAGES_KEY) ?? "[]") as string[];

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the candidates to discard (localStorage)", () => {
  it("adds without duplicates, keeps the newest 20, ignores what is not a page id, and empties on take", () => {
    addLeftEmptyCandidate(id(1));
    addLeftEmptyCandidate(id(1).toUpperCase());
    addLeftEmptyCandidate("not-a-page");
    expect(stored()).toEqual([id(1)]);
    for (let index = 2; index <= LEFT_EMPTY_PAGES_MAX + 3; index++) addLeftEmptyCandidate(id(index));
    expect(stored()).toHaveLength(LEFT_EMPTY_PAGES_MAX);
    expect(stored()[0]).toBe(id(4));
    expect(takeLeftEmptyCandidates()).toHaveLength(LEFT_EMPTY_PAGES_MAX);
    expect(window.localStorage.getItem(LEFT_EMPTY_PAGES_KEY)).toBeNull();
    returnLeftEmptyCandidates([id(7), id(8)]);
    dropLeftEmptyCandidate(id(7));
    expect(stored()).toEqual([id(8)]);
  });

  it("reads a broken value as empty, and does nothing when the storage cannot be used", () => {
    window.localStorage.setItem(LEFT_EMPTY_PAGES_KEY, "{");
    expect(takeLeftEmptyCandidates()).toEqual([]);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => addLeftEmptyCandidate(id(1))).not.toThrow();
    expect(() => markTabCreatedPage(id(1))).not.toThrow();
    expect(takeLeftEmptyCandidates()).toEqual([]);
    expect(isTabCreatedPage(id(1))).toBe(false);
  });
});

describe("the pages made in this tab (sessionStorage)", () => {
  it("knows a page made here, also after a reload, and nothing else", () => {
    markTabCreatedPage(id(1));
    expect(JSON.parse(window.sessionStorage.getItem(TAB_CREATED_PAGES_KEY)!)).toEqual([id(1)]);
    expect(isTabCreatedPage(id(1))).toBe(true);
    expect(isTabCreatedPage(id(2))).toBe(false);
    expect(isTabCreatedPage("not-a-page")).toBe(false);
  });

  it("unmarks a page the user added a tab to: no longer thrown away when left blank, and not a candidate either", () => {
    markTabCreatedPage(id(1));
    markTabCreatedPage(id(2));
    addLeftEmptyCandidate(id(1));
    unmarkTabCreatedPage(id(1));
    expect(isTabCreatedPage(id(1))).toBe(false);
    expect(isTabCreatedPage(id(2))).toBe(true);
    expect(JSON.parse(window.sessionStorage.getItem(TAB_CREATED_PAGES_KEY)!)).toEqual([id(2)]);
    expect(takeLeftEmptyCandidates()).toEqual([]);
    // 最後の 1 つを外すと控えごと消える。印の無いページを外しても何も起きない
    unmarkTabCreatedPage(id(2));
    expect(window.sessionStorage.getItem(TAB_CREATED_PAGES_KEY)).toBeNull();
    expect(() => unmarkTabCreatedPage(id(3))).not.toThrow();
  });
});

describe("discarding the candidates when the app opens", () => {
  it("never discards the page being opened, discards the rest, and keeps only those that did not get through", async () => {
    for (const index of [1, 2, 3, 4, 5]) addLeftEmptyCandidate(id(index));
    discard.mockImplementation(async (page) => {
      if (page === id(2)) return false;
      if (page === id(3)) throw new TypeError("offline");
      if (page === id(4)) throw new PageRequestError(404);
      return true;
    });
    const removed = vi.fn();
    await discardLeftEmptyCandidates(id(1).toUpperCase(), removed);
    expect(discard.mock.calls.map(([page]) => page).sort()).toEqual([id(2), id(3), id(4), id(5)]);
    expect(removed.mock.calls).toEqual([[id(5)]]);
    // 今開いているページは候補から外すだけ。届かなかったものは戻し、空でなかった・無かったものは外す
    expect(stored()).toEqual([id(3)]);
  });

  it("does nothing without candidates", async () => {
    const removed = vi.fn();
    await discardLeftEmptyCandidates(null, removed);
    expect(discard).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
  });
});
