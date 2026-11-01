// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

// public/sw.js をそのまま読み込み、偽の self / caches / fetch の上で動かす（#49）。
const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://editor.example.test";

type FetchEvent = { request: { url: string; method: string; mode: string }; respondWith: (response: Promise<Response>) => void; waitUntil: (work: Promise<unknown>) => void };
type Handler = (event: FetchEvent) => void;

function load(network: (url: string) => Promise<Response>, options: { putFails?: boolean; keysFails?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, Map<string, Response>>();
  const networkCalls: string[] = [];
  const open = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name) as Map<string, Response>;
    const keyOf = (request: string | { url: string }) => (typeof request === "string" ? new URL(request, ORIGIN).href : request.url);
    return {
      async addAll(urls: string[]) {
        for (const url of urls) entries.set(new URL(url, ORIGIN).href, await network(new URL(url, ORIGIN).href));
      },
      async match(request: string | { url: string }) {
        return entries.get(keyOf(request))?.clone();
      },
      async put(request: { url: string }, response: Response) {
        if (options.putFails) throw Object.assign(new Error("Quota exceeded"), { name: "QuotaExceededError" });
        entries.set(keyOf(request), response);
      },
      async keys() {
        if (options.keysFails) throw Object.assign(new Error("Storage unavailable"), { name: "UnknownError" });
        return [...entries.keys()].map((url) => ({ url }));
      },
      async delete(request: string | { url: string }) {
        return entries.delete(keyOf(request));
      },
    };
  };
  const self = {
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: vi.fn(() => Promise.resolve()),
    clients: { claim: vi.fn(() => Promise.resolve()) },
    location: new URL(`${ORIGIN}/`),
  };
  const caches = {
    open: async (name: string) => open(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const fetchSpy = (request: { url: string } | string) => {
    const url = typeof request === "string" ? request : request.url;
    networkCalls.push(url);
    return network(url);
  };
  vm.runInNewContext(source, { self, caches, fetch: fetchSpy, URL, Promise, Math });

  async function fire(type: string, event: Partial<FetchEvent> = {}) {
    let responded: Promise<Response> | undefined;
    let waited: Promise<unknown> | undefined;
    const full = {
      ...event,
      respondWith: (promise: Promise<Response>) => (responded = promise),
      waitUntil: (promise: Promise<unknown>) => (waited = promise),
    } as FetchEvent;
    const handler = handlers.get(type);
    if (!handler) throw new Error(`no ${type} handler`);
    handler(full);
    await waited;
    return { intercepted: responded !== undefined, response: responded ? await responded : undefined };
  }
  const request = (path: string, init: { method?: string; mode?: string } = {}) => ({
    request: { url: path.startsWith("http") ? path : `${ORIGIN}${path}`, method: init.method ?? "GET", mode: init.mode ?? "no-cors" },
  });
  return { self, stores, networkCalls, fire, request };
}

/** ブラウザの同一 origin の fetch の応答は type が "basic"（Node の new Response() は "default"）。 */
const basic = (body: string, status = 200) => {
  const response = new Response(body, { status });
  Object.defineProperty(response, "type", { value: "basic" });
  return response;
};
const online = (url: string) => Promise.resolve(basic(`body of ${new URL(url).pathname}`));
const offline = () => Promise.reject(new TypeError("Failed to fetch"));
const shellOnline = (url: string) => (new URL(url).pathname === "/offline.html" ? Promise.resolve(basic("OFFLINE PAGE")) : online(url));

describe("service worker: install and activate", () => {
  it("precaches only the offline page and its icon, and takes over at once", async () => {
    const worker = load(online);
    await worker.fire("install");
    const shell = [...worker.stores.entries()].find(([name]) => name.startsWith("niho-editor-shell-"));
    expect([...(shell?.[1].keys() ?? [])].sort()).toEqual([`${ORIGIN}/icons/icon-192.png`, `${ORIGIN}/offline.html`]);
    expect(worker.self.skipWaiting).toHaveBeenCalled();
  });

  it("drops the caches of other versions and keeps the current ones", async () => {
    const worker = load(online);
    await worker.fire("install");
    worker.stores.set("niho-editor-shell-v0", new Map());
    worker.stores.set("some-other-cache", new Map());
    worker.stores.set("niho-photo-static-v1", new Map());
    await worker.fire("activate");
    expect([...worker.stores.keys()].sort()).toEqual(["niho-editor-shell-v1", "niho-photo-static-v1", "some-other-cache"].sort());
    expect(worker.stores.has("niho-editor-shell-v0")).toBe(false);
    expect(worker.stores.has("some-other-cache")).toBe(true);
    expect(worker.stores.has("niho-photo-static-v1")).toBe(true);
    expect(worker.stores.has("niho-editor-shell-v1")).toBe(true);
    expect(worker.self.clients.claim).toHaveBeenCalled();
  });
});

describe("service worker: navigation", () => {
  it("shows the offline page, not a blank screen, when the network is down", async () => {
    let up = true;
    const worker = load((url) => (up ? shellOnline(url) : offline()));
    await worker.fire("install");
    up = false;
    const result = await worker.fire("fetch", worker.request("/p/synthetic", { mode: "navigate" }));
    expect(result.intercepted).toBe(true);
    expect(await result.response?.text()).toBe("OFFLINE PAGE");
  });

  it("passes the server's answer through untouched when online, including errors, and never stores pages", async () => {
    const worker = load((url) => Promise.resolve(basic("denied", url.endsWith("/api/pages") ? 401 : 500)));
    const home = await worker.fire("fetch", worker.request("/", { mode: "navigate" }));
    expect(home.response?.status).toBe(500);
    expect(await home.response?.text()).toBe("denied");
    expect([...worker.stores.values()].every((entries) => entries.size === 0)).toBe(true);
  });
});

describe("service worker: what it leaves alone", () => {
  it("does not intercept the API, writes, other origins, or non-navigation page requests", async () => {
    const worker = load(online);
    for (const probe of [
      worker.request("/api/pages"),
      worker.request("/api/pages/123"),
      worker.request("/api/pages", { method: "POST" }),
      worker.request("/p/synthetic?_rsc=1"),
      worker.request("https://other.example.test/_next/static/chunks/a.js"),
    ]) {
      const result = await worker.fire("fetch", probe);
      expect(result.intercepted, probe.request.url).toBe(false);
    }
    expect(worker.networkCalls).toEqual([]);
  });
});

describe("service worker: static files", () => {
  it("fetches a hashed static file once and then serves it from the cache", async () => {
    const worker = load(online);
    const first = await worker.fire("fetch", worker.request("/_next/static/chunks/app-abc123.js"));
    expect(await first.response?.text()).toBe("body of /_next/static/chunks/app-abc123.js");
    const second = await worker.fire("fetch", worker.request("/_next/static/chunks/app-abc123.js"));
    expect(await second.response?.text()).toBe("body of /_next/static/chunks/app-abc123.js");
    expect(worker.networkCalls).toHaveLength(1);
  });

  it("still returns the downloaded file when the cache cannot be written (storage full)", async () => {
    const worker = load(online, { putFails: true });
    const result = await worker.fire("fetch", worker.request("/_next/static/chunks/app-abc123.js"));
    expect(result.response?.ok).toBe(true);
    expect(await result.response?.text()).toBe("body of /_next/static/chunks/app-abc123.js");
  });

  it("still returns the downloaded file when trimming the cache fails", async () => {
    const worker = load(online, { keysFails: true });
    const result = await worker.fire("fetch", worker.request("/_next/static/chunks/app-def456.js"));
    expect(await result.response?.text()).toBe("body of /_next/static/chunks/app-def456.js");
  });

  it("does not store a failed response", async () => {
    const worker = load(() => Promise.resolve(basic("nope", 404)));
    await worker.fire("fetch", worker.request("/_next/static/chunks/missing.js"));
    await worker.fire("fetch", worker.request("/_next/static/chunks/missing.js"));
    expect(worker.networkCalls).toHaveLength(2);
  });

  it("keeps at most 200 static files, dropping the oldest", async () => {
    const worker = load(online);
    for (let index = 0; index < 205; index += 1) await worker.fire("fetch", worker.request(`/_next/static/chunks/c-${index}.js`));
    const entries = worker.stores.get("niho-editor-static-v1");
    expect(entries?.size).toBe(200);
    expect(entries?.has(`${ORIGIN}/_next/static/chunks/c-0.js`)).toBe(false);
    expect(entries?.has(`${ORIGIN}/_next/static/chunks/c-204.js`)).toBe(true);
  });

  it("serves the precached icon from the cache", async () => {
    const worker = load(online);
    await worker.fire("install");
    const before = worker.networkCalls.length;
    const result = await worker.fire("fetch", worker.request("/icons/icon-192.png"));
    expect(result.intercepted).toBe(true);
    expect(await result.response?.text()).toBe("body of /icons/icon-192.png");
    expect(worker.networkCalls.length).toBe(before);
  });
});
