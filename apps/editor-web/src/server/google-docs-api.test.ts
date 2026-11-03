import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Block } from "@niho/editor-store";
import type { AuthProvider, Session } from "../auth/types";
import { GoogleDocsError, documentUrl, type GoogleDocsConnection, type GoogleDocsExport, type GoogleDocsFailureCode, type GoogleDocsGateway } from "../google-docs/gateway";
import {
  connectRoute,
  connectionRoute,
  disconnectRoute,
  exportPageRoute,
  exportStatusRoute,
  type GoogleDocsApiDeps,
  type GoogleDocsPagesStore,
} from "./google-docs-api";

/**
 * Google ドキュメントへの書き出しの route。**Google も niho.life も呼ばない**（口を偽物に差し替える）。
 * 固定するのは権限（本人・同じ origin）・閉じているときの 503・本文をサーバーが作ること・失敗の HTTP ステータス。
 */

const ORIGIN = "http://editor.test";
const EXPORT_ID = "4b1a0f26-0b0e-4a6a-9f36-2b7c4a8e5d10";
const DOCUMENT_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-012345";
const TOKEN = "synthetic-id-token-not-a-real-credential";

const CONNECTED: GoogleDocsConnection = { status: "CONNECTED", connectedEmail: "person@example.test", reason: null };

type PageRow = { id: string; owner: string; title: string; blocks: Block[] };

function pageRow(owner: string, extra: Partial<PageRow> = {}): PageRow {
  return {
    id: randomUUID(),
    owner,
    title: "合成の題名",
    blocks: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "見出し" }] },
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "囲みの中" }] }] },
    ] as unknown as Block[],
    ...extra,
  };
}

function memoryStore(rows: PageRow[]): GoogleDocsPagesStore {
  return {
    getPage: async (owner, id) => {
      const row = rows.find((candidate) => candidate.id === id && candidate.owner === owner);
      return row ? ({ title: row.title, blocks: row.blocks } as Awaited<ReturnType<GoogleDocsPagesStore["getPage"]>>) : null;
    },
  };
}

const notUsed = async (): Promise<Response> => {
  throw new Error("the Google Docs API never calls the login routes");
};

function authAs(userId: string | null, token: string | null = TOKEN): AuthProvider {
  return {
    mode: "stub",
    getSession: async () => (userId ? ({ userId, mode: "stub" } satisfies Session) : null),
    beginLogin: notUsed,
    completeLogin: notUsed,
    logout: notUsed,
    apiToken: async () => token,
    docsApiToken: async () => token,
  };
}

/** 呼ばれた操作を覚える偽の口。応答は都度差し替える。 */
function fakeGateway(overrides: Partial<GoogleDocsGateway> = {}) {
  const calls: string[] = [];
  const gateway: GoogleDocsGateway = {
    connection: async () => {
      calls.push("connection");
      return CONNECTED;
    },
    connect: async () => {
      calls.push("connect");
      return "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic";
    },
    disconnect: async () => {
      calls.push("disconnect");
      return { status: "DISCONNECTED", connectedEmail: null, reason: null };
    },
    export: async (_credential, request) => {
      calls.push(`export:${request.exportId}:${request.title}:${request.markdown}`);
      return { exportId: request.exportId, status: "completed", documentId: DOCUMENT_ID, url: documentUrl(DOCUMENT_ID) } satisfies GoogleDocsExport;
    },
    exportStatus: async (_credential, exportId) => {
      calls.push(`status:${exportId}`);
      return { exportId, status: "pending", retryable: true } satisfies GoogleDocsExport;
    },
    ...overrides,
  };
  return { gateway, calls };
}

type DepsOptions = {
  userId?: string | null;
  token?: string | null;
  store?: GoogleDocsPagesStore | null;
  gateway?: GoogleDocsGateway | null;
};

function deps(options: DepsOptions = {}): GoogleDocsApiDeps {
  const auth = authAs(options.userId === undefined ? "person" : options.userId, options.token === undefined ? TOKEN : options.token);
  return {
    auth: () => auth,
    store: () => (options.store === undefined ? memoryStore([]) : options.store),
    gateway: () => (options.gateway === undefined ? fakeGateway().gateway : options.gateway),
    credential: async (session, sessionRequest) => {
      const token = await auth.docsApiToken?.(session, sessionRequest);
      return token ? { idToken: () => token } : null;
    },
    env: { EDITOR_ORIGIN: ORIGIN },
  };
}

function request(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const sameOrigin: Record<string, string> = method === "GET" ? {} : { origin: ORIGIN };
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { host: "editor.test", ...sameOrigin, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const errorOf = async (response: Response) => ((await response.json()) as { error?: string }).error;

describe("権限と閉じているとき", () => {
  it("未認証はどの route も 401", async () => {
    const d = deps({ userId: null });
    expect((await connectionRoute(request("GET", "/api/google-docs/connection"), d)).status).toBe(401);
    expect((await connectRoute(request("POST", "/api/google-docs/connect"), d, "/google-docs/connect")).status).toBe(401);
    expect((await disconnectRoute(request("POST", "/api/google-docs/disconnect"), d)).status).toBe(401);
    expect((await exportPageRoute(request("POST", "/x", { exportId: EXPORT_ID }), "x", d)).status).toBe(401);
    expect((await exportStatusRoute(request("GET", "/x"), EXPORT_ID, d)).status).toBe(401);
  });

  it("方式が閉じている・本人の token が出せないときは 503 google_docs_unavailable", async () => {
    for (const d of [deps({ gateway: null }), deps({ token: null })]) {
      const response = await connectionRoute(request("GET", "/api/google-docs/connection"), d);
      expect(response.status).toBe(503);
      expect(await errorOf(response)).toBe("google_docs_unavailable");
      const exported = await exportPageRoute(request("POST", "/x", { exportId: EXPORT_ID }), "x", d);
      expect(exported.status).toBe(503);
      expect(await errorOf(exported)).toBe("google_docs_unavailable");
    }
  });

  it("更新系は同じ origin からだけ（Origin が無い・違うのは 403）", async () => {
    const d = deps();
    const refused: Array<Record<string, string>> = [{}, { origin: "https://evil.test" }, { origin: "null" }];
    for (const headers of refused) {
      const path = "/api/pages/x/export/google-doc";
      const plain = new Request(`${ORIGIN}${path}`, { method: "POST", headers: { host: "editor.test", "content-type": "application/json", ...headers }, body: "{}" });
      expect((await exportPageRoute(plain, "x", d)).status).toBe(403);
      const connect = new Request(`${ORIGIN}/api/google-docs/connect`, { method: "POST", headers: { host: "editor.test", ...headers } });
      expect((await connectRoute(connect, d, "/google-docs/connect")).status).toBe(403);
      const disconnect = new Request(`${ORIGIN}/api/google-docs/disconnect`, { method: "POST", headers: { host: "editor.test", ...headers } });
      expect((await disconnectRoute(disconnect, d)).status).toBe(403);
    }
  });

  it("他人のページ・存在しない id は同じ 404", async () => {
    const mine = pageRow("person");
    const theirs = pageRow("someone-else");
    const d = deps({ store: memoryStore([mine, theirs]) });
    const theirPage = await exportPageRoute(request("POST", "/x", { exportId: EXPORT_ID }), theirs.id, d);
    const missing = await exportPageRoute(request("POST", "/x", { exportId: EXPORT_ID }), randomUUID(), d);
    expect([theirPage.status, missing.status]).toEqual([404, 404]);
    expect(await errorOf(theirPage)).toBe(await errorOf(missing));
    expect((await exportPageRoute(request("POST", "/x", { exportId: EXPORT_ID }), mine.id, d)).status).toBe(200);
  });

  it("DB が使えないときは 503 unavailable", async () => {
    const response = await exportPageRoute(request("POST", "/x", { exportId: EXPORT_ID }), "x", deps({ store: null }));
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toBe("unavailable");
  });
});

describe("書き出し", () => {
  it("本文と題名はサーバーが作る（ブラウザからは受け取らない）。囲みは引用にする", async () => {
    const row = pageRow("person");
    const { gateway, calls } = fakeGateway();
    const d = deps({ store: memoryStore([row]), gateway });
    const response = await exportPageRoute(request("POST", "/x", { exportId: EXPORT_ID }), row.id, d);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ exportId: EXPORT_ID, status: "completed", documentId: DOCUMENT_ID, url: documentUrl(DOCUMENT_ID) });
    expect(calls).toEqual([`export:${EXPORT_ID}:合成の題名:## 見出し\n\n> 囲みの中\n`]);
  });

  it("新しい書式をGoogle Docsへ出し、表現できない表は理由を返す", async () => {
    const row = pageRow("person", { blocks: [
      { type: "table", content: [
        { type: "tableRow", content: [
          { type: "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "項目" }] }] },
          { type: "tableHeader", attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "状態" }] }] },
        ] },
        { type: "tableRow", content: [
          { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "本文" }] }] },
          { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "編集中" }] }] },
        ] },
      ] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "完了" }] }] }] },
      { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const draft = true;" }] },
    ] as unknown as Block[] });
    const { gateway, calls } = fakeGateway();
    const response = await exportPageRoute(request("POST", "/x", { exportId: EXPORT_ID }), row.id, deps({ store: memoryStore([row]), gateway }));
    expect(response.status).toBe(200);
    expect(calls[0]).toContain("| 項目 | 状態 |");
    expect(calls[0]).toContain("- [x] 完了");
    expect(calls[0]).toContain("```ts");

    const invalid = pageRow("person", { blocks: [
      { type: "table", content: [{ type: "tableRow", content: [
        { type: "tableHeader", attrs: { colspan: 2, rowspan: 1, colwidth: null, align: null }, content: [{ type: "paragraph", content: [{ type: "text", text: "結合セル" }] }] },
      ] }] },
    ] as unknown as Block[] });
    const failed = await exportPageRoute(request("POST", "/x", { exportId: EXPORT_ID }), invalid.id, deps({ store: memoryStore([invalid]), gateway }));
    expect(failed.status).toBe(422);
    expect(await failed.json()).toMatchObject({ error: "unsupported_markdown", reason: expect.stringMatching(/結合セル/) });
    expect(calls).toHaveLength(1);
  });

  it("受付の id 以外の本文は受け付けない", async () => {
    const row = pageRow("person");
    const d = deps({ store: memoryStore([row]) });
    for (const body of [{}, { exportId: "nope" }, { exportId: EXPORT_ID.toUpperCase() }, { exportId: EXPORT_ID, title: "横から題名" }, { exportId: EXPORT_ID, markdown: "横から本文" }, []]) {
      const response = await exportPageRoute(request("POST", "/x", body), row.id, d);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("題名が空なら「無題」にする", async () => {
    const row = pageRow("person", { title: "   " });
    const { gateway, calls } = fakeGateway();
    await exportPageRoute(request("POST", "/x", { exportId: EXPORT_ID }), row.id, deps({ store: memoryStore([row]), gateway }));
    expect(calls[0]).toContain(":無題:");
  });

  /**
   * ページの題名は 500 文字まで入る（`src/lib/page-limits.ts`）のに、API の上限は 200（UTF-16）。
   * 長い題名のページを書き出せないのは困るので、断らずに切る。
   */
  it("長い題名は断らずに切る（サロゲートペアを割らない）", async () => {
    const cases = [
      { title: "あ".repeat(500), units: 200 },
      // 絵文字は 1 文字で UTF-16 2 つ。201 にならないよう、割らずに 200 で止める
      { title: "\u{1f600}".repeat(300), units: 200 },
      // 199 units のあとに絵文字（2 units）が来たら、その絵文字は入れない
      { title: `${"あ".repeat(199)}\u{1f600}\u{1f600}`, units: 199 },
    ];
    for (const { title, units } of cases) {
      const row = pageRow("person", { title });
      const { gateway, calls } = fakeGateway();
      const response = await exportPageRoute(request("POST", "/x", { exportId: EXPORT_ID }), row.id, deps({ store: memoryStore([row]), gateway }));
      expect(response.status).toBe(200);
      const sent = calls[0]!.slice(`export:${EXPORT_ID}:`.length, -"## 見出し\n\n> 囲みの中\n".length - 1);
      expect(sent.length, title.slice(0, 8)).toBe(units);
      // 片方だけのサロゲートを残さない
      expect(sent).toBe([...sent].join(""));
      expect(/[\ud800-\udfff]/.test([...sent].filter((character) => character.length === 1).join(""))).toBe(false);
    }
  });

  it("書き出せるブロックが無いページは 400（API を呼ばない）", async () => {
    const row = pageRow("person", { blocks: [{ type: "image", attrs: { src: "https://example.test/a.png" } }] as unknown as Block[] });
    const { gateway, calls } = fakeGateway();
    const response = await exportPageRoute(request("POST", "/x", { exportId: EXPORT_ID }), row.id, deps({ store: memoryStore([row]), gateway }));
    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("まだできていない受付は 202", async () => {
    const row = pageRow("person");
    const { gateway } = fakeGateway({ export: async (_c, r) => ({ exportId: r.exportId, status: "pending", retryable: true }) });
    const response = await exportPageRoute(request("POST", "/x", { exportId: EXPORT_ID }), row.id, deps({ store: memoryStore([row]), gateway }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ exportId: EXPORT_ID, status: "pending", retryable: true });
  });

  it("受付の状態は exportId の形を確かめる", async () => {
    const { gateway, calls } = fakeGateway();
    const d = deps({ gateway });
    expect((await exportStatusRoute(request("GET", "/x"), "nope", d)).status).toBe(404);
    expect(calls).toEqual([]);
    expect((await exportStatusRoute(request("GET", "/x"), EXPORT_ID, d)).status).toBe(202);
  });

  it("口の失敗は決まった HTTP ステータスになる", async () => {
    const expected: Array<[GoogleDocsFailureCode, number]> = [
      ["signed_out", 401],
      ["app_not_allowed", 503],
      ["temporarily_unavailable", 503],
      ["drive_not_connected", 409],
      ["drive_reconnect_required", 409],
      ["drive_connection_changed", 409],
      ["export_payload_conflict", 409],
      ["export_not_found", 404],
      ["export_result_unknown", 502],
      ["invalid_export", 413],
      ["invalid_response", 502],
      ["google_docs_failed", 502],
    ];
    const row = pageRow("person");
    for (const [code, status] of expected) {
      const { gateway } = fakeGateway({
        export: async () => {
          throw new GoogleDocsError(code);
        },
      });
      const response = await exportPageRoute(request("POST", "/x", { exportId: EXPORT_ID }), row.id, deps({ store: memoryStore([row]), gateway }));
      expect(response.status, code).toBe(status);
      expect(await errorOf(response), code).toBe(code);
    }
  });
});

describe("接続", () => {
  it("接続の状態をそのまま返す", async () => {
    const response = await connectionRoute(request("GET", "/api/google-docs/connection"), deps());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connection: CONNECTED });
  });

  it("同意へは 303 で送る（URL は口が確かめたもの）", async () => {
    const response = await connectRoute(request("POST", "/api/google-docs/connect"), deps(), "/google-docs/connect");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("同意の URL が取れないときは案内の画面へ code を付けて戻す", async () => {
    const { gateway } = fakeGateway({
      connect: async () => {
        throw new GoogleDocsError("invalid_response");
      },
    });
    const response = await connectRoute(request("POST", "/api/google-docs/connect"), deps({ gateway }), "/google-docs/connect?next=%2F");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/google-docs/connect?next=%2F&error=invalid_response");
  });

  it("解除は JSON、form から（returnPath つき）は 303", async () => {
    const json = await disconnectRoute(request("POST", "/api/google-docs/disconnect"), deps());
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual({ connection: { status: "DISCONNECTED", connectedEmail: null, reason: null } });
    const redirected = await disconnectRoute(request("POST", "/api/google-docs/disconnect"), deps(), "/google-docs/connect");
    expect(redirected.status).toBe(303);
    expect(redirected.headers.get("location")).toBe("/google-docs/connect");
  });
});
