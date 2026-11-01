// editor.niho.life の service worker（#49）。「殻」だけ:
//  - アプリの読み込みを速くするため、内容のハッシュが名前に入った静的ファイル（/_next/static/）を手元に置く。
//  - 圏外でページを開いたとき、白画面ではなく「つながっていません」（/offline.html）を出す。
// やらないこと: ページの HTML・/api・認証の絡む応答のキャッシュ（別のアカウントの内容を残さない・古い内容を見せない）、
// オフライン編集（別 Issue）。GET 以外と別 origin の要求には触らない。
const VERSION = "v1";
const SHELL_CACHE = `niho-editor-shell-${VERSION}`;
const STATIC_CACHE = `niho-editor-static-${VERSION}`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png"];
const STATIC_PREFIX = "/_next/static/";
const STATIC_LIMIT = 200;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  // 版が変わったら自分の古いcacheだけを捨てる（写真PWA等の別namespaceを保持）
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith("niho-editor-") && name !== SHELL_CACHE && name !== STATIC_CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    // つながらなかったときだけ「つながっていません」。サーバーが返したもの（401・404・5xx を含む）はそのまま見せる
    event.respondWith(fetch(request).catch(() => caches.open(SHELL_CACHE).then((cache) => cache.match(OFFLINE_URL))));
    return;
  }
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.open(SHELL_CACHE).then((cache) => cache.match(request).then((hit) => hit ?? fetch(request))));
    return;
  }
  if (url.pathname.startsWith(STATIC_PREFIX)) {
    event.respondWith(staticAsset(request));
  }
});

async function staticAsset(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    // キャッシュは best-effort。端末の保存容量が足りない（QuotaExceededError）などで書けなくても、取得できた応答は返す
    // （ここで投げると respondWith が失敗し、オンラインなのに JS・CSS が読めない）
    try {
      await cache.put(request, response.clone());
      await trim(cache);
    } catch {
      // 書けなかった・片付けられなかった。次の要求でまた試す
    }
  }
  return response;
}

// 古いものから捨てて、増え続けないようにする
async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - STATIC_LIMIT))) await cache.delete(key);
}
