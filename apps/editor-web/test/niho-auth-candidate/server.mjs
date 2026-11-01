import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHandler } from "./app.mjs";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const REQUEST_BODY_TIMEOUT_MS = 2_000;

class RequestBodyError extends Error {
  constructor(status) {
    super("request body rejected");
    this.status = status;
  }
}

function readIncomingBody(incoming) {
  if (incoming.method === "GET" || incoming.method === "HEAD") return Promise.resolve(undefined);
  const declared = incoming.headers["content-length"];
  if (typeof declared === "string" && /^\d+$/.test(declared) && Number(declared) > MAX_REQUEST_BODY_BYTES) {
    incoming.resume();
    return Promise.reject(new RequestBodyError(413));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      incoming.off("data", onData);
      incoming.off("end", onEnd);
      incoming.off("error", onError);
      incoming.off("aborted", onAborted);
      if (error) reject(error);
      else resolve(result);
    };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        incoming.resume();
        finish(undefined, new RequestBodyError(413));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(Buffer.concat(chunks, bytes));
    const onError = () => finish(undefined, new RequestBodyError(400));
    const onAborted = () => finish(undefined, new RequestBodyError(400));
    const timeout = setTimeout(() => {
      incoming.resume();
      finish(undefined, new RequestBodyError(408));
    }, REQUEST_BODY_TIMEOUT_MS);
    incoming.on("data", onData);
    incoming.once("end", onEnd);
    incoming.once("error", onError);
    incoming.once("aborted", onAborted);
  });
}

export function createAcceptanceServer(handler, origin) {
  const server = createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    const onIncomingAborted = () => abort.abort();
    const onOutgoingClose = () => {
      if (!outgoing.writableFinished) abort.abort();
    };
    incoming.once("aborted", onIncomingAborted);
    outgoing.once("close", onOutgoingClose);
    try {
      const body = await readIncomingBody(incoming);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const request = new Request(new URL(incoming.url, origin), {
        method: incoming.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: abort.signal,
        ...(body === undefined ? {} : { duplex: "half" }),
      });
      const response = await handler(request);
      outgoing.statusCode = response.status;
      for (const [name, value] of response.headers) if (name !== "set-cookie") outgoing.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("set-cookie", cookies);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (error instanceof RequestBodyError) {
        if (!outgoing.headersSent) outgoing.writeHead(error.status);
        outgoing.end();
        return;
      }
      console.error("NIHO auth acceptance request failed");
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    } finally {
      incoming.off("aborted", onIncomingAborted);
      outgoing.off("close", onOutgoingClose);
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
  const handler = createHandler(process.env, manifest);
  createAcceptanceServer(handler, process.env.EDITOR_ORIGIN).listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
}
