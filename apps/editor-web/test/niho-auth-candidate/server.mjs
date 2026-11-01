import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHandler } from "./app.mjs";

export function createAcceptanceServer(handler, origin) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      let bytes = 0;
      for await (const chunk of incoming) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) { outgoing.writeHead(413); outgoing.end(); return; }
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const request = new Request(new URL(incoming.url, origin), { method: incoming.method, headers });
      const response = await handler(request);
      outgoing.statusCode = response.status;
      for (const [name, value] of response.headers) if (name !== "set-cookie") outgoing.setHeader(name, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("set-cookie", cookies);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      console.error("NIHO auth acceptance request failed");
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
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
