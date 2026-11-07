// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { AccountConnections } from "./AccountConnections";

const ID = "00000000-0000-4000-8000-000000000042";
const pending = {
  id: ID,
  state: "PENDING" as const,
  providerName: "Synthetic Provider",
  inviterName: "Synthetic Host",
  writerName: "Synthetic Writer",
  writerLabel: "記事ライター",
  expiresAt: "2030-01-03T00:00:00.000Z",
  acceptedAt: null,
  createdAt: "2030-01-01T00:00:00.000Z",
};
const roles = { version: 1 as const, roles: ["writer" as const], destinations: ["exp" as const] };

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("AccountConnections", () => {
  it("has 「← 発信先」 above the Experience heading", async () => {
    push.mockReset();
    await act(async () => root!.render(<AccountConnections initial={{ status: "ready", roles, links: [] }} />));
    const back = container!.querySelector<HTMLAnchorElement>("a.es-back")!;
    expect(back.getAttribute("href")).toBe("/destinations");
    expect(back.nextElementSibling?.textContent).toBe("NIHO Experience");
    await act(async () => void back.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(push).toHaveBeenCalledWith("/destinations");
  });

  it("distinguishes a normal disconnected account from a roles lookup failure", async () => {
    const disconnected = { version: 1 as const, roles: [], destinations: [] };
    await act(async () => root!.render(<AccountConnections initial={{ status: "ready", roles: disconnected, links: [] }} />));
    expect(container!.textContent).toContain("未接続");
    expect(container!.querySelector('[role="alert"]')).toBeNull();
    await act(async () => root!.render(<AccountConnections key="error" initial={{ status: "error" }} />));
    expect(container!.textContent).toContain("接続を確認できません");
    expect(container!.textContent).not.toContain("未接続");
    expect(container!.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("keeps a verified destination connected when optional provider links cannot be read", async () => {
    await act(async () => root!.render(<AccountConnections initial={{ status: "ready", roles, links: [], linksUnavailable: true }} />));
    expect(container!.textContent).toContain("接続済み");
    expect(container!.textContent).not.toContain("接続を確認できません");
    expect(container!.textContent).not.toContain("招待や承諾済みのつながりはありません");
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe("体験とのつながりを確認できませんでした。");
  });

  it("shows Japanese state labels and suppresses duplicate decisions while refreshing canonical state", async () => {
    let finishPost!: (response: Response) => void;
    const post = new Promise<Response>((resolve) => { finishPost = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return post;
      return Promise.resolve(Response.json({ roles, links: [{ ...pending, state: "ACCEPTED", acceptedAt: "2030-01-02T00:00:00.000Z" }] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root!.render(<AccountConnections initial={{ status: "ready", roles, links: [pending] }} />));
    expect(container!.textContent).toContain("返事を待っています");
    expect(container!.textContent).not.toContain("PENDING");
    const accept = [...container!.querySelectorAll("button")].find((button) => button.textContent === "承諾する")!;
    await act(async () => {
      accept.click();
      accept.click();
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await act(async () => finishPost(Response.json({ link: { ...pending, state: "ACCEPTED" } })));
    expect(fetchMock).toHaveBeenCalledWith("/api/account/article-links", { cache: "no-store", credentials: "same-origin" });
    expect(container!.textContent).toContain("承諾済み");
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not keep a stale connected state when canonical refresh fails after an invitation action", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? Promise.resolve(Response.json({ link: { ...pending, state: "ACCEPTED" } })) : Promise.reject(new Error("offline")),
    );
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root!.render(<AccountConnections initial={{ status: "ready", roles, links: [pending] }} />));
    const accept = [...container!.querySelectorAll("button")].find((button) => button.textContent === "承諾する")!;
    await act(async () => accept.click());
    expect(container!.textContent).toContain("接続を確認できません");
    expect(container!.textContent).not.toContain("接続済み");
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain("最新の接続状態を確認できません");
  });

  it.each([403, 503])("keeps a failed invitation operation visible when its following GET succeeds (%s)", async (status) => {
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(
      init?.method === "POST" ? Response.json({}, { status }) : Response.json({ roles, links: [pending] }),
    )));
    await act(async () => root!.render(<AccountConnections initial={{ status: "ready", roles, links: [pending] }} />));
    const accept = [...container!.querySelectorAll("button")].find((button) => button.textContent === "承諾する")!;
    await act(async () => accept.click());
    expect(container!.textContent).toContain("接続済み");
    expect(container!.textContent).toContain("返事を待っています");
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain("招待の操作中に問題が発生しました");
  });
});
