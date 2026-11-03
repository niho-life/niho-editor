import { describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "../auth/types";
import type { AiComposeBackend } from "../ai/config";
import { DEFAULT_RECIPES, type RecipeDef } from "../steps/recipes";
import { importRecipeSample, extractRecipeGuide, type RecipeSampleApiDeps, type RecipeSampleStore } from "./recipe-samples-api";
import { RecipeSampleImportError } from "./recipe-sample-import";

const ORIGIN = "https://editor.test";
const OWNER = "synthetic-owner-a";
const guide = "## 文書の目的と読者\n利用者が内容を把握する。\n\n## 構成\n- 要点から書く。";
const term = { term: "北鎌倉", reading: "きたかまくら", variants: ["北鎌"], note: "" };
const sample = { id: "sample-a", name: "合成見本.md", chars: 45 };
const recipe = { ...structuredClone(DEFAULT_RECIPES[0]!), id: "tpl-1", guide: "## 元のガイド", terms: [term], samples: [sample] } as RecipeDef;

function authAs(userId: string | null): AuthProvider {
  const unused = async (): Promise<Response> => { throw new Error("unused auth route"); };
  return {
    mode: "stub",
    getSession: async () => userId ? { userId, mode: "stub" } : null,
    beginLogin: unused,
    completeLogin: unused,
    logout: unused,
  };
}

function request(method: string, body?: FormData, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/settings/recipes/tpl-1/samples`, {
    method,
    headers: { host: "editor.test", ...(method === "GET" ? {} : { origin }) },
    ...(body ? { body } : {}),
  });
}

function sampleStore(patch: Partial<RecipeSampleStore> = {}) {
  return {
    recipes: vi.fn(async () => [recipe]),
    glossary: vi.fn(async () => [{ term: "NIHO鎌倉", reading: "にほかまくら", variants: [], note: "" }]),
    sampleBodies: vi.fn(async () => [{ id: sample.id, text: "新語はここに出る。新語を繰り返す。新語で終わる。NIHO鎌倉 北鎌倉 NIHO鎌倉 北鎌倉 NIHO鎌倉 北鎌倉" }]),
    addSample: vi.fn(async () => "created" as const),
    saveExtraction: vi.fn(async () => true),
    getExtraction: vi.fn(async () => null),
    ...patch,
  };
}

function baseDeps(patch: Partial<RecipeSampleApiDeps> = {}): RecipeSampleApiDeps {
  const store = sampleStore();
  return {
    auth: () => authAs(OWNER),
    store: () => store,
    compose: () => null,
    usage: () => ({ get: async () => ({ costMicroUsd: 0 }), record: vi.fn(async () => undefined) }),
    limitUsd: () => null,
    monthKey: () => "2026-11",
    now: () => new Date("2026-11-03T00:00:00.000Z"),
    env: { EDITOR_ORIGIN: ORIGIN },
    ...patch,
  };
}

describe("POST /api/settings/recipes/{recipeId}/samples", () => {
  it("requires a session and same origin before processing a file", async () => {
    const importFile = vi.fn(async () => ({ text: "fixture", chars: 7 }));
    const form = new FormData();
    form.set("file", new File(["fixture"], "sample.md"));
    const unsigned = baseDeps({ auth: () => authAs(null), importFile });
    expect((await importRecipeSample(request("POST", form), "tpl-1", unsigned)).status).toBe(401);
    const crossOrigin = baseDeps({ importFile });
    expect((await importRecipeSample(request("POST", form, "https://evil.test"), "tpl-1", crossOrigin)).status).toBe(403);
    expect(importFile).not.toHaveBeenCalled();
  });

  it("stores only metadata in the response while keeping the body owner scoped", async () => {
    const store = sampleStore();
    const importFile = vi.fn(async () => ({ text: "PRIVATE SYNTHETIC DOCUMENT BODY", chars: 30 }));
    const deps = baseDeps({ store: () => store, importFile });
    const form = new FormData();
    form.set("file", new File(["file bytes"], "sample.md"));
    const response = await importRecipeSample(request("POST", form), "tpl-1", deps);
    expect(response.status).toBe(201);
    expect(store.addSample).toHaveBeenCalledWith(OWNER, "tpl-1", expect.objectContaining({ name: "sample.md", chars: 30 }), "PRIVATE SYNTHETIC DOCUMENT BODY");
    const json = await response.json() as { sample: unknown };
    expect(JSON.stringify(json)).not.toContain("PRIVATE SYNTHETIC DOCUMENT BODY");
  });

  it("rejects malformed multipart fields and maps unsafe URL failures without echoing URLs", async () => {
    const form = new FormData();
    form.set("url", "https://example.test/?secret=synthetic-secret");
    const deps = baseDeps({ importUrl: async () => { throw new RecipeSampleImportError("unsafe_url"); } });
    const response = await importRecipeSample(request("POST", form), "tpl-1", deps);
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("unsafe_url");
    expect(body).not.toContain("synthetic-secret");

    const extra = new FormData();
    extra.set("url", "https://example.test/");
    extra.set("other", "unexpected");
    expect((await importRecipeSample(request("POST", extra), "tpl-1", baseDeps())).status).toBe(400);
  });

  it("caps streamed multipart bytes even when the request has no content-length", async () => {
    const store = sampleStore();
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 256 * 1024 + 1));
        controller.close();
      },
    });
    const streamed = new Request(`${ORIGIN}/api/settings/recipes/tpl-1/samples`, {
      method: "POST",
      headers: { host: "editor.test", origin: ORIGIN, "content-type": "multipart/form-data; boundary=synthetic" },
      body: oversized,
      duplex: "half",
    } as RequestInit);
    const response = await importRecipeSample(streamed, "tpl-1", baseDeps({ store: () => store }));
    expect(response.status).toBe(413);
    expect(store.addSample).not.toHaveBeenCalled();
  });

  it("does not log a thrown URL or document body", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = "synthetic-only-sensitive-body";
    const form = new FormData();
    form.set("url", `https://example.test/${secret}`);
    const deps = baseDeps({ importUrl: async () => { throw new Error(`failed ${secret}`); } });
    const response = await importRecipeSample(request("POST", form), "tpl-1", deps);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    log.mockRestore();
  });
});

describe("POST /api/settings/recipes/{recipeId}/guide-extraction", () => {
  it("deduplicates candidates against account and recipe terms, saves a review draft, and leaves the recipe untouched", async () => {
    const store = sampleStore({ recipes: vi.fn(async () => [recipe]) });
    const converse = vi.fn(async () => ({
      text: `<guide>\n${guide}\n</guide>\n<terms>\n[{"term":"NIHO鎌倉","reading":"にほかまくら"},{"term":"北鎌倉","reading":"きたかまくら"},{"term":"新語","reading":"しんご"}]\n</terms>`,
      usage: { inputTokens: 100, outputTokens: 30 },
      stopReason: "end_turn",
    }));
    const backend = { client: { converse }, model: "fixture-model", provider: null, route: "server", engine: "fixture" } as unknown as AiComposeBackend;
    const deps = baseDeps({
      store: () => store,
      compose: () => backend,
      usage: () => ({ get: async () => ({ costMicroUsd: 0 }), record: vi.fn(async () => undefined) }),
    });
    const response = await extractRecipeGuide(request("POST"), "tpl-1", deps);
    expect(response.status).toBe(200);
    expect(store.saveExtraction).toHaveBeenCalledWith(OWNER, "tpl-1", [sample.id], guide, [{ term: "新語", reading: "しんご", variants: [], note: "" }]);
    expect(recipe.guide).toBe("## 元のガイド");
    const responseBody = await response.text();
    expect(responseBody).toContain("新語");
    expect(responseBody).not.toContain("新語はここに出る");
    expect(converse).toHaveBeenCalledWith(expect.objectContaining({ system: expect.any(String), messages: [expect.objectContaining({ content: expect.stringContaining("新語はここに出る") })] }));
  });

  it("does not pass sample text through settings when no samples are saved", async () => {
    const store = sampleStore({ sampleBodies: vi.fn(async () => []) });
    const converse = vi.fn();
    const deps = baseDeps({ store: () => store, compose: () => ({ client: { converse }, model: "fixture", provider: null, route: "server", engine: "fixture" } as unknown as AiComposeBackend) });
    const response = await extractRecipeGuide(request("POST"), "tpl-1", deps);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_samples" });
    expect(converse).not.toHaveBeenCalled();
  });
});
