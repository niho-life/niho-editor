// 本番の起動の守り（#47）。`npm run build` の後に `npm run test:startup` で動かす。
// NODE_ENV=production で EDITOR_AUTH_MODE が niho でも（許可リストのある）google でもなければ（未設定を含む）、
// stub へ落とさずに起動が失敗し、port を開かないこと。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { request as httpRequest } from "node:http";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const standaloneServer = ".next/standalone/server.js";
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

if (!existsSync(new URL(`../${standaloneServer}`, import.meta.url))) {
  throw new Error("No production build found. Run `npm run build` before `npm run test:startup`.");
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function childEnv(port, mode) {
  const env = { ...process.env, NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", NEXT_TELEMETRY_DISABLED: "1" };
  delete env.EDITOR_AUTH_MODE;
  delete env.DATABASE_URL;
  // google の許可リストは渡さない（#47 google: 空なら起動しない）
  delete env.EDITOR_GOOGLE_ALLOWED_EMAILS;
  // 親processの実設定を合成testへ持ち込まず、Googleへ接続しない。
  delete env.EDITOR_GOOGLE_CLIENT_ID;
  delete env.GOOGLE_OAUTH_CLIENT_SECRET;
  delete env.EDITOR_NIHO_ORIGIN;
  delete env.EDITOR_ORIGIN;
  if (mode !== undefined) env.EDITOR_AUTH_MODE = mode;
  if (mode === "niho") env.EDITOR_NIHO_ORIGIN = "https://niho-auth.example.invalid";
  return env;
}

/** 子プロセスを起動し、終わるまで（最大 timeoutMs）port に繋がるかを見張る。 */
async function runUntilExit(args, env, port, timeoutMs = 30_000) {
  const child = spawn(process.execPath, args, { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let opened = false;
  let done = false;
  const watch = (async () => {
    while (!done) {
      if (await canConnect(port)) opened = true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const result = await exited;
  done = true;
  clearTimeout(timer);
  await watch;
  return { ...result, opened, output };
}

async function waitForHttp(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${port}/api/pages`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("server did not answer in time");
}

describe("production start with the server entry (Dockerfile / npm start)", () => {
  for (const [label, mode] of [
    ["EDITOR_AUTH_MODE=stub", "stub"],
    ["EDITOR_AUTH_MODE unset", undefined],
    ["EDITOR_AUTH_MODE empty", ""],
    ["EDITOR_AUTH_MODE=STUB", "STUB"],
    // google は許可リストが空だと起動しない（設定の誤りで誰でも入れる状態にしない。#47 google）
    ["EDITOR_AUTH_MODE=google without an allowlist", "google"],
  ]) {
    it(`refuses to start and never opens the port with ${label}`, async () => {
      const port = await freePort();
      const result = await runUntilExit(["scripts/server-entry.mjs", standaloneServer], childEnv(port, mode), port);
      assert.notEqual(result.code, 0, result.output);
      assert.equal(result.signal, null, "it must exit by itself, not by the test timeout");
      assert.equal(result.opened, false, "the port must stay closed");
      assert.match(result.output, /refusing to start/);
      assert.doesNotMatch(result.output, /Ready in/);
    });
  }

  it("starts with configured EDITOR_AUTH_MODE=niho and answers 401 without a session", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ["scripts/server-entry.mjs", standaloneServer], { cwd: appDir, env: childEnv(port, "niho"), stdio: "ignore" });
    try {
      const response = await waitForHttp(port);
      assert.equal(response.status, 401);
      assert.equal(await response.text(), '{"error":"unauthorized"}');
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
      const home = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(new URL(home.url).pathname, "/auth/login", "an unauthenticated visit ends on the login screen");
      assert.equal(home.headers.get("x-robots-tag"), "noindex, nofollow");
      const html = await home.text();
      assert.match(html, /<meta name="robots" content="noindex, nofollow"\/>/);
      assert.doesNotMatch(html, /data-auth-mode="stub"/);
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("accepts NIHO form POST through standalone internal URLs with the public Host and preserves the handler CSP", async () => {
    const port = await freePort();
    const editorOrigin = "https://editor.example.invalid";
    const nihoOrigin = "https://niho-auth.example.invalid";
    const env = { ...childEnv(port, "niho"), HOSTNAME: "0.0.0.0", EDITOR_ORIGIN: editorOrigin };
    const child = spawn(process.execPath, ["scripts/server-entry.mjs", standaloneServer], { cwd: appDir, env, stdio: "ignore" });
    try {
      await waitForHttp(port);
      const post = (overrides = {}, suffix = "") => new Promise((resolve, reject) => {
        // Node fetchはHostを上書きしない。実HTTPクライアントで公開Hostと内部URLの差を再現する。
        const request = httpRequest(`http://127.0.0.1:${port}/auth/callback${suffix}`, {
          method: "POST",
          headers: { host: new URL(editorOrigin).host, origin: nihoOrigin, "x-forwarded-proto": "https", "content-type": "application/x-www-form-urlencoded", ...overrides },
        }, response => {
          const chunks = [];
          response.on("data", chunk => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const pairs = [];
            for (let i = 0; i < response.rawHeaders.length; i += 2) pairs.push([response.rawHeaders[i], response.rawHeaders[i + 1]]);
            resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: pairs }));
          });
        });
        request.on("error", reject);
        request.end(`code=${"c".repeat(43)}&state=${"s".repeat(43)}`);
      });
      const relay = await post();
      assert.equal(relay.status, 200);
      assert.equal(relay.headers.get("set-cookie"), null);
      assert.equal(relay.headers.get("referrer-policy"), "origin");
      assert.match(relay.headers.get("cache-control") ?? "", /no-store/);
      const csp = relay.headers.get("content-security-policy") ?? "";
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
      assert.ok(nonce);
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /form-action 'self'/);
      assert.doesNotMatch(csp, /strict-dynamic/);
      const html = await relay.text();
      assert.ok(html.includes(`<script nonce="${nonce}">`));
      assert.ok(html.includes(`action="${editorOrigin}/auth/callback"`));
      assert.doesNotMatch(html, /0\.0\.0\.0|verifier|credential/);
      assert.equal((await post({ host: "other.example.invalid", "x-forwarded-host": new URL(editorOrigin).host })).status, 400);
      assert.equal((await post({ origin: "null" })).status, 400);
      assert.equal((await post({}, "?code=legacy")).status, 400);
      const sameOrigin = await post({ origin: editorOrigin });
      assert.equal(sameOrigin.status, 303, "same-origin callback reaches pending/state validation instead of rejecting the internal URL");
      assert.equal(sameOrigin.headers.get("set-cookie"), null);
      assert.equal((await fetch(`http://127.0.0.1:${port}/auth/callback`, { redirect: "manual" })).status, 405);
    } finally {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
  });

  it("keeps Google as the Docs provider while routing only photo callback POST to NIHO", async () => {
    const port = await freePort();
    const editorOrigin = "https://editor.example.invalid";
    const nihoOrigin = "https://niho-auth.example.invalid";
    const env = {
      ...childEnv(port, "google"),
      HOSTNAME: "0.0.0.0",
      EDITOR_GOOGLE_ALLOWED_EMAILS: "synthetic-owner@example.invalid",
      EDITOR_NIHO_ORIGIN: nihoOrigin,
      EDITOR_ORIGIN: editorOrigin,
    };
    const child = spawn(process.execPath, ["scripts/server-entry.mjs", standaloneServer], { cwd: appDir, env, stdio: "ignore" });
    const requestWithPublicHost = (path, { method = "GET", origin, body } = {}) => new Promise((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          host: new URL(editorOrigin).host,
          "x-forwarded-proto": "https",
          ...(origin ? { origin } : {}),
          ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
      }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const pairs = [];
          for (let i = 0; i < response.rawHeaders.length; i += 2) pairs.push([response.rawHeaders[i], response.rawHeaders[i + 1]]);
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: pairs }));
        });
      });
      request.on("error", reject);
      request.end(body);
    });
    try {
      await waitForHttp(port);
      const relay = await requestWithPublicHost("/auth/callback", {
        method: "POST",
        origin: nihoOrigin,
        body: `code=${"c".repeat(43)}&state=${"s".repeat(43)}`,
      });
      assert.equal(relay.status, 200);
      assert.equal(relay.headers.get("set-cookie"), null);
      assert.equal(relay.headers.get("referrer-policy"), "origin");
      assert.match(relay.headers.get("content-security-policy") ?? "", /form-action 'self'/);
      assert.match(await relay.text(), new RegExp(`action="${editorOrigin}/auth/callback"`));

      const googleGet = await requestWithPublicHost("/auth/callback?code=synthetic&state=synthetic");
      assert.equal(googleGet.status, 303);
      assert.equal(googleGet.headers.get("location"), "/auth/login?error=unavailable");
      assert.equal(googleGet.headers.get("set-cookie")?.includes("__Host-editor-niho"), false);
    } finally {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
  });

  it("keeps an unconfigured scoped start closed without contacting a provider and preserves exact auth headers", async () => {
    const port = await freePort();
    const env = {
      ...childEnv(port, "google"),
      EDITOR_GOOGLE_ALLOWED_EMAILS: "synthetic-owner@example.invalid",
      EDITOR_ORIGIN: "https://editor.example.invalid",
    };
    const child = spawn(process.execPath, ["scripts/server-entry.mjs", standaloneServer], { cwd: appDir, env, stdio: "ignore" });
    try {
      await waitForHttp(port);
      const start = await fetch(`http://127.0.0.1:${port}/photo/auth/start?next=%2Fphoto%2Ftrash`, { redirect: "manual" });
      assert.equal(start.status, 303);
      assert.equal(start.headers.get("location"), "/photo/auth/login?next=%2Fphoto%2Ftrash&error=unavailable");
      assert.equal(start.headers.get("set-cookie"), null);
      assert.equal(start.headers.get("referrer-policy"), "origin");
      assert.equal(start.headers.get("content-security-policy"), null);
      const login = await fetch(`http://127.0.0.1:${port}/photo/auth/login`, { redirect: "manual" });
      assert.equal(login.headers.get("referrer-policy"), "same-origin");
      assert.match(login.headers.get("content-security-policy") ?? "", /'nonce-[^']+'/);
      const loginHtml = await login.text();
      assert.match(loginHtml, /<title>ログイン · NIHO photo<\/title>/);
      assert.match(loginHtml, /rel="manifest"[^>]*href="\/photo\/manifest.webmanifest"/);
      const photoManifest = await fetch(`http://127.0.0.1:${port}/photo/manifest.webmanifest`);
      assert.equal(photoManifest.status, 200);
      const photoManifestBody = await photoManifest.json();
      const { id, name, start_url, scope } = photoManifestBody;
      assert.deepEqual({ id, name, start_url, scope }, {
        id: "/photo", name: "NIHO photo", start_url: "/photo", scope: "/photo",
      });
      const sharedTokens = readFileSync(new URL("../../../packages/ui/src/styles/editor-tokens.css", import.meta.url), "utf8");
      const canvasColor = /^\s*--ed-canvas:\s*([^;]+);/m.exec(sharedTokens)?.[1];
      assert.ok(canvasColor);
      assert.equal(photoManifestBody.theme_color, canvasColor);
      assert.equal(photoManifestBody.background_color, canvasColor);
      const docsManifest = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
      assert.equal(docsManifest.status, 200);
      assert.deepEqual(await docsManifest.json().then(({ id, name, scope }) => ({ id, name, scope })), {
        id: "/", name: "NIHO editor", scope: "/",
      });
      const photoWorker = await fetch(`http://127.0.0.1:${port}/photo-sw.js`);
      assert.equal(photoWorker.status, 200);
      assert.match(photoWorker.headers.get("cache-control") ?? "", /no-cache/);
      assert.match(await photoWorker.text(), /niho-photo-static-v1/);
      const photoSession = await fetch(`http://127.0.0.1:${port}/api/photo/v1/auth/session`);
      assert.equal(photoSession.status, 503);
      assert.equal(photoSession.headers.get("referrer-policy"), "no-referrer");
      assert.match(photoSession.headers.get("cache-control") ?? "", /no-store/);
    } finally {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }
  });

  it("sends a nonce-based CSP on pages, and every <script> carries that request's nonce (#44)", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ["scripts/server-entry.mjs", standaloneServer], { cwd: appDir, env: childEnv(port, "niho"), stdio: "ignore" });
    try {
      await waitForHttp(port);
      const fetchHome = async () => {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        return { csp: response.headers.get("content-security-policy") ?? "", hsts: response.headers.get("strict-transport-security"), html: await response.text() };
      };
      const first = await fetchHome();
      const second = await fetchHome();
      const nonceOf = (policy) => /'nonce-([^']+)'/.exec(policy)?.[1];
      const nonce = nonceOf(first.csp);
      assert.ok(nonce, "the policy must carry a nonce");
      assert.notEqual(nonce, nonceOf(second.csp), "the nonce must change on every request");
      const scriptSrc = first.csp.split("; ").find((part) => part.startsWith("script-src ")) ?? "";
      assert.match(scriptSrc, /'strict-dynamic'/);
      assert.doesNotMatch(scriptSrc, /'unsafe-inline'|'unsafe-eval'/);
      assert.match(first.csp, /frame-ancestors 'none'/);
      assert.match(first.csp, /upgrade-insecure-requests/);
      const scripts = [...first.html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
      assert.ok(scripts.length > 0, "the page must have scripts for this check to mean anything");
      for (const tag of scripts) assert.ok(tag.includes(`nonce="${nonce}"`), `a <script> without this request's nonce: ${tag.slice(0, 80)}`);
      assert.equal(first.hsts, "max-age=31536000; includeSubDomains");
      // API は JSON だけ: 何も読み込まない固定の CSP
      const api = await fetch(`http://127.0.0.1:${port}/api/pages`);
      assert.equal(api.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("serves the manifest, icons, service worker and offline page, all noindex (#49)", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ["scripts/server-entry.mjs", standaloneServer], { cwd: appDir, env: childEnv(port, "niho"), stdio: "ignore" });
    try {
      await waitForHttp(port);
      const get = (path) => fetch(`http://127.0.0.1:${port}${path}`);
      const manifestResponse = await get("/manifest.webmanifest");
      assert.equal(manifestResponse.status, 200);
      assert.match(manifestResponse.headers.get("content-type") ?? "", /json/);
      assert.equal(manifestResponse.headers.get("x-robots-tag"), "noindex, nofollow");
      const manifest = await manifestResponse.json();
      assert.equal(manifest.display, "standalone");
      assert.equal(manifest.start_url, "/");
      for (const icon of manifest.icons) {
        const response = await get(icon.src);
        assert.equal(response.status, 200, icon.src);
        assert.equal(response.headers.get("content-type"), "image/png", icon.src);
      }

      const worker = await get("/sw.js");
      assert.equal(worker.status, 200);
      assert.match(worker.headers.get("content-type") ?? "", /javascript/);
      assert.equal(worker.headers.get("cache-control"), "no-cache, must-revalidate");
      assert.equal(worker.headers.get("x-robots-tag"), "noindex, nofollow");
      assert.match(await worker.text(), /niho-editor-shell-/);

      const offline = await get("/offline.html");
      assert.equal(offline.status, 200);
      assert.equal(offline.headers.get("x-robots-tag"), "noindex, nofollow");
      assert.match(await offline.text(), /つながっていません/);

      const html = await (await get("/")).text();
      assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
      assert.match(html, /rel="apple-touch-icon"/);
      assert.match(html, /<meta name="robots" content="noindex, nofollow"\/>/);
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("serves /s/{token} with private, no-store and a single no-referrer, and answers without a database (#34)", async () => {
    // `next dev` はページの Cache-Control を開発用の値に置き換えるので、本番の header はここ（standalone）で確かめる
    const port = await freePort();
    const child = spawn(process.execPath, ["scripts/server-entry.mjs", standaloneServer], { cwd: appDir, env: childEnv(port, "niho"), stdio: "ignore" });
    try {
      await waitForHttp(port);
      const malformed = await fetch(`http://127.0.0.1:${port}/s/not-a-token`);
      const wellFormed = await fetch(`http://127.0.0.1:${port}/s/${"A".repeat(43)}`);
      // 形の違う token は DB に問い合わせずに 404。DB が無いときの正しい形の token は汎用の 500（止めたリンクと見分けがつかない 404 にしない）
      assert.equal(malformed.status, 404);
      assert.match(await malformed.text(), /ページが見つかりません/);
      assert.equal(wellFormed.status, 500);
      assert.doesNotMatch(await wellFormed.text(), /SELECT|page_shares|DATABASE_URL|shared page is unavailable/);
      for (const response of [malformed, wellFormed]) {
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert.equal(response.headers.get("referrer-policy"), "no-referrer");
        assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
      }
      // 他の route は全体の規則のまま
      const home = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(home.headers.get("referrer-policy"), "same-origin");
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("serves the public API /v1 with the contract's headers, not the catch-all ones (#40)", async () => {
    // Next は同じ名前の header が config にあると route の値を捨てるので、本番の server で値が契約どおりかを確かめる（DB が無いので 503）
    const port = await freePort();
    const child = spawn(process.execPath, ["scripts/server-entry.mjs", standaloneServer], { cwd: appDir, env: childEnv(port, "niho"), stdio: "ignore" });
    try {
      await waitForHttp(port);
      const list = await fetch(`http://127.0.0.1:${port}/v1/exp/published.json`, { headers: { authorization: `Bearer ek_${"A".repeat(42)}Q` } });
      assert.equal(list.status, 503);
      assert.equal(list.headers.get("x-robots-tag"), "noindex");
      assert.equal(list.headers.get("cache-control"), "no-store");
      assert.equal(list.headers.get("content-type"), "application/json; charset=utf-8");
      // Next は App Router の全応答の Vary に自分の header（rsc など）を足す。契約の Authorization が含まれることだけを確かめる
      assert.match(list.headers.get("vary") ?? "", /(^|, )Authorization(,|$)/);
      const body = await list.json();
      assert.equal(body.error.code, "temporarily_unavailable");
      assert.match(body.error.requestId, /^req_/);
      const options = await fetch(`http://127.0.0.1:${port}/v1/exp/published.json`, { method: "OPTIONS" });
      assert.equal(options.status, 400);
      assert.equal(options.headers.get("allow"), "GET, HEAD");
    } finally {
      child.kill("SIGTERM");
    }
  });
});

describe("production start without the entry (defence in depth)", () => {
  it("standalone server.js exits non-zero with EDITOR_AUTH_MODE=stub", async () => {
    const port = await freePort();
    const result = await runUntilExit([standaloneServer], childEnv(port, "stub"), port);
    assert.notEqual(result.code, 0, result.output);
    assert.equal(result.signal, null);
    assert.match(result.output, /refusing to start/);
  });

  it("`next start` exits non-zero with EDITOR_AUTH_MODE unset", async () => {
    const port = await freePort();
    const result = await runUntilExit([nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], childEnv(port, undefined), port);
    assert.notEqual(result.code, 0, result.output);
    assert.equal(result.signal, null);
    assert.match(result.output, /refusing to start/);
  });
});

describe("production start with the asset storage settings (#36)", () => {
  function storageEnv(port, storage, bucket) {
    const env = childEnv(port, "niho");
    delete env.EDITOR_STORAGE;
    delete env.EDITOR_ASSETS_BUCKET;
    if (storage !== undefined) env.EDITOR_STORAGE = storage;
    if (bucket !== undefined) env.EDITOR_ASSETS_BUCKET = bucket;
    return env;
  }

  // 保存先の検査は src/startup-check.ts（instrumentation）で行う。入口（server-entry.mjs）は認証だけを見るので、port を開く前に止まるとは限らない
  for (const [label, storage, bucket, message] of [
    ["EDITOR_STORAGE=fake", "fake", undefined, /refusing to start: EDITOR_STORAGE=fake is not allowed when NODE_ENV=production/],
    ["EDITOR_STORAGE=gcs without a bucket", "gcs", undefined, /refusing to start: EDITOR_ASSETS_BUCKET is required/],
    ["EDITOR_STORAGE=gcs with an invalid bucket", "gcs", "Not_A_Bucket", /refusing to start: EDITOR_ASSETS_BUCKET is not a valid bucket name/],
    ["an unknown EDITOR_STORAGE", "memory", undefined, /refusing to start: EDITOR_STORAGE must be one of/],
  ]) {
    it(`refuses to start with ${label}, without printing the value`, async () => {
      const port = await freePort();
      const result = await runUntilExit(["scripts/server-entry.mjs", standaloneServer], storageEnv(port, storage, bucket), port);
      assert.notEqual(result.code, 0, result.output);
      assert.equal(result.signal, null, "it must exit by itself, not by the test timeout");
      assert.match(result.output, message);
      assert.doesNotMatch(result.output, /Not_A_Bucket/);
    });
  }

  for (const [label, storage] of [["EDITOR_STORAGE unset", undefined], ["EDITOR_STORAGE=off", "off"]]) {
    it(`starts with ${label}, and the dev fake storage route is 404`, async () => {
      const port = await freePort();
      const child = spawn(process.execPath, ["scripts/server-entry.mjs", standaloneServer], { cwd: appDir, env: storageEnv(port, storage), stdio: "ignore" });
      try {
        const response = await waitForHttp(port);
        assert.equal(response.status, 401);
        const fake = await fetch(`http://127.0.0.1:${port}/api/dev/fake-storage/${"A".repeat(43)}`, { method: "PUT", body: "x" });
        assert.equal(fake.status, 404);
        assert.equal(await fake.text(), '{"error":"not_found"}');
        const limits = await fetch(`http://127.0.0.1:${port}/api/recordings/audio/limits`);
        assert.equal(limits.status, 401);
        assert.equal(limits.headers.get("x-robots-tag"), "noindex, nofollow");
      } finally {
        child.kill("SIGTERM");
      }
    });
  }
});

describe("production start with the transcription settings (#36 段 2b)", () => {
  function transcribeEnv(port, engine, key) {
    const env = childEnv(port, "niho");
    for (const name of ["EDITOR_TRANSCRIBE_ENGINE", "DEEPGRAM_API_KEY", "EDITOR_TRANSCRIBE_TIMEOUT_SEC", "EDITOR_TRANSCRIBE_FAKE_FAIL", "EDITOR_STORAGE", "EDITOR_ASSETS_BUCKET"]) delete env[name];
    if (engine !== undefined) env.EDITOR_TRANSCRIBE_ENGINE = engine;
    if (key !== undefined) env.DEEPGRAM_API_KEY = key;
    return env;
  }

  // 文字起こしの検査も src/startup-check.ts（instrumentation）で行う。入口（server-entry.mjs）は認証だけを見る
  for (const [label, engine, key, message] of [
    ["EDITOR_TRANSCRIBE_ENGINE=fake", "fake", undefined, /refusing to start: EDITOR_TRANSCRIBE_ENGINE=fake is not allowed when NODE_ENV=production/],
    ["EDITOR_TRANSCRIBE_ENGINE=deepgram without a key", "deepgram", undefined, /refusing to start: DEEPGRAM_API_KEY is required/],
    ["EDITOR_TRANSCRIBE_ENGINE=deepgram with a malformed key", "deepgram", "test key not secret", /refusing to start: DEEPGRAM_API_KEY is not a valid key/],
    ["an unknown EDITOR_TRANSCRIBE_ENGINE", "whisper", undefined, /refusing to start: EDITOR_TRANSCRIBE_ENGINE must be one of/],
  ]) {
    it(`refuses to start with ${label}, without printing the value`, async () => {
      const port = await freePort();
      const result = await runUntilExit(["scripts/server-entry.mjs", standaloneServer], transcribeEnv(port, engine, key), port);
      assert.notEqual(result.code, 0, result.output);
      assert.equal(result.signal, null, "it must exit by itself, not by the test timeout");
      assert.match(result.output, message);
      assert.doesNotMatch(result.output, /test key not secret/);
    });
  }

  for (const [label, engine] of [["EDITOR_TRANSCRIBE_ENGINE unset", undefined], ["EDITOR_TRANSCRIBE_ENGINE=off", "off"]]) {
    it(`starts with ${label}, and the transcription routes answer 401 without a session`, async () => {
      const port = await freePort();
      const child = spawn(process.execPath, ["scripts/server-entry.mjs", standaloneServer], { cwd: appDir, env: transcribeEnv(port, engine), stdio: "ignore" });
      try {
        const response = await waitForHttp(port);
        assert.equal(response.status, 401);
        const id = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
        const start = await fetch(`http://127.0.0.1:${port}/api/pages/${id}/recording/transcribe`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
          body: "{}",
        });
        assert.equal(start.status, 401);
        assert.equal(start.headers.get("x-robots-tag"), "noindex, nofollow");
        const status = await fetch(`http://127.0.0.1:${port}/api/pages/${id}/recording/transcription`);
        assert.equal(status.status, 401);
        assert.equal(status.headers.get("cache-control"), "private, no-store");
      } finally {
        child.kill("SIGTERM");
      }
    });
  }
});
