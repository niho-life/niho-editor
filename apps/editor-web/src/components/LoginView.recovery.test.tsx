// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { refreshAuthSession, router } = vi.hoisted(() => ({
  refreshAuthSession: vi.fn(),
  router: { replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/auth-session-refresh", () => ({ refreshAuthSession }));

import { LoginView } from "./LoginView";

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  refreshAuthSession.mockReset();
  router.replace.mockReset();
  router.refresh.mockReset();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<LoginView next="/settings" error={null} recover />);
  });
  return container;
}

describe("LoginView session recovery", () => {
  it("refreshes the server session and asks Next to reread the original page", async () => {
    refreshAuthSession.mockResolvedValue("refreshed");
    await mount();
    expect(refreshAuthSession).toHaveBeenCalledWith({ force: true });
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("continues to normal login when the refresh cookies are no longer valid", async () => {
    refreshAuthSession.mockResolvedValue("unauthorized");
    await mount();
    expect(router.replace).toHaveBeenCalledWith("/auth/login?next=%2Fsettings");
  });

  it("shows a retry when refresh is temporarily unavailable", async () => {
    refreshAuthSession.mockResolvedValueOnce("unavailable").mockResolvedValueOnce("refreshed");
    const view = await mount();
    expect(view.querySelector('[role="alert"]')?.textContent).toContain("接続を確かめてもう一度");
    const retry = [...view.querySelectorAll("button")].find((button) => button.textContent === "もう一度確認");
    expect(retry).toBeDefined();
    await act(async () => retry?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(refreshAuthSession).toHaveBeenCalledTimes(2);
    expect(router.refresh).toHaveBeenCalledOnce();
  });
});
