import { lookup as systemLookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as http from "node:http";
import * as https from "node:https";
import type { LookupAddress } from "node:dns";
import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { SAMPLE_MAX_CHARS } from "@niho/docs-core";

export const RECIPE_SAMPLE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const RECIPE_SAMPLE_URL_MAX_BYTES = 8 * 1024 * 1024;
export const RECIPE_SAMPLE_FETCH_TIMEOUT_MS = 10_000;
export const RECIPE_SAMPLE_MAX_REDIRECTS = 3;
export const RECIPE_SAMPLE_MAX_PDF_PAGES = 200;

export type RecipeSampleImportErrorCode = "bad_request" | "unsupported_type" | "too_large" | "unsafe_url" | "fetch_failed" | "timeout" | "invalid_document";

export class RecipeSampleImportError extends Error {
  constructor(readonly code: RecipeSampleImportErrorCode) {
    super(code);
    this.name = "RecipeSampleImportError";
  }
}

export type ImportedSampleText = { text: string; chars: number; truncatedFrom?: number };
type PublicAddress = { address: string; family: number };
type UrlResponse = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };
type UrlRequest = (url: URL, address: PublicAddress, maxBytes: number, timeoutMs: number) => Promise<UrlResponse>;
type AddressLookup = (hostname: string) => Promise<LookupAddress[]>;

function ipv4Bytes(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const bytes = address.split(".").map(Number);
  return bytes.length === 4 && bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : null;
}

function inIpv4Range(bytes: number[], network: number[], prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xff << (8 - (prefix % 8 || 8))) & 0xff;
  const whole = Math.floor(prefix / 8);
  for (let index = 0; index < whole; index++) if (bytes[index] !== network[index]) return false;
  return prefix % 8 === 0 || ((bytes[whole]! & mask) === (network[whole]! & mask));
}

function publicIpv4(address: string): boolean {
  const bytes = ipv4Bytes(address);
  if (!bytes) return false;
  const denied: [number[], number][] = [
    [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8],
    [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12], [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24],
    [[192, 88, 99, 0], 24], [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
    [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
  ];
  return !denied.some(([network, prefix]) => inIpv4Range(bytes, network, prefix));
}

function ipv6Bytes(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  const value = address.toLowerCase().split("%", 1)[0]!;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const words: number[] = [];
    for (const item of part.split(":")) {
      if (item.includes(".")) {
        const v4 = ipv4Bytes(item);
        if (!v4) return null;
        words.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
        words.push(Number.parseInt(item, 16));
      }
    }
    return words;
  };
  const left = parse(halves[0]!);
  const right = parse(halves[1] ?? "");
  if (!left || !right || (halves.length === 1 && left.length !== 8) || (halves.length === 2 && left.length + right.length >= 8)) return null;
  const words = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  return words.flatMap((word) => [word >> 8, word & 255]);
}

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family !== 6) return false;
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return publicIpv4(bytes.slice(12).join("."));
  // Permit global-unicast 2000::/3 only; this excludes unspecified, loopback, ULA, link-local,
  // multicast, documentation, 6to4, and other special-purpose IPv6 ranges.
  const globalUnicast = (bytes[0]! & 0xe0) === 0x20;
  const documentation = bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8;
  const special2001 = bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2]! <= 0x01;
  const sixToFour = bytes[0] === 0x20 && bytes[1] === 0x02;
  const documentationV6 = bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2]! & 0xf0) === 0;
  return globalUnicast && !documentation && !special2001 && !sixToFour && !documentationV6;
}

function validateUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new RecipeSampleImportError("bad_request"); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !host || isIP(host) !== 0 ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".onion")) {
    throw new RecipeSampleImportError("unsafe_url");
  }
  return url;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RecipeSampleImportError("timeout")), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

async function lookupAddresses(hostname: string): Promise<LookupAddress[]> {
  return systemLookup(hostname, { all: true, verbatim: true });
}

function requestPinned(url: URL, address: PublicAddress, maxBytes: number, timeoutMs: number): Promise<UrlResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const pinnedLookup = ((_hostname: string, options: { all?: boolean }, callback: (...args: never[]) => void) => {
      if (options.all) callback(null as never, [address] as never);
      else callback(null as never, address.address as never, address.family as never);
    }) as unknown as NonNullable<http.RequestOptions["lookup"]>;
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      work();
    };
    const timer = setTimeout(() => req.destroy(new RecipeSampleImportError("timeout")), timeoutMs);
    const req = transport.request(url, {
      method: "GET",
      headers: { accept: "text/html,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document;q=0.9,*/*;q=0.1", "accept-encoding": "identity", "user-agent": "NIHO-editor-sample-import/1" },
      lookup: pinnedLookup,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const length = Number(response.headers["content-length"]);
      if (Number.isFinite(length) && length > maxBytes) {
        response.destroy();
        finish(() => reject(new RecipeSampleImportError("too_large")));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          response.destroy(new RecipeSampleImportError("too_large"));
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => finish(() => resolve({ status, headers: response.headers, body: Buffer.concat(chunks) })));
      response.on("error", (error) => finish(() => reject(error)));
    });
    req.on("error", (error) => finish(() => reject(error)));
    req.end();
  });
}

async function fetchPublicUrl(
  input: string,
  options: { lookup?: AddressLookup; request?: UrlRequest; timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ url: URL; response: UrlResponse }> {
  const resolver = options.lookup ?? lookupAddresses;
  const send = options.request ?? requestPinned;
  const timeoutMs = options.timeoutMs ?? RECIPE_SAMPLE_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? RECIPE_SAMPLE_URL_MAX_BYTES;
  const deadline = Date.now() + timeoutMs;
  let url = validateUrl(input);
  for (let redirects = 0; ; redirects++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new RecipeSampleImportError("timeout");
    let addresses: LookupAddress[];
    try { addresses = await withTimeout(resolver(url.hostname), remaining); }
    catch (error) { if (error instanceof RecipeSampleImportError) throw error; throw new RecipeSampleImportError("fetch_failed"); }
    if (addresses.length === 0 || addresses.some((entry) => !publicAddress(entry.address))) throw new RecipeSampleImportError("unsafe_url");
    let response: UrlResponse;
    try { response = await withTimeout(send(url, addresses[0]!, maxBytes, remaining), remaining); }
    catch (error) { if (error instanceof RecipeSampleImportError) throw error; throw new RecipeSampleImportError("fetch_failed"); }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (typeof location !== "string" || redirects >= RECIPE_SAMPLE_MAX_REDIRECTS) throw new RecipeSampleImportError("fetch_failed");
      let next: URL;
      try { next = new URL(location, url); } catch { throw new RecipeSampleImportError("fetch_failed"); }
      url = validateUrl(next.toString());
      continue;
    }
    if (response.status !== 200) throw new RecipeSampleImportError("fetch_failed");
    return { url, response };
  }
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"', ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      try { return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "�"; } catch { return "�"; }
    }
    return named[entity.toLowerCase()] ?? whole;
  });
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(html
    .replace(/<(script|style|noscript|svg|head|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .replace(/[\t\f\v ]+\n/g, "\n")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function checkDocxExpansion(bytes: Buffer): void {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw new RecipeSampleImportError("invalid_document");
  const start = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= start; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new RecipeSampleImportError("invalid_document");
  const entries = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  let totalExpanded = 0;
  for (let index = 0; index < entries; index++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new RecipeSampleImportError("invalid_document");
    const expanded = bytes.readUInt32LE(offset + 24);
    totalExpanded += expanded;
    if (expanded > 16 * 1024 * 1024 || totalExpanded > 32 * 1024 * 1024) throw new RecipeSampleImportError("too_large");
    offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
}

async function pdfToText(bytes: Buffer): Promise<string> {
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, stopAtErrors: true } as Parameters<typeof getDocument>[0]);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void task.destroy(); }, RECIPE_SAMPLE_FETCH_TIMEOUT_MS);
  try {
    const pdf = await task.promise;
    if (pdf.numPages > RECIPE_SAMPLE_MAX_PDF_PAGES) throw new RecipeSampleImportError("too_large");
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let line = "";
      const lines: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) { lines.push(line); line = ""; }
      }
      if (line) lines.push(line);
      pages.push(lines.join("\n"));
      page.cleanup();
    }
    return pages.join("\n\n");
  } catch (error) {
    if (timedOut) throw new RecipeSampleImportError("timeout");
    if (error instanceof RecipeSampleImportError) throw error;
    throw new RecipeSampleImportError("invalid_document");
  } finally {
    clearTimeout(timer);
    await task.destroy().catch(() => undefined);
  }
}

function extensionOf(fileName: string): string {
  return /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? "";
}

async function textFromBytes(bytes: Buffer, format: string): Promise<string> {
  if (bytes.length === 0 || bytes.length > RECIPE_SAMPLE_UPLOAD_MAX_BYTES) throw new RecipeSampleImportError("too_large");
  try {
    if (format === "docx") {
      checkDocxExpansion(bytes);
      return (await mammoth.extractRawText({ buffer: bytes })).value;
    }
    if (format === "pdf") return await pdfToText(bytes);
    if (format === "html") return htmlToText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (format === "md" || format === "txt") return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof RecipeSampleImportError) throw error;
    throw new RecipeSampleImportError("invalid_document");
  }
  throw new RecipeSampleImportError("unsupported_type");
}

function boundedSample(raw: string): ImportedSampleText {
  const normalized = raw.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
  const all = Array.from(normalized);
  if (all.length === 0) throw new RecipeSampleImportError("invalid_document");
  if (all.length <= SAMPLE_MAX_CHARS) return { text: normalized, chars: all.length };
  const prefix = all.slice(0, SAMPLE_MAX_CHARS).join("");
  const paragraph = prefix.lastIndexOf("\n\n");
  const cut = paragraph >= SAMPLE_MAX_CHARS * 0.5 ? paragraph : prefix.length;
  const text = prefix.slice(0, cut).trim();
  if (!text) throw new RecipeSampleImportError("invalid_document");
  return { text, chars: Array.from(text).length, truncatedFrom: all.length };
}

export async function importUploadedSample(fileName: string, bytes: Buffer): Promise<ImportedSampleText> {
  const format = extensionOf(fileName);
  if (!["md", "txt", "docx", "pdf"].includes(format)) throw new RecipeSampleImportError("unsupported_type");
  if (bytes.length > RECIPE_SAMPLE_UPLOAD_MAX_BYTES) throw new RecipeSampleImportError("too_large");
  return boundedSample(await textFromBytes(bytes, format));
}

export async function importUrlSample(input: string, options: { lookup?: AddressLookup; request?: UrlRequest; timeoutMs?: number; maxBytes?: number } = {}): Promise<ImportedSampleText & { sourceUrl: string; name: string }> {
  if (Array.from(input).length > 2000) throw new RecipeSampleImportError("bad_request");
  const { url, response } = await fetchPublicUrl(input, options);
  const contentType = (response.headers["content-type"] ?? "").toString().split(";", 1)[0]!.trim().toLowerCase();
  const extension = extensionOf(url.pathname);
  let format = extension;
  if (contentType === "application/pdf") format = "pdf";
  else if (contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") format = "docx";
  else if (contentType === "text/html" || contentType === "application/xhtml+xml") format = "html";
  else if (contentType === "text/plain") format = "txt";
  else if (contentType === "text/markdown") format = "md";
  if (!["md", "txt", "docx", "pdf", "html"].includes(format)) throw new RecipeSampleImportError("unsupported_type");
  const sample = boundedSample(await textFromBytes(response.body, format));
  const storedUrl = new URL(url);
  storedUrl.search = "";
  storedUrl.hash = "";
  if (Array.from(storedUrl.toString()).length > 2000) throw new RecipeSampleImportError("bad_request");
  return { ...sample, sourceUrl: storedUrl.toString(), name: url.hostname };
}
