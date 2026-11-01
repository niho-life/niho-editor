// NIHO photo の PWA 基盤。個人の写真・HTML・API・認証応答は保存せず、
// Next が public + immutable として配る同一 origin の静的 JS/CSS/font だけを保存する。
const PHOTO_CACHE_PREFIX = "niho-photo-";
const STATIC_CACHE = "niho-photo-static-v1";
const STATIC_PREFIX = "/_next/static/";
const CACHE_BYTES_HEADER = "x-niho-photo-cache-bytes";
const MAX_ENTRIES = 128;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVE_CACHE_COPIES = 2;
const BODY_READ_TIMEOUT_MS = 5_000;

let cacheMutation = Promise.resolve();
let activeCacheCopies = 0;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name.startsWith(PHOTO_CACHE_PREFIX) && name !== STATIC_CACHE).map((name) => caches.delete(name))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (!isStaticRequest(request)) return;

  const work = staticAsset(request);
  event.respondWith(work.then(({ response }) => response));
  event.waitUntil(work.then(({ cacheWork }) => cacheWork).catch(() => undefined));
});

function isStaticRequest(request) {
  if (request.method !== "GET" || request.mode === "navigate") return false;
  if (request.cache === "no-store" || request.cache === "reload") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(STATIC_PREFIX) || url.search || url.hash) return false;
  return !request.headers.has("authorization");
}

async function staticAsset(request) {
  let cache = null;
  try {
    cache = await caches.open(STATIC_CACHE);
    const hit = await cache.match(request.url);
    if (hit && isSafeCachedResponse(hit)) return { response: withoutInternalMetadata(hit), cacheWork: Promise.resolve() };
    if (hit) await enqueueCacheMutation(() => cache.delete(request.url)).catch(() => undefined);
  } catch {
    // Cache API が利用不能でも、下の credential-free network fetch は続ける。
  }

  // Cookie や HTTP auth を静的 CDN path へ転送しない。redirect も応答として受け取らない。
  const networkRequest = new Request(request, { credentials: "omit", redirect: "error" });
  const response = await fetch(networkRequest);
  if (!cache || !isCacheableStaticResponse(response)) return { response, cacheWork: Promise.resolve() };

  const cacheWork = cacheResponseWithinCapacity(response, cache, request.url);
  return { response, cacheWork };
}

function cacheResponseWithinCapacity(response, cache, url) {
  // clone 済みの tee を待ち行列に置くと、その間に body が無制限にbufferされ得る。
  // 空きがない要求は clone 自体を作らず、今回のbest-effort cacheだけを見送る。
  if (activeCacheCopies >= MAX_ACTIVE_CACHE_COPIES) return Promise.resolve();
  activeCacheCopies += 1;

  return (async () => {
    try {
      const copy = response.clone();
      const prepared = await boundedCacheResponse(copy);
      if (prepared) await enqueueCacheMutation(() => storeWithinBudget(cache, url, prepared));
    } finally {
      activeCacheCopies -= 1;
    }
  })().catch(() => undefined);
}

function isCacheableStaticResponse(response) {
  return response.status === 200 && response.type === "basic" && !response.redirected && hasSafeStaticHeaders(response);
}

function isSafeCachedResponse(response) {
  const bytes = metadataBytes(response.headers.get(CACHE_BYTES_HEADER));
  return response.status === 200 && !response.redirected && bytes !== null && bytes <= MAX_ASSET_BYTES && hasSafeStaticHeaders(response);
}

function hasSafeStaticHeaders(response) {
  const cacheControl = response.headers.get("cache-control")?.toLowerCase() ?? "";
  const directives = cacheControl.split(",").map((part) => part.trim().split("=", 1)[0]);
  if (!directives.includes("public") || !directives.includes("immutable") || directives.includes("private") || directives.includes("no-store")) return false;
  if (response.headers.has("set-cookie")) return false;

  const vary = (response.headers.get("vary") ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (vary.some((name) => name === "*" || name === "cookie" || name === "authorization")) return false;

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return new Set([
    "text/css",
    "text/javascript",
    "application/javascript",
    "application/ecmascript",
    "font/woff",
    "font/woff2",
    "application/font-woff",
    "application/vnd.ms-fontobject",
  ]).has(contentType);
}

async function boundedCacheResponse(response) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  let stopped = false;
  let timer = null;

  const stop = () => {
    stopped = true;
    // 壊れた stream の cancel 自体が止まることがあるため、完了は待たない。
    try {
      Promise.resolve(reader.cancel()).catch(() => undefined);
    } catch {
      // cancel できなくても、この cache 処理だけを諦める。
    }
  };

  const read = async () => {
    const chunks = [];
    let bytes = 0;
    while (!stopped) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value) continue;
      bytes += part.value.byteLength;
      if (bytes > MAX_ASSET_BYTES) {
        stop();
        return null;
      }
      chunks.push(part.value);
    }
    if (stopped) return null;

    const headers = new Headers(response.headers);
    headers.set(CACHE_BYTES_HEADER, String(bytes));
    return { bytes, response: new Response(new Blob(chunks), { status: response.status, statusText: response.statusText, headers }) };
  };

  try {
    // timeout が先でも後から起きる read rejection を未処理にしない。
    const reading = read().catch(() => null);
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        stop();
        resolve(null);
      }, BODY_READ_TIMEOUT_MS);
    });
    return await Promise.race([reading, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      // cancel/read がまだsettleしていない実装でも、network responseは壊さない。
    }
  }
}

function enqueueCacheMutation(mutation) {
  const next = cacheMutation.catch(() => undefined).then(mutation);
  cacheMutation = next.catch(() => undefined);
  return next;
}

async function storeWithinBudget(cache, url, prepared) {
  // 同時 miss が同じ URL を取得していても、先に保存した方を上書きしない。
  if (await cache.match(url)) return;

  const keys = await cache.keys();
  const entries = [];
  let totalBytes = 0;
  for (const key of keys) {
    const cached = await cache.match(key);
    const bytes = cached ? metadataBytes(cached.headers.get(CACHE_BYTES_HEADER)) : null;
    if (bytes === null || bytes > MAX_ASSET_BYTES) {
      await cache.delete(key);
      continue;
    }
    entries.push({ key, bytes });
    totalBytes += bytes;
  }

  while (entries.length + 1 > MAX_ENTRIES || totalBytes + prepared.bytes > MAX_TOTAL_BYTES) {
    const oldest = entries.shift();
    if (!oldest) return;
    await cache.delete(oldest.key);
    totalBytes -= oldest.bytes;
  }
  await cache.put(url, prepared.response);
}

function metadataBytes(value) {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function withoutInternalMetadata(response) {
  const headers = new Headers(response.headers);
  headers.delete(CACHE_BYTES_HEADER);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
