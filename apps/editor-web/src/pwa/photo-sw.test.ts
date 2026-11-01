// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../public/photo-sw.js", import.meta.url), "utf8");
const ORIGIN = "https://editor.example.test";
const STATIC_CACHE = "niho-photo-static-v1";
const METADATA = "x-niho-photo-cache-bytes";
const IMMUTABLE = { "cache-control": "public, max-age=31536000, immutable", "content-type": "application/javascript" };

type WorkerRequest = Request & { mode: RequestMode | "navigate" };
type WorkerEvent = {
  request: WorkerRequest;
  respondWith: (response: Promise<Response>) => void;
  waitUntil: (work: Promise<unknown>) => void;
};
type Handler = (event: WorkerEvent) => void;
type Network = (request: Request) => Promise<Response>;

function basic(body: BodyInit | null, init: ResponseInit = {}) {
  const response = new Response(body, { status: 200, headers: IMMUTABLE, ...init });
  Object.defineProperty(response, "type", { value: "basic" });
  return response;
}

function load(network: Network, options: { openFails?: boolean; putFails?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, Map<string, Response>>();
  const networkRequests: Request[] = [];
  const keyOf = (request: RequestInfo | URL | { url: string }) => {
    const value = typeof request === "string" || request instanceof URL ? request.toString() : request.url;
    return new URL(value, ORIGIN).href;
  };
  const open = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name)!;
    return {
      async match(request: RequestInfo | URL | { url: string }) {
        return entries.get(keyOf(request))?.clone();
      },
      async put(request: RequestInfo | URL | { url: string }, response: Response) {
        if (options.putFails) throw Object.assign(new Error("Quota exceeded"), { name: "QuotaExceededError" });
        entries.set(keyOf(request), response.clone());
      },
      async keys() {
        return [...entries.keys()].map((url) => ({ url }));
      },
      async delete(request: RequestInfo | URL | { url: string }) {
        return entries.delete(keyOf(request));
      },
    };
  };
  const self = {
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    skipWaiting: vi.fn(() => Promise.resolve()),
    clients: { claim: vi.fn(() => Promise.resolve()) },
    location: new URL(`${ORIGIN}/photo`),
  };
  const caches = {
    open: async (name: string) => {
      if (options.openFails) throw Object.assign(new Error("Cache unavailable"), { name: "UnknownError" });
      return open(name);
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const fetchSpy = async (request: Request) => {
    networkRequests.push(request);
    return network(request);
  };
  vm.runInNewContext(source, {
    self,
    caches,
    fetch: fetchSpy,
    URL,
    Request,
    Response,
    Headers,
    Blob,
    Promise,
    Uint8Array,
    setTimeout,
    clearTimeout,
  });

  async function fire(type: string, event: Partial<WorkerEvent> = {}) {
    let responded: Promise<Response> | undefined;
    const waits: Promise<unknown>[] = [];
    const full = {
      ...event,
      respondWith: (response: Promise<Response>) => (responded = response),
      waitUntil: (work: Promise<unknown>) => waits.push(work),
    } as WorkerEvent;
    const handler = handlers.get(type);
    if (!handler) throw new Error(`no ${type} handler`);
    handler(full);
    const response = responded ? await responded : undefined;
    await Promise.all(waits);
    return { intercepted: responded !== undefined, response };
  }

  function request(path: string, init: RequestInit & { mode?: RequestMode | "navigate" } = {}) {
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
    const { mode, ...requestInit } = init;
    const value = new Request(url, { method: "GET", ...requestInit }) as WorkerRequest;
    if (mode === "navigate") Object.defineProperty(value, "mode", { value: "navigate" });
    return { request: value };
  }

  return { self, stores, networkRequests, fire, request };
}

function stored(body: BodyInit, bytes: string) {
  return basic(body, { headers: { ...IMMUTABLE, [METADATA]: bytes } });
}

type SyntheticReader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<unknown>;
  releaseLock: () => void;
};

function withCacheReader(body: string, reader: SyntheticReader) {
  const response = basic(body);
  const clone = vi.fn(() => {
    const copy = basic(null);
    Object.defineProperty(copy, "body", { value: { getReader: () => reader } });
    return copy;
  });
  Object.defineProperty(response, "clone", { value: clone });
  return { clone, response };
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not settle");
}

const jsNetwork: Network = async (request) => basic(`body:${new URL(request.url).pathname}`);

afterEach(() => {
  vi.useRealTimers();
});

describe("photo service worker lifecycle", () => {
  it("installs immediately and deletes only old photo cache namespaces", async () => {
    const worker = load(jsNetwork);
    worker.stores.set(STATIC_CACHE, new Map());
    worker.stores.set("niho-photo-static-v0", new Map());
    worker.stores.set("niho-photo-shell-v0", new Map());
    worker.stores.set("niho-editor-static-v1", new Map());
    worker.stores.set("foreign-cache", new Map());
    await worker.fire("install");
    await worker.fire("activate");
    expect(worker.self.skipWaiting).toHaveBeenCalled();
    expect(worker.self.clients.claim).toHaveBeenCalled();
    expect([...worker.stores.keys()].sort()).toEqual([STATIC_CACHE, "niho-editor-static-v1", "foreign-cache"].sort());
  });
});

describe("photo service worker request boundary", () => {
  it("caches an exact immutable static URL and fetches it without credentials or redirects", async () => {
    const worker = load(jsNetwork);
    const path = "/_next/static/chunks/photo-abc123.js";
    const first = await worker.fire("fetch", worker.request(path));
    const second = await worker.fire("fetch", worker.request(path));
    expect(await first.response?.text()).toBe(`body:${path}`);
    expect(await second.response?.text()).toBe(`body:${path}`);
    expect(worker.networkRequests).toHaveLength(1);
    expect(worker.networkRequests[0]).toMatchObject({ credentials: "omit", redirect: "error" });
    expect(second.response?.headers.has(METADATA)).toBe(false);
  });

  it("rejects a corrupt exact cache hit instead of serving it", async () => {
    const worker = load(jsNetwork);
    const path = "/_next/static/chunks/corrupt-abc123.js";
    worker.stores.set(STATIC_CACHE, new Map([[`${ORIGIN}${path}`, stored("<html>private</html>", "invalid")]]));
    const result = await worker.fire("fetch", worker.request(path));
    expect(await result.response?.text()).toBe(`body:${path}`);
    expect(worker.networkRequests).toHaveLength(1);
    expect(worker.stores.get(STATIC_CACHE)?.get(`${ORIGIN}${path}`)?.headers.get(METADATA)).toBe(String(`body:${path}`.length));
  });

  it("leaves auth, API, photo content, SDK runtime, shared URLs, navigation, writes, queries, fragments, external origins and Authorization untouched", async () => {
    const worker = load(jsNetwork);
    const probes = [
      worker.request("/photo/auth/login"),
      worker.request("/auth/login/start"),
      worker.request("/api/photo/items"),
      worker.request("/photo/content/asset.jpg"),
      worker.request("/photo-runtime/runtime.js"),
      worker.request("/s/shared-id"),
      worker.request("/photo", { mode: "navigate" }),
      worker.request("/_next/static/chunks/a.js", { method: "POST" }),
      worker.request("/_next/static/chunks/a.js", { method: "PUT" }),
      worker.request("/_next/static/chunks/a.js?token=synthetic"),
      worker.request("/_next/static/chunks/a.js#synthetic"),
      worker.request("/_next/static/chunks/a.js", { cache: "no-store" }),
      worker.request("/_next/static/chunks/a.js", { cache: "reload" }),
      worker.request("https://other.example.test/_next/static/chunks/a.js"),
      worker.request("/_next/static/chunks/a.js", { headers: { authorization: "Bearer synthetic" } }),
    ];
    for (const probe of probes) expect((await worker.fire("fetch", probe)).intercepted, probe.request.url).toBe(false);
    expect(worker.networkRequests).toEqual([]);
    expect(worker.stores.size).toBe(0);
  });

  it.each([
    ["HTML", { headers: { ...IMMUTABLE, "content-type": "text/html" } }],
    ["JSON", { headers: { ...IMMUTABLE, "content-type": "application/json" } }],
    ["image", { headers: { ...IMMUTABLE, "content-type": "image/png" } }],
    ["octet stream", { headers: { ...IMMUTABLE, "content-type": "application/octet-stream" } }],
    ["private", { headers: { ...IMMUTABLE, "cache-control": "private, immutable" } }],
    ["no-store", { headers: { ...IMMUTABLE, "cache-control": "public, immutable, no-store" } }],
    ["Vary Cookie", { headers: { ...IMMUTABLE, vary: "Accept-Encoding, Cookie" } }],
    ["Vary Authorization", { headers: { ...IMMUTABLE, vary: "Authorization" } }],
    ["Vary star", { headers: { ...IMMUTABLE, vary: "*" } }],
    ["Set-Cookie", { headers: { ...IMMUTABLE, "set-cookie": "synthetic=1" } }],
  ])("does not retain a %s static response", async (_label, init) => {
    const worker = load(async () => basic("not cacheable", init));
    const probe = worker.request("/_next/static/chunks/rejected-abc123.js");
    await worker.fire("fetch", probe);
    await worker.fire("fetch", probe);
    expect(worker.networkRequests).toHaveLength(2);
  });

  it.each([
    ["opaque", 200, "opaque"],
    ["redirect", 302, "basic"],
    ["error", 500, "basic"],
  ])("does not retain an %s response", async (_label, status, type) => {
    const worker = load(async () => {
      const response = new Response("not cacheable", { status, headers: IMMUTABLE });
      Object.defineProperty(response, "type", { value: type });
      return response;
    });
    const probe = worker.request("/_next/static/chunks/rejected-def456.js");
    await worker.fire("fetch", probe);
    await worker.fire("fetch", probe);
    expect(worker.networkRequests).toHaveLength(2);
  });
});

describe("photo service worker storage budgets", () => {
  it("serializes two writes at the 128-entry boundary", async () => {
    const worker = load(jsNetwork);
    const entries = new Map<string, Response>();
    for (let index = 0; index < 127; index += 1) {
      entries.set(`${ORIGIN}/_next/static/chunks/warm-${index}.js`, stored(String(index), String(String(index).length)));
    }
    worker.stores.set(STATIC_CACHE, entries);
    const first = "/_next/static/chunks/parallel-a-abc123.js";
    const second = "/_next/static/chunks/parallel-b-def456.js";
    await Promise.all([worker.fire("fetch", worker.request(first)), worker.fire("fetch", worker.request(second))]);
    expect(entries?.size).toBe(128);
    expect(entries.has(`${ORIGIN}/_next/static/chunks/warm-0.js`)).toBe(false);
    expect(entries.has(`${ORIGIN}${first}`)).toBe(true);
    expect(entries.has(`${ORIGIN}${second}`)).toBe(true);
    expect([...entries?.values() ?? []].every((response) => /^\d+$/.test(response.headers.get(METADATA) ?? ""))).toBe(true);
  });

  it("keeps the total metadata budget at or below 64 MiB across parallel writes", async () => {
    const worker = load(jsNetwork);
    const entries = new Map<string, Response>();
    for (let index = 0; index < 8; index += 1) {
      entries.set(`${ORIGIN}/_next/static/chunks/byte-${index}.js`, stored(String(index), String(8 * 1024 * 1024)));
    }
    worker.stores.set(STATIC_CACHE, entries);
    const first = "/_next/static/chunks/byte-parallel-a-abc123.js";
    const second = "/_next/static/chunks/byte-parallel-b-def456.js";
    await Promise.all([worker.fire("fetch", worker.request(first)), worker.fire("fetch", worker.request(second))]);
    const total = [...entries.values()].reduce((sum, response) => sum + Number(response.headers.get(METADATA)), 0);
    expect(total).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(entries.has(`${ORIGIN}${first}`)).toBe(true);
    expect(entries.has(`${ORIGIN}${second}`)).toBe(true);
  });

  it("starts at most two cache body copies and skips the third without delaying its network response", async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const clones: ReturnType<typeof vi.fn>[] = [];
    const worker = load(async (request) => {
      const response = basic(`network:${new URL(request.url).pathname}`);
      const clone = vi.fn(() => basic(new ReadableStream<Uint8Array>({ start: (controller) => controllers.push(controller) })));
      Object.defineProperty(response, "clone", { value: clone });
      clones.push(clone);
      return response;
    });
    const paths = ["/_next/static/chunks/copy-a.js", "/_next/static/chunks/copy-b.js", "/_next/static/chunks/copy-c.js"];
    const first = worker.fire("fetch", worker.request(paths[0]!));
    const second = worker.fire("fetch", worker.request(paths[1]!));
    await waitFor(() => clones.length === 2 && clones.every((clone) => clone.mock.calls.length === 1));

    const third = await worker.fire("fetch", worker.request(paths[2]!));
    expect(await third.response?.text()).toBe(`network:${paths[2]}`);
    expect(clones).toHaveLength(3);
    expect(clones[2]).not.toHaveBeenCalled();
    expect(worker.stores.get(STATIC_CACHE)?.has(`${ORIGIN}${paths[2]}`)).toBe(false);

    for (const controller of controllers) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    }
    await Promise.all([first, second]);
    expect(worker.stores.get(STATIC_CACHE)?.has(`${ORIGIN}${paths[0]}`)).toBe(true);
    expect(worker.stores.get(STATIC_CACHE)?.has(`${ORIGIN}${paths[1]}`)).toBe(true);
  });

  it("uses byte metadata to evict oldest entries before crossing 64 MiB and drops unknown metadata", async () => {
    const worker = load(jsNetwork);
    const entries = new Map<string, Response>();
    for (let index = 0; index < 8; index += 1) {
      entries.set(`${ORIGIN}/_next/static/chunks/old-${index}.js`, stored(String(index), String(8 * 1024 * 1024)));
    }
    entries.set(`${ORIGIN}/_next/static/chunks/unknown.js`, stored("unknown", "invalid"));
    worker.stores.set(STATIC_CACHE, entries);
    await worker.fire("fetch", worker.request("/_next/static/chunks/new-abc123.js"));
    expect(entries.has(`${ORIGIN}/_next/static/chunks/old-0.js`)).toBe(false);
    expect(entries.has(`${ORIGIN}/_next/static/chunks/old-1.js`)).toBe(true);
    expect(entries.has(`${ORIGIN}/_next/static/chunks/unknown.js`)).toBe(false);
    expect(entries.has(`${ORIGIN}/_next/static/chunks/new-abc123.js`)).toBe(true);
  });

  it("accepts an actual 8 MiB asset but rejects a body one byte larger", async () => {
    const atLimit = new Uint8Array(8 * 1024 * 1024);
    const overLimit = new Uint8Array(8 * 1024 * 1024 + 1);
    const worker = load(async (request) => basic(new URL(request.url).pathname.includes("over") ? overLimit : atLimit));
    const accepted = "/_next/static/chunks/at-limit-abc123.js";
    const rejected = "/_next/static/chunks/over-limit-def456.js";
    await worker.fire("fetch", worker.request(accepted));
    await worker.fire("fetch", worker.request(rejected));
    const entries = worker.stores.get(STATIC_CACHE);
    expect(entries?.get(`${ORIGIN}${accepted}`)?.headers.get(METADATA)).toBe(String(8 * 1024 * 1024));
    expect(entries?.has(`${ORIGIN}${rejected}`)).toBe(false);
  });

  it("returns the online response when cache quota rejects the write", async () => {
    const options = { putFails: true };
    const worker = load(jsNetwork, options);
    const failed = await Promise.all([
      worker.fire("fetch", worker.request("/_next/static/chunks/quota-a-abc123.js")),
      worker.fire("fetch", worker.request("/_next/static/chunks/quota-b-def456.js")),
    ]);
    expect(failed.every((result) => result.response?.status === 200)).toBe(true);
    options.putFails = false;
    const recovered = "/_next/static/chunks/after-quota-ghi789.js";
    await worker.fire("fetch", worker.request(recovered));
    expect(worker.stores.get(STATIC_CACHE)?.has(`${ORIGIN}${recovered}`)).toBe(true);
  });

  it("restores both copy slots after clone errors", async () => {
    const worker = load(async (request) => {
      const response = basic("online despite clone failure");
      if (new URL(request.url).pathname.includes("clone-failure")) {
        Object.defineProperty(response, "clone", {
          value: vi.fn(() => {
            throw new Error("synthetic clone failure");
          }),
        });
      }
      return response;
    });
    await Promise.all([
      worker.fire("fetch", worker.request("/_next/static/chunks/clone-failure-a.js")),
      worker.fire("fetch", worker.request("/_next/static/chunks/clone-failure-b.js")),
    ]);
    const recovered = "/_next/static/chunks/after-copy-recovery-abc123.js";
    await worker.fire("fetch", worker.request(recovered));
    expect(worker.stores.get(STATIC_CACHE)?.has(`${ORIGIN}${recovered}`)).toBe(true);
  });

  it("returns the online response when the Cache API itself is unavailable", async () => {
    const worker = load(jsNetwork, { openFails: true });
    const result = await worker.fire("fetch", worker.request("/_next/static/chunks/cache-unavailable-abc123.js"));
    expect(result.response?.status).toBe(200);
    expect(await result.response?.text()).toContain("cache-unavailable-abc123.js");
  });

  it("releases the body reader after a normal cache copy", async () => {
    let reads = 0;
    const reader: SyntheticReader = {
      read: vi.fn(async () => (reads++ === 0 ? { done: false, value: new Uint8Array([1, 2]) } : { done: true })),
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(),
    };
    const prepared = withCacheReader("online", reader);
    const worker = load(async () => prepared.response);
    const path = "/_next/static/chunks/release-normal-abc123.js";
    await worker.fire("fetch", worker.request(path));
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(worker.stores.get(STATIC_CACHE)?.has(`${ORIGIN}${path}`)).toBe(true);
  });

  it("restores both copy slots after read errors", async () => {
    const releases: ReturnType<typeof vi.fn>[] = [];
    const worker = load(async (request) => {
      if (!new URL(request.url).pathname.includes("error")) return basic("recovered");
      const releaseLock = vi.fn();
      releases.push(releaseLock);
      return withCacheReader("online despite copy error", {
        read: vi.fn(() => Promise.reject(new Error("synthetic read failure"))),
        cancel: vi.fn(async () => undefined),
        releaseLock,
      }).response;
    });
    await Promise.all([
      worker.fire("fetch", worker.request("/_next/static/chunks/error-a.js")),
      worker.fire("fetch", worker.request("/_next/static/chunks/error-b.js")),
    ]);
    expect(releases).toHaveLength(2);
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);

    const recovered = "/_next/static/chunks/after-read-failures-abc123.js";
    await worker.fire("fetch", worker.request(recovered));
    expect(worker.stores.get(STATIC_CACHE)?.has(`${ORIGIN}${recovered}`)).toBe(true);
  });

  it("releases readers and restores both copy slots after bounded read timeouts", async () => {
    vi.useFakeTimers();
    const readers: SyntheticReader[] = [];
    const worker = load(async (request) => {
      if (!new URL(request.url).pathname.includes("stalled")) return basic("recovered");
      const reader: SyntheticReader = {
        read: vi.fn<SyntheticReader["read"]>(() => new Promise(() => undefined)),
        cancel: vi.fn(() => new Promise(() => undefined)),
        releaseLock: vi.fn(),
      };
      readers.push(reader);
      return withCacheReader("online despite stalled copy", reader).response;
    });
    const paths = ["/_next/static/chunks/stalled-a.js", "/_next/static/chunks/stalled-b.js"];
    const pending = paths.map((path) => worker.fire("fetch", worker.request(path)));
    await waitFor(() => readers.length === 2 && readers.every((reader) => vi.mocked(reader.read).mock.calls.length === 1));
    await vi.advanceTimersByTimeAsync(5_001);
    const results = await Promise.all(pending);
    expect(results.every((result) => result.response?.status === 200)).toBe(true);
    expect(readers.every((reader) => vi.mocked(reader.releaseLock).mock.calls.length === 1)).toBe(true);
    expect(paths.every((path) => !worker.stores.get(STATIC_CACHE)?.has(`${ORIGIN}${path}`))).toBe(true);

    const recovered = "/_next/static/chunks/after-timeouts-abc123.js";
    await worker.fire("fetch", worker.request(recovered));
    expect(worker.stores.get(STATIC_CACHE)?.has(`${ORIGIN}${recovered}`)).toBe(true);
  });
});
