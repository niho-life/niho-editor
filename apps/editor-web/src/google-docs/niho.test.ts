import { describe, expect, it } from "vitest";
import { GoogleDocsError, documentUrl, type GoogleDocsCredential, type GoogleDocsFailureCode } from "./gateway";
import { createNihoGoogleDocsGateway, isAuthorizationUrl } from "./niho";

/**
 * NIHO の Editor 専用 Docs APIを呼ぶ実装。**Google も niho.life も実際には呼ばない**（偽の fetch を注入する）。
 * 固定するのは、旧 NIHO docs の Mac アプリ（`apps/docs/src-tauri/src/google_docs.rs`）から写した契約と検証:
 * path・`Authorization`・本文の形、受け取った値の検証、失敗の対応づけ、token を外へ出さないこと。
 */

const API_BASE = "https://niho.life/api";
const TOKEN = "synthetic-id-token-not-a-real-credential";
const EXPORT_ID = "4b1a0f26-0b0e-4a6a-9f36-2b7c4a8e5d10";
const DOCUMENT_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz_-012345";

const credential: GoogleDocsCredential = { idToken: () => TOKEN };

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };

/** 応答を順に返す偽の fetch（受けた要求を全部覚える）。 */
function fakeFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ url: String(input), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null });
    const next = responses.shift();
    if (next === undefined) throw new Error("the fake fetch ran out of responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchFn, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function gateway(responses: Array<Response | Error>, returnTo = "niho-editor") {
  const { fetchFn, calls } = fakeFetch(responses);
  return { client: createNihoGoogleDocsGateway({ apiBase: API_BASE, returnTo, fetch: fetchFn }), calls };
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(GoogleDocsError);
    return (error as GoogleDocsError).code;
  }
  throw new Error("expected the call to fail");
}

const connected = { connection: { status: "CONNECTED", connectedEmail: "person@example.test", reason: null } };

describe("NIHO の API の契約", () => {
  it("接続の状態は GET で、本人の token を Authorization に入れる", async () => {
    const { client, calls } = gateway([json(200, connected)]);
    expect(await client.connection(credential)).toEqual({ status: "CONNECTED", connectedEmail: "person@example.test", reason: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://niho.life/api/auth/experience-editor-connect/docs-drive/connection");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body).toBeNull();
  });

  it("接続は POST で returnTo を送り、解除は DELETE", async () => {
    const { client, calls } = gateway(
      [json(200, { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic" }), json(200, { connection: { status: "DISCONNECTED", connectedEmail: null, reason: null } })],
      "niho-editor",
    );
    expect(await client.connect(credential)).toBe("https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic");
    expect(calls[0]!.url).toBe("https://niho.life/api/auth/experience-editor-connect/docs-drive/connect");
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ returnTo: "niho-editor" });
    expect(await client.disconnect(credential)).toEqual({ status: "DISCONNECTED", connectedEmail: null, reason: null });
    expect(calls[1]!.method).toBe("DELETE");
  });

  it("書き出しは exportId・題名・本文を送り、状態は exportId を path に入れる", async () => {
    const { client, calls } = gateway([
      json(200, { status: "completed", documentId: DOCUMENT_ID }),
      json(200, { status: "pending", retryable: true }),
    ]);
    await client.export(credential, { exportId: EXPORT_ID, title: "  合成の題名  ", markdown: "## 見出し\n" });
    expect(calls[0]!.url).toBe("https://niho.life/api/auth/experience-editor-connect/docs-drive/exports");
    // 題名は前後の空白を落として送る
    expect(JSON.parse(calls[0]!.body!)).toEqual({ exportId: EXPORT_ID, title: "合成の題名", markdown: "## 見出し\n" });
    expect(await client.exportStatus(credential, EXPORT_ID)).toEqual({ exportId: EXPORT_ID, status: "pending", retryable: true });
    expect(calls[1]!.url).toBe(`https://niho.life/api/auth/experience-editor-connect/docs-drive/exports/${EXPORT_ID}`);
  });

  it("起点の path を保ったまま、区切りごとに足す", async () => {
    const { client, calls } = gateway([json(200, connected)]);
    const local = createNihoGoogleDocsGateway({ apiBase: "https://api.example.test/base/", returnTo: "niho-editor", fetch: (async () => json(200, connected)) as typeof fetch });
    await client.connection(credential);
    expect(calls[0]!.url).toBe("https://niho.life/api/auth/experience-editor-connect/docs-drive/connection");
    await expect(local.connection(credential)).resolves.toBeTruthy();
  });
});

describe("受け取った値の検証", () => {
  it("API が返した url は使わず、確かめた documentId から組み立てる", async () => {
    const { client } = gateway([json(200, { status: "completed", documentId: DOCUMENT_ID, url: "https://evil.test/document/d/x/edit" })]);
    const result = await client.export(credential, { exportId: EXPORT_ID, title: "題名", markdown: "本文" });
    expect(result).toEqual({ exportId: EXPORT_ID, status: "completed", documentId: DOCUMENT_ID, url: documentUrl(DOCUMENT_ID) });
    expect(result.status === "completed" && result.url).toBe(`https://docs.google.com/document/d/${DOCUMENT_ID}/edit`);
  });

  it("documentId の形が違えば受け付けない", async () => {
    for (const documentId of ["", "short", "has space", "../../etc/passwd", "ok-but-way-too-long".repeat(40)]) {
      const { client } = gateway([json(200, { status: "completed", documentId })]);
      expect(await codeOf(() => client.export(credential, { exportId: EXPORT_ID, title: "題名", markdown: "本文" }))).toBe("invalid_response");
    }
  });

  it("CONNECTED なのに接続先のメールが無い応答は受け付けない", async () => {
    for (const connection of [{ status: "CONNECTED", connectedEmail: null }, { status: "CONNECTED", connectedEmail: "   " }, { status: "UNKNOWN" }, {}]) {
      const { client } = gateway([json(200, { connection })]);
      expect(await codeOf(() => client.connection(credential))).toBe("invalid_response");
    }
  });

  it("同意の URL は accounts.google.com の /o/oauth2/ だけ", async () => {
    const allowed = ["https://accounts.google.com/o/oauth2/v2/auth?client_id=x", "https://accounts.google.com:443/o/oauth2/auth"];
    const refused = [
      "http://accounts.google.com/o/oauth2/v2/auth",
      "https://accounts.google.com.evil.test/o/oauth2/v2/auth",
      "https://evil.test/o/oauth2/v2/auth",
      "https://accounts.google.com/o/other/auth",
      "https://accounts.google.com:8443/o/oauth2/auth",
      "https://user:pw@accounts.google.com/o/oauth2/auth",
      "/o/oauth2/v2/auth",
      "javascript:alert(1)",
      "",
    ];
    for (const url of allowed) expect(isAuthorizationUrl(url), url).toBe(true);
    for (const url of refused) expect(isAuthorizationUrl(url), url).toBe(false);
    for (const authorizationUrl of refused) {
      const { client } = gateway([json(200, { authorizationUrl })]);
      expect(await codeOf(() => client.connect(credential))).toBe("invalid_response");
    }
  });

  it("JSON でない応答・大きすぎる応答は受け付けない", async () => {
    const notJson = new Response("<html>not json</html>", { status: 200 });
    expect(await codeOf(() => gateway([notJson]).client.connection(credential))).toBe("invalid_response");
    const huge = new Response(JSON.stringify({ connection: { status: "CONNECTED", connectedEmail: "a".repeat(1024 * 1024 + 64) } }), { status: 200 });
    expect(await codeOf(() => gateway([huge]).client.connection(credential))).toBe("invalid_response");
  });

  it("送る前に題名と本文を確かめる（長すぎる・空は API を呼ばない）", async () => {
    const cases = [
      { title: "", markdown: "本文" },
      { title: "   ", markdown: "本文" },
      { title: "あ".repeat(201), markdown: "本文" },
      { title: "題名", markdown: "" },
      { title: "題名", markdown: "あ".repeat(1_000_001) },
    ];
    for (const input of cases) {
      const { client, calls } = gateway([]);
      expect(await codeOf(() => client.export(credential, { exportId: EXPORT_ID, ...input }))).toBe("invalid_export");
      expect(calls).toHaveLength(0);
    }
    const { client, calls } = gateway([]);
    expect(await codeOf(() => client.export(credential, { exportId: "NOT-A-UUID", title: "題名", markdown: "本文" }))).toBe("invalid_export");
    expect(await codeOf(() => client.exportStatus(credential, "4B1A0F26-0B0E-4A6A-9F36-2B7C4A8E5D10"))).toBe("invalid_export");
    expect(calls).toHaveLength(0);
  });
});

describe("失敗の対応づけ", () => {
  const cases: Array<[number, string | null, GoogleDocsFailureCode]> = [
    [401, "app_connect_disabled", "temporarily_unavailable"],
    [401, null, "signed_out"],
    [401, "something_else", "signed_out"],
    [403, "niho_docs_app_required", "app_not_allowed"],
    [403, null, "google_docs_failed"],
    [404, "export_not_found", "export_not_found"],
    [409, "drive_not_connected", "drive_not_connected"],
    [409, "export_payload_conflict", "export_payload_conflict"],
    [409, "google_account_changed", "drive_connection_changed"],
    [409, "drive_connection_changed", "drive_connection_changed"],
    [422, "credential_invalid", "drive_reconnect_required"],
    [422, "auth_revoked", "drive_reconnect_required"],
    [422, "drive_export_rejected", "google_docs_failed"],
    [429, null, "temporarily_unavailable"],
    [503, null, "temporarily_unavailable"],
    [500, "oauth_config_missing", "temporarily_unavailable"],
    [500, "access_token_failed", "temporarily_unavailable"],
    [500, "export_temporarily_unavailable", "temporarily_unavailable"],
    [400, null, "invalid_export"],
    [413, null, "invalid_export"],
    [418, null, "google_docs_failed"],
  ];

  it("HTTP ステータスと reason の組を code にする", async () => {
    for (const [status, reason, expected] of cases) {
      const body = reason === null ? {} : { error: { details: { reason } } };
      const { client } = gateway([json(status, body)]);
      expect(await codeOf(() => client.connection(credential)), `${status} ${reason}`).toBe(expected);
    }
  });

  it("通信の失敗は、書き出しの POST だけ export_result_unknown になる", async () => {
    const { client: a } = gateway([new Error("socket hang up")]);
    expect(await codeOf(() => a.export(credential, { exportId: EXPORT_ID, title: "題名", markdown: "本文" }))).toBe("export_result_unknown");
    const { client: b } = gateway([new Error("socket hang up")]);
    expect(await codeOf(() => b.connection(credential))).toBe("google_docs_failed");
    const { client: c } = gateway([new Error("socket hang up")]);
    expect(await codeOf(() => c.exportStatus(credential, EXPORT_ID))).toBe("google_docs_failed");
  });

  it("失敗に token・応答の本文を含めない", async () => {
    const { client } = gateway([json(500, { error: { details: { reason: "boom" }, message: TOKEN } })]);
    let thrown: unknown;
    try {
      await client.connection(credential);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GoogleDocsError);
    const text = `${String(thrown)}${(thrown as Error).stack ?? ""}${JSON.stringify(thrown)}`;
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("boom");
  });
});
