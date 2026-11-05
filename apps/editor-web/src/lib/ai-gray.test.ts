// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_GRAY_STORAGE_KEY, readAiGray, setAiGray, subscribeAiGray, useAiGray } from "./ai-gray";

/** 端末の置き場の代わり（Node の版によって jsdom の localStorage が無いため、この test で持つ）。 */
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, String(value)),
  };
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
});

afterEach(() => {
  window.localStorage.clear();
});

describe("AI の文を灰色で見せる", () => {
  it("is on by default and off only when stored as off", () => {
    expect(readAiGray()).toBe(true);
    window.localStorage.setItem(AI_GRAY_STORAGE_KEY, "on");
    expect(readAiGray()).toBe(true);
    window.localStorage.setItem(AI_GRAY_STORAGE_KEY, "off");
    expect(readAiGray()).toBe(false);
  });

  it("stores the choice and tells subscribers", () => {
    const listener = vi.fn();
    const stop = subscribeAiGray(listener);
    setAiGray(false);
    expect(window.localStorage.getItem(AI_GRAY_STORAGE_KEY)).toBe("off");
    setAiGray(true);
    expect(window.localStorage.getItem(AI_GRAY_STORAGE_KEY)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    setAiGray(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("follows the choice in a hook", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useAiGray());
      return null;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(createElement(Probe)));
    expect(seen.at(-1)).toBe(true);
    act(() => setAiGray(false));
    expect(seen.at(-1)).toBe(false);
    act(() => setAiGray(true));
    expect(seen.at(-1)).toBe(true);
    act(() => root.unmount());
  });
});
