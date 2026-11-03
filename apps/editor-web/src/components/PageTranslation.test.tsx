// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageTranslation } from "./PageTranslation";

const PAGE = "00000000-0000-4000-8000-000000000001";
const TARGET = "00000000-0000-4000-8000-000000000002";
const PROPOSAL = "00000000-0000-4000-8000-000000000003";
const SOURCE = "00000000-0000-4000-8000-000000000004";
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  navigation.push.mockReset();
  vi.unstubAllGlobals();
});

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const jaState = {
  page: { id: PAGE, lang: "ja", revision: 7 },
  relation: null,
  proposal: null,
  provider: { destination: "Anthropic API", metered: true },
};

const enState = {
  page: { id: TARGET, lang: "en" as const, revision: 4 },
  relation: {
    relationId: "00000000-0000-4000-8000-000000000005",
    sourcePageId: SOURCE,
    targetPageId: TARGET,
    sourceRevision: 8,
    targetRevision: 4,
    reviewedSourceRevision: 7,
    reviewedTargetRevision: 4,
    sourceMissing: false,
    detached: false,
  },
  proposal: null,
  provider: { destination: "Anthropic API", metered: true },
};

const ready = {
  id: PROPOSAL,
  status: "ready",
  generation: 1,
  sourceRevision: 7,
  targetRevision: null,
  targetPageId: TARGET,
  expiresAt: "2030-01-02T00:00:00.000Z",
  omissions: ["コードブロック"],
  sourceFields: [{ path: "title", text: "合成の題名" }, { path: "blocks[0].content[0].text", text: "合成の本文" }],
  candidateFields: [{ path: "title", text: "Synthetic title" }, { path: "blocks[0].content[0].text", text: "Synthetic body" }],
};

async function mount(lang: "ja" | "en", saveFirst = vi.fn(async () => true), currentRevision: () => number | null = () => lang === "ja" ? 7 : 4) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<PageTranslation pageId={lang === "ja" ? PAGE : TARGET} lang={lang} saveFirst={saveFirst} savedRevision={lang === "ja" ? 7 : 4} currentRevision={currentRevision} />));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return saveFirst;
}

function button(text: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === text);
  if (!found) throw new Error(`button not found: ${text}`);
  return found;
}

describe("PageTranslation", () => {
  it("discloses destination and metering, generates only after the explicit action, compares every field, then adopts", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path, method, body });
      if (method === "GET") return json(200, jaState);
      if (path.endsWith("/generate")) return json(201, { proposal: ready });
      if (path.includes("/adopt")) return json(200, { status: "adopted", targetPageId: TARGET, targetRevision: 1, created: true });
      return json(500, { error: "unexpected" });
    }));
    const saveFirst = await mount("ja");
    expect(container!.textContent).toContain("Anthropic APIへ送り、従量対象");
    expect(container!.textContent).toContain("20,000文字・256項目");
    expect(requests).toHaveLength(0);
    await act(async () => {
      button("APIで英語案を作る").click();
      for (let index = 0; index < 10; index++) await Promise.resolve();
    });
    expect(saveFirst).toHaveBeenCalledTimes(1);
    expect(requests[0]?.path).toMatch(/\/generate$/);
    expect(requests[0]?.body).toEqual({ operationId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(container!.textContent).toContain("原文: 合成の題名");
    expect(container!.textContent).toContain("英語案: Synthetic body");
    expect(container!.textContent).toContain("今回の対象外: コードブロック");
    const accessibility = await axe.run(container!, { rules: { "color-contrast": { enabled: false } } });
    expect(accessibility.violations.filter((entry) => entry.impact === "serious" || entry.impact === "critical")).toEqual([]);

    await act(async () => {
      button("この英語案を採用").click();
      for (let index = 0; index < 10; index++) await Promise.resolve();
    });
    expect(requests[1]?.body).toEqual({ sourceRevision: 7, targetRevision: null });
    expect(navigation.push).toHaveBeenCalledWith(`/p/${TARGET}`);
  });

  it("requires current source and target revisions before recording human review", async () => {
    const state = {
      page: { id: TARGET, lang: "en", revision: 4 },
      relation: {
        relationId: "00000000-0000-4000-8000-000000000005",
        sourcePageId: SOURCE,
        targetPageId: TARGET,
        sourceRevision: 8,
        targetRevision: 4,
        reviewedSourceRevision: 7,
        reviewedTargetRevision: 4,
        sourceMissing: false,
        detached: false,
      },
      proposal: null,
      provider: { destination: "Anthropic API", metered: true },
    };
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path, method, body });
      return method === "POST" ? json(200, { status: "reviewed" }) : json(200, state);
    }));
    const saveFirst = await mount("en");
    await act(async () => button("翻訳の状態を確認").click());
    expect(container!.textContent).toContain("原文または英語版が更新されています");
    await act(async () => button("原文と英語版を確認しました").click());
    expect(saveFirst).toHaveBeenCalledTimes(1);
    const review = requests.find((entry) => entry.method === "POST");
    expect(review?.path).toMatch(/\/review$/);
    expect(review?.body).toEqual({ sourceRevision: 8, targetRevision: 4 });
  });

  it.each(["source", "target"])("does not review a stale tab after another tab changes the %s revision", async (changed) => {
    let reads = 0;
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return json(200, { status: "reviewed" });
      }
      reads++;
      return json(200, reads === 1 ? enState : {
        ...enState,
        page: { ...enState.page, revision: changed === "target" ? 5 : 4 },
        relation: { ...enState.relation, sourceRevision: changed === "source" ? 9 : 8, targetRevision: changed === "target" ? 5 : 4 },
      });
    }));
    const saveFirst = await mount("en");
    await act(async () => button("翻訳の状態を確認").click());
    await act(async () => button("原文と英語版を確認しました").click());
    expect(saveFirst).toHaveBeenCalledTimes(1);
    expect(posts).toEqual([]);
    expect(container!.textContent).toContain("ページを再読み込みし、表示された本文をもう一度確認してください");
  });

  it("uses this editor's saved revision after flushing a local edit", async () => {
    const posts: unknown[] = [];
    let revision = 4;
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return json(200, { status: "reviewed" });
      }
      return json(200, { ...enState, page: { ...enState.page, revision }, relation: { ...enState.relation, targetRevision: revision } });
    }));
    await mount("en", vi.fn(async () => { revision = 5; return true; }), () => revision);
    await act(async () => button("翻訳の状態を確認").click());
    await act(async () => button("原文と英語版を確認しました").click());
    expect(posts).toEqual([{ sourceRevision: 8, targetRevision: 5 }]);
  });

  it("reloads review state after an English edit is saved and offers review again", async () => {
    let revision = 4;
    const fetcher = vi.fn(async () => json(200, {
      ...enState,
      page: { ...enState.page, revision },
      relation: { ...enState.relation, targetRevision: revision, reviewedSourceRevision: 8 },
    }));
    vi.stubGlobal("fetch", fetcher);
    const saveFirst = await mount("en");
    await act(async () => button("翻訳の状態を確認").click());
    expect(container!.textContent).toContain("現在の日本語原文と英語版を確認済みです");
    revision = 5;
    await act(async () => root!.render(<PageTranslation pageId={TARGET} lang="en" saveFirst={saveFirst} savedRevision={revision} currentRevision={() => revision} />));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container!.textContent).not.toContain("現在の日本語原文と英語版を確認済みです");
    expect(button("原文と英語版を確認しました").disabled).toBe(false);
  });

  it("keeps a missing-source target blocked until explicit detach confirmation", async () => {
    const state = {
      page: { id: TARGET, lang: "en", revision: 4 },
      relation: {
        relationId: "00000000-0000-4000-8000-000000000005",
        sourcePageId: null,
        targetPageId: TARGET,
        sourceRevision: null,
        targetRevision: 4,
        reviewedSourceRevision: 3,
        reviewedTargetRevision: 4,
        sourceMissing: true,
        detached: false,
      },
      proposal: null,
      provider: { destination: "Anthropic API", metered: true },
    };
    const requests: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push({ method, body: init?.body ? JSON.parse(String(init.body)) : null });
      return method === "POST" ? json(200, { status: "detached" }) : json(200, state);
    }));
    await mount("en");
    await act(async () => button("翻訳の状態を確認").click());
    expect(container!.textContent).toContain("次の公開・更新は停止します");
    expect(button("対応を外す").disabled).toBe(true);
    const checkbox = container!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => checkbox.click());
    expect(button("対応を外す").disabled).toBe(false);
    await act(async () => button("対応を外す").click());
    expect(requests.find((entry) => entry.method === "POST")?.body).toEqual({ targetRevision: 4 });
  });
});
