// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn<(path: string) => void>();
const refresh = vi.fn<() => void>();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh }) }));

import { AuthSessionRefresher } from "./AuthSessionRefresher";

const LAST_REFRESH_KEY = "niho-editor-auth-refreshed-at";
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 })));
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  replace.mockReset();
  refresh.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<AuthSessionRefresher />));
}

describe("AuthSessionRefresher", () => {
  it("checks the session when the authenticated shell mounts", async () => {
    await mount();
    expect(fetch).toHaveBeenCalledWith("/auth/refresh", expect.objectContaining({ method: "POST" }));
  });

  it("refreshes at the remaining interval after a remount", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-11-02T00:00:00.000Z");
    vi.setSystemTime(now);
    localStorage.setItem(LAST_REFRESH_KEY, String(now.getTime() - 30 * 60 * 1000));
    await mount();
    expect(fetch).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1); });
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
