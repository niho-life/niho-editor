// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SIDE_PAGE_TEXT, SidePage } from "./SidePage";

const PAGE_B = "00000000-0000-4000-8000-00000000000b";
const AT = "2026-11-05T01:00:00.000Z";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getBoundingClientRect = rect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

function pageResponse(title: string, text: string, revision = 3): Response {
  const page = { id: PAGE_B, title, blocks: [{ type: "paragraph", content: [{ type: "text", text }] }], revision, updatedAt: AT };
  return new Response(JSON.stringify({ page }), { status: 200, headers: { "content-type": "application/json" } });
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function mount(props: { refresh?: number; onSwap?: () => void; onClose?: () => void } = {}) {
  host = document.createElement("div");
  host.setAttribute("data-docs-app-root", "");
  host.setAttribute("data-docs-shared-ui", "");
  document.body.append(host);
  root = createRoot(host);
  const render = async (next: { refresh?: number } = {}) => {
    await act(async () => root!.render(<SidePage id={PAGE_B} refresh={next.refresh ?? props.refresh ?? 0} onSwap={props.onSwap ?? vi.fn()} onClose={props.onClose ?? vi.fn()} />));
    await flush();
  };
  await render();
  return render;
}

describe("SidePage（右に並べたページ・読むだけ）", () => {
  it("既存の GET /api/pages/{id} で読み、題名は本文の先頭に 1 か所、本文は読み取り専用", async () => {
    const fetcher = vi.fn(async () => pageResponse("取材メモ 10/28", "朝6時に駅を出て"));
    vi.stubGlobal("fetch", fetcher);
    await mount();
    expect(fetcher).toHaveBeenCalledWith(`/api/pages/${PAGE_B}`, expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    expect([...host!.querySelectorAll(".es-side-tt")].map((node) => node.textContent)).toEqual(["取材メモ 10/28"]);
    const body = host!.querySelector<HTMLElement>('[aria-label="右のページの本文"]')!;
    expect(body.textContent).toBe("朝6時に駅を出て");
    expect(body.getAttribute("contenteditable")).toBe("false");
    expect(body.getAttribute("aria-readonly")).toBe("true");
    // 書式の帯・保存・公開は持たない
    expect(host!.querySelector('[role="toolbar"], .es-pubbtn, [data-save-state]')).toBeNull();
    expect(host!.textContent).not.toMatch(/読むだけ|保存|公開/);
  });

  it("⇄ と × は呼ぶ側へ", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => pageResponse("右", "本文")));
    const onSwap = vi.fn();
    const onClose = vi.fn();
    await mount({ onSwap, onClose });
    await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-label="メインと入れ替える"]')!.click());
    await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-label="右のページを閉じる"]')!.click());
    expect(onSwap).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("読み込み中は一言だけ（題名はまだ出さない）", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    await mount();
    expect(host!.querySelector('[role="status"]')!.textContent).toBe(SIDE_PAGE_TEXT.loading);
    expect(host!.querySelector(".es-side-tt")).toBeNull();
  });

  it("読めないページ（404）は「開けません」、通信の失敗は「もう一度」で読み直す", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await mount();
    expect(host!.querySelector('[role="alert"]')!.textContent).toBe(SIDE_PAGE_TEXT.missing);
    expect(host!.querySelector(".es-side-tt")).toBeNull();
    await act(async () => root!.unmount());
    host!.remove();

    const fetcher = vi.fn<() => Promise<Response>>().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(pageResponse("戻った", "本文"));
    vi.stubGlobal("fetch", fetcher);
    await mount();
    expect(host!.querySelector('[role="alert"]')!.textContent).toBe(SIDE_PAGE_TEXT.error);
    const retry = [...host!.querySelectorAll("button")].find((button) => button.textContent === SIDE_PAGE_TEXT.retry)!;
    await act(async () => retry.click());
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(host!.querySelector(".es-side-tt")!.textContent).toBe("戻った");
  });

  it("AI が書き換えた（refresh が増えた）・タブへ戻ったときに読み直す。読み直しの失敗では本文を消さない", async () => {
    const fetcher = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(pageResponse("右", "前の本文", 3))
      .mockResolvedValueOnce(pageResponse("右", "AI が足した本文", 4))
      .mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetcher);
    const render = await mount();
    expect(host!.querySelector('[aria-label="右のページの本文"]')!.textContent).toBe("前の本文");
    await render({ refresh: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(host!.querySelector('[aria-label="右のページの本文"]')!.textContent).toBe("AI が足した本文");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5000);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      // 続けて来る focus はまとめる（同じ戻りで 2 回読まない）
      window.dispatchEvent(new Event("focus"));
    });
    vi.useRealTimers();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(host!.querySelector('[aria-label="右のページの本文"]')!.textContent).toBe("AI が足した本文");
    expect(host!.querySelector('[role="alert"]')).toBeNull();
  });
});
