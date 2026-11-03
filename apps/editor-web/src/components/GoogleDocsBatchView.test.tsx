// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleDocsBatchView } from "./GoogleDocsBatchView";

const ROOT = "00000000-0000-4000-8000-000000000001";
const OPERATION = "00000000-0000-4000-8000-000000000002";
const OPERATION_2 = "00000000-0000-4000-8000-000000000009";
const JOB = "00000000-0000-4000-8000-000000000003";
const DOC = "1AbCdEfGhIjKlMnOpQrStUvWxYz";
const preview = {
  rootPageId: ROOT, options: { includeBackground: false, includeTranscript: false }, totalBytes: 44, canStart: true,
  pages: [{ pageId: ROOT, title: "合成のページ", revision: 7, depth: 0, exportable: true, payloadBytes: 44, problem: null, omissions: [{ reason: "image_omitted", count: 2 }] }],
};
function batch(status = "queued") {
  return {
    job: {
      id: JOB, rootPageId: ROOT, operationId: OPERATION, status, options: preview.options, nextOrdinal: 0,
      errorCode: null, expiresAt: "2030-01-01T23:50:00.000Z", createdAt: "2030-01-01T00:00:00.000Z", cancelledAt: null, completedAt: status === "completed" ? "2030-01-01T00:01:00.000Z" : null,
    },
    items: [{
      ordinal: 0, pageId: ROOT, pageRevision: 7, title: "合成のページ", status: status === "completed" ? "completed" : "queued",
      omissions: [{ reason: "image_omitted", count: 2 }], sent: status === "completed", documentId: status === "completed" ? DOC : null,
      url: status === "completed" ? `https://docs.google.com/document/d/${DOC}/edit` : null, retryable: false, errorCode: null,
    }],
  };
}
async function settle(turns = 4) {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("GoogleDocsBatchView", () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("crypto", { randomUUID: () => OPERATION });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("省略理由・木順を確認してからpage id/revision/options/operationだけを開始APIへ送る", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
      calls.push({ path, body });
      if (path.endsWith("/preview")) return new Response(JSON.stringify(preview), { status: 200 });
      if (path.includes("/root/")) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      return new Response(JSON.stringify(batch()), { status: 202 });
    }));
    await act(async () => { root.render(<GoogleDocsBatchView rootPageId={ROOT} />); await settle(); });
    expect(container.textContent).toContain("画像: 2件");
    const confirmations = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await act(async () => confirmations.at(-1)!.click());
    const start = [...container.querySelectorAll("button")].find((button) => button.textContent === "書き出しを開始")!;
    await act(async () => { start.click(); await settle(); });
    const sent = calls.find((call) => call.path === "/api/google-docs/batches")!.body as Record<string, unknown>;
    expect(sent).toEqual({
      rootPageId: ROOT, operationId: OPERATION, selections: [{ pageId: ROOT, expectedRevision: 7 }],
      options: { includeBackground: false, includeTranscript: false },
    });
    expect(JSON.stringify(sent)).not.toContain("合成のページ");
  });

  it("reload時はURLにjob idを持たずrootのlatest APIから同じjobの結果と安全な文書リンクを復帰する", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = String(input); calls.push(path);
      if (path.endsWith("/preview")) return new Response(JSON.stringify(preview), { status: 200 });
      return new Response(JSON.stringify(batch("completed")), { status: 200 });
    }));
    await act(async () => { root.render(<GoogleDocsBatchView rootPageId={ROOT} />); await settle(); });
    expect(calls).toContain(`/api/google-docs/batches/root/${ROOT}`);
    expect(window.location.href).not.toContain(JOB);
    const link = [...container.querySelectorAll<HTMLAnchorElement>("a")].find((candidate) => candidate.textContent === "できた文書を開く");
    expect(link?.href).toBe(`https://docs.google.com/document/d/${DOC}/edit`);
    expect(link?.rel).toBe("noopener noreferrer");
  });

  it("開始準備中の案内は利用者向けの言葉だけで保存済み内容を説明する", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = String(input);
      if (path.endsWith("/preview")) return new Response(JSON.stringify(preview), { status: 200 });
      return new Response(JSON.stringify(batch("prepared")), { status: 200 });
    }));
    await act(async () => { root.render(<GoogleDocsBatchView rootPageId={ROOT} />); await settle(); });
    expect(container.textContent).toContain("選んだ版と内容は保存済みです");
    expect(container.textContent).not.toMatch(/snapshot|\bDB\b|lease|grant|OIDC/i);
  });

  it("確定したjobの完了後にもう一度明示開始すると新しいoperation idを使う", async () => {
    const operations = [OPERATION, OPERATION_2];
    vi.stubGlobal("crypto", { randomUUID: () => operations.shift()! });
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/preview")) return new Response(JSON.stringify(preview), { status: 200 });
      if (path.includes("/root/")) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      if (path === "/api/google-docs/batches") {
        const body = JSON.parse(String(init?.body)) as { operationId: string };
        sent.push(body.operationId);
        return new Response(JSON.stringify({ ...batch("completed"), job: { ...batch("completed").job, operationId: body.operationId } }), { status: 202 });
      }
      throw new Error(`unexpected ${path}`);
    }));
    await act(async () => { root.render(<GoogleDocsBatchView rootPageId={ROOT} />); await settle(); });
    const confirm = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)!;
    const start = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "書き出しを開始")!;
    await act(async () => confirm.click());
    await act(async () => { start().click(); await settle(); });
    await act(async () => { start().click(); await settle(); });
    expect(sent).toEqual([OPERATION, OPERATION_2]);
  });
});
