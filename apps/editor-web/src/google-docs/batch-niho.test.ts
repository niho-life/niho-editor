import { describe, expect, it, vi } from "vitest";
import type { GoogleDocsCredential } from "./gateway";
import {
  GoogleDocsBatchNihoError,
  NihoGoogleDocsBatchOwnerGateway,
  NihoGoogleDocsBatchServiceClient,
  metadataIdentityToken,
} from "./batch-niho";

const API = "https://niho.example.test/api";
const JOB = "00000000-0000-4000-8000-000000000001";
const GRANT = "00000000-0000-4000-8000-000000000002";
const EXPORT = "00000000-0000-4000-8000-000000000003";
const DOC = "1AbCdEfGhIjKlMnOpQrStUvWxYz";
const EXPIRY = "2030-01-01T23:55:00.000Z";
const HASH = "a".repeat(64);
const credential: GoogleDocsCredential = { idToken: () => "synthetic-owner-token" };

type Call = { url: string; init?: RequestInit };
function fakeFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (next === undefined) throw new Error("fake fetch exhausted");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
async function thrown(run: () => Promise<unknown>): Promise<GoogleDocsBatchNihoError> {
  try { await run(); } catch (error) {
    expect(error).toBeInstanceOf(GoogleDocsBatchNihoError);
    return error as GoogleDocsBatchNihoError;
  }
  throw new Error("expected failure");
}

describe("Google Docs batch NIHO owner contract", () => {
  it("固定owner prefixへjob/hash/bytesだけを送り、revokeも同じprefixに限定する", async () => {
    const f = fakeFetch([
      json(200, { version: 1, grantId: GRANT, jobId: JOB, expiresAt: EXPIRY }),
      new Response(null, { status: 204 }),
    ]);
    const gateway = new NihoGoogleDocsBatchOwnerGateway(API, f.fetch);
    await gateway.grant(credential, JOB, [{ exportId: EXPORT, payloadSha256: HASH, payloadBytes: 44 }]);
    await gateway.revoke(credential, GRANT);
    expect(f.calls.map((call) => [call.init?.method, call.url])).toEqual([
      ["POST", `${API}/auth/experience-editor-connect/docs-drive/batch-grants`],
      ["DELETE", `${API}/auth/experience-editor-connect/docs-drive/batch-grants/${GRANT}`],
    ]);
    expect(JSON.parse(String(f.calls[0]!.init?.body))).toEqual({ jobId: JOB, items: [{ exportId: EXPORT, payloadSha256: HASH, payloadBytes: 44 }] });
    expect(new Headers(f.calls[0]!.init?.headers).get("authorization")).toBe("Bearer synthetic-owner-token");
    expect(f.calls[0]!.init).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
  });

  it("grant POSTの通信応答消失だけをuncertainとして区別する", async () => {
    const f = fakeFetch([new Error("socket")]);
    const error = await thrown(() => new NihoGoogleDocsBatchOwnerGateway(API, f.fetch).grant(credential, JOB, [{ exportId: EXPORT, payloadSha256: HASH, payloadBytes: 44 }]));
    expect({ reason: error.reason, uncertain: error.uncertain }).toEqual({ reason: "network_unknown", uncertain: true });
  });

  it("1 itemの4 MiB上限を外部通信より前に拒否する", async () => {
    const f = fakeFetch([]);
    await expect(new NihoGoogleDocsBatchOwnerGateway(API, f.fetch).grant(credential, JOB, [{
      exportId: EXPORT, payloadSha256: HASH, payloadBytes: 4 * 1024 * 1024 + 1,
    }])).rejects.toThrow("invalid Google Docs batch grant items");
    expect(f.calls).toHaveLength(0);
  });
});

describe("Google Docs batch NIHO service contract", () => {
  it("固定audienceのruntime tokenでinternal prefixのlookup/export/statusだけを呼ぶ", async () => {
    const f = fakeFetch([
      json(200, { version: 1, grantId: GRANT, jobId: JOB, expiresAt: EXPIRY }),
      json(200, { exportId: EXPORT, status: "completed", documentId: DOC, url: "https://evil.invalid/x" }),
      json(200, { exportId: EXPORT, status: "pending", retryable: false }),
    ]);
    const token = vi.fn(async () => "synthetic.service.jwt");
    const service = new NihoGoogleDocsBatchServiceClient({ apiBase: API, audience: "https://niho.example.test/internal-audience", fetch: f.fetch, token });
    await service.lookup(JOB, "synthetic-owner");
    const result = await service.export({ grantId: GRANT, jobId: JOB, actorId: "synthetic-owner", exportId: EXPORT, title: "題名", markdown: "本文" });
    await service.status({ grantId: GRANT, jobId: JOB, actorId: "synthetic-owner", exportId: EXPORT });
    expect(token).toHaveBeenCalledTimes(3);
    expect(token).toHaveBeenCalledWith("https://niho.example.test/internal-audience");
    expect(f.calls.map((call) => call.url)).toEqual([
      `${API}/internal/editor-docs-drive/grants/lookup`,
      `${API}/internal/editor-docs-drive/exports`,
      `${API}/internal/editor-docs-drive/exports/status`,
    ]);
    expect(result).toEqual({ exportId: EXPORT, status: "completed", documentId: DOC, url: `https://docs.google.com/document/d/${DOC}/edit` });
    expect(f.calls.every((call) => new Headers(call.init?.headers).get("authorization") === "Bearer synthetic.service.jwt")).toBe(true);
  });

  it("取消未確認でもDBだけの照会指定をNIHOへそのまま渡す", async () => {
    const f = fakeFetch([json(200, { exportId: EXPORT, status: "pending", retryable: false })]);
    const service = new NihoGoogleDocsBatchServiceClient({ apiBase: API, audience: "https://niho.example.test/a", fetch: f.fetch, token: async () => "a.b.c" });
    await service.status({ grantId: GRANT, jobId: JOB, actorId: "synthetic-owner", exportId: EXPORT, receiptOnly: true });
    expect(JSON.parse(String(f.calls[0]!.init?.body))).toEqual({
      grantId: GRANT, jobId: JOB, actorId: "synthetic-owner", exportId: EXPORT, receiptOnly: true,
    });
  });

  it("exportのnetwork unknownとstatus not-foundを混同しない", async () => {
    const exportFetch = fakeFetch([new Error("socket")]);
    const exporting = new NihoGoogleDocsBatchServiceClient({ apiBase: API, audience: "https://niho.example.test/a", fetch: exportFetch.fetch, token: async () => "a.b.c" });
    const unknown = await thrown(() => exporting.export({ grantId: GRANT, jobId: JOB, actorId: "owner", exportId: EXPORT, title: "題名", markdown: "本文" }));
    expect({ reason: unknown.reason, uncertain: unknown.uncertain }).toEqual({ reason: "network_unknown", uncertain: true });

    const statusFetch = fakeFetch([json(404, { error: { details: { reason: "export_not_found" } } })]);
    const status = new NihoGoogleDocsBatchServiceClient({ apiBase: API, audience: "https://niho.example.test/a", fetch: statusFetch.fetch, token: async () => "a.b.c" });
    const missing = await thrown(() => status.status({ grantId: GRANT, jobId: JOB, actorId: "owner", exportId: EXPORT }));
    expect({ status: missing.status, reason: missing.reason, uncertain: missing.uncertain }).toEqual({ status: 404, reason: "export_not_found", uncertain: false });
  });

  it("巨大・不正な応答と偽document URLを受け入れない", async () => {
    const huge = fakeFetch([new Response("x".repeat(1024 * 1024 + 1), { status: 200 })]);
    const service = new NihoGoogleDocsBatchServiceClient({ apiBase: API, audience: "https://niho.example.test/a", fetch: huge.fetch, token: async () => "a.b.c" });
    expect((await thrown(() => service.lookup(JOB, "owner"))).reason).toBe("invalid_response");
  });
});

describe("metadata identity token", () => {
  it("固定metadata endpointへaudienceをqueryで送り、JWT形だけを返す", async () => {
    const f = fakeFetch([new Response("header.payload.signature")]);
    await expect(metadataIdentityToken("https://niho.example.test/internal", f.fetch)).resolves.toBe("header.payload.signature");
    const url = new URL(f.calls[0]!.url);
    expect(url.origin + url.pathname).toBe("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity");
    expect(url.searchParams.get("audience")).toBe("https://niho.example.test/internal");
    expect(new Headers(f.calls[0]!.init?.headers).get("metadata-flavor")).toBe("Google");
  });
});
