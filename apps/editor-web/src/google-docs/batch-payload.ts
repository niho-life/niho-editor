import { createHash } from "node:crypto";
import { GOOGLE_DOCS_BATCH_MAX_ITEM_BYTES, type Block, type GoogleDocsBatchOmission, type GoogleDocsBatchOptions, type GoogleDocsBatchTreePage } from "@niho/editor-store";
import { exportFullMarkdown, MarkdownExportError } from "../export/markdown";
import { checkExportRequest, googleDocTitle } from "./gateway";

export type GoogleDocsBatchPlainPayload = {
  schema: 1;
  title: string;
  markdown: string;
};

export type GoogleDocsBatchPayloadPlan = {
  ok: true;
  payload: GoogleDocsBatchPlainPayload;
  payloadSha256: string;
  payloadBytes: number;
  omissions: GoogleDocsBatchOmission[];
} | {
  ok: false;
  reason: "empty" | "unsupported_markdown" | "payload_too_large";
  detail: string | null;
  omissions: GoogleDocsBatchOmission[];
};

type MutableNode = { [key: string]: unknown };
const LINK_SECRET = /(?:token|auth|code|credential|jwt|sig|signed|secret|key|googleaccessid|x.?amz)/i;
const KNOWN_BLOCKS = new Set([
  "paragraph", "heading", "hardBreak", "bulletList", "orderedList", "listItem", "taskList", "taskItem", "blockquote", "callout",
  "table", "tableRow", "tableHeader", "tableCell", "codeBlock", "horizontalRule", "image", "docAssetImage", "recording",
]);

function record(value: unknown): MutableNode | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as MutableNode : null;
}

function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")
    || host.includes(":")) return true; // A colon here means URL.hostname is an IPv6 literal; exports omit all IPv6 destinations.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return true;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || (octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127)
    || (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31)
    || (octets[0] === 192 && (octets[1] === 0 || octets[1] === 168)) || (octets[0] === 198 && [18, 19].includes(octets[1]!))
    || octets[0]! >= 224;
}

function safeGoogleLink(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || privateHost(url.hostname)) return false;
  for (const key of url.searchParams.keys()) if (LINK_SECRET.test(key)) return false;
  return true;
}

function cleanTextLinks(value: string, counts: Map<string, number>): string {
  return value.replace(/\bhttps?:\/\/[^\s<>"']+/giu, (url) => {
    if (safeGoogleLink(url)) return url;
    counts.set("private_link_removed", (counts.get("private_link_removed") ?? 0) + 1);
    return "[非公開リンクを省略]";
  });
}

function cleanForGoogle(value: unknown, counts: Map<string, number>, depth = 0): unknown {
  if (depth > 64) {
    counts.set("unsupported_block", (counts.get("unsupported_block") ?? 0) + 1);
    return null;
  }
  if (Array.isArray(value)) return value.map((item) => cleanForGoogle(item, counts, depth + 1)).filter((item) => item !== null);
  const node = record(value);
  if (!node) return value;
  const type = typeof node.type === "string" ? node.type : null;
  if (type === "image" || type === "docAssetImage") {
    counts.set("image_omitted", (counts.get("image_omitted") ?? 0) + 1);
    return null;
  }
  if (type === "recording") {
    counts.set("recording_block_omitted", (counts.get("recording_block_omitted") ?? 0) + 1);
    return null;
  }
  if (type === "horizontalRule") {
    counts.set("horizontal_rule_omitted", (counts.get("horizontal_rule_omitted") ?? 0) + 1);
    return null;
  }
  if (type && type !== "text" && !KNOWN_BLOCKS.has(type)) {
    counts.set("unsupported_block", (counts.get("unsupported_block") ?? 0) + 1);
    return null;
  }
  const cleaned: MutableNode = {};
  for (const [key, raw] of Object.entries(node)) {
    if (key === "text" && typeof raw === "string") {
      cleaned.text = cleanTextLinks(raw, counts);
    } else if (key === "marks" && Array.isArray(raw)) {
      cleaned.marks = raw.filter((mark) => {
        const markNode = record(mark);
        if (markNode?.type !== "link") return true;
        const attrs = record(markNode.attrs);
        if (safeGoogleLink(attrs?.href)) return true;
        counts.set("private_link_removed", (counts.get("private_link_removed") ?? 0) + 1);
        return false;
      }).map((mark) => {
        const markNode = record(mark);
        if (!markNode) return mark;
        const cleanedMark: MutableNode = {};
        for (const [markKey, markValue] of Object.entries(markNode)) cleanedMark[markKey] = cleanForGoogle(markValue, counts, depth + 1);
        return cleanedMark;
      });
    } else {
      cleaned[key] = cleanForGoogle(raw, counts, depth + 1);
    }
  }
  return cleaned;
}

function backgroundMarkdown(page: GoogleDocsBatchTreePage, counts: Map<string, number>): { markdown: string; count: number } {
  const entities = Array.isArray(page.entities) ? page.entities : [];
  const terms = Array.isArray(page.terms) ? page.terms : [];
  const lines: string[] = [];
  for (const value of entities) {
    const item = record(value);
    if (!item || typeof item.name !== "string") continue;
    const detail = [item.reading, item.role, item.note].filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      .map((entry) => cleanTextLinks(entry.trim(), counts)).join(" / ");
    lines.push(`- ${cleanTextLinks(item.name.trim(), counts)}${detail ? `: ${detail}` : ""}`);
  }
  for (const value of terms) {
    const item = record(value);
    if (!item || typeof item.term !== "string") continue;
    const detail = [item.reading, Array.isArray(item.variants) ? item.variants.filter((entry): entry is string => typeof entry === "string").join("・") : "", item.note]
      .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      .map((entry) => cleanTextLinks(entry.trim(), counts)).join(" / ");
    lines.push(`- ${cleanTextLinks(item.term.trim(), counts)}${detail ? `: ${detail}` : ""}`);
  }
  // 録音の背景（文字。2026-11-06）は、登場人物・固有名詞の後ろに段落で置く
  const text = typeof page.background === "string" ? page.background.trim() : "";
  const paragraph = text === "" ? "" : cleanTextLinks(text.replace(/\r\n?/g, "\n"), counts);
  const count = lines.length + (paragraph === "" ? 0 : 1);
  const body = [lines.join("\n"), paragraph].filter((part) => part !== "").join("\n\n");
  return { markdown: count ? `## 背景\n\n${body}\n` : "", count };
}

function transcriptMarkdown(page: GoogleDocsBatchTreePage, counts: Map<string, number>): { markdown: string; count: number } {
  if (!Array.isArray(page.transcriptSegments)) return { markdown: "", count: 0 };
  const speakers = record(page.speakerNames) ?? {};
  const lines: string[] = [];
  for (const value of page.transcriptSegments) {
    const item = record(value);
    if (!item || typeof item.text !== "string" || item.text.trim() === "") continue;
    const speaker = Number.isSafeInteger(item.speaker) && (item.speaker as number) > 0 ? item.speaker as number : null;
    const name = speaker === null ? "" : typeof speakers[String(speaker)] === "string" ? cleanTextLinks(String(speakers[String(speaker)]).trim(), counts) : `話者${speaker}`;
    const seconds = typeof item.start === "number" && Number.isFinite(item.start) && item.start >= 0 ? Math.floor(item.start) : null;
    const stamp = seconds === null ? "" : `[${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}] `;
    lines.push(`${stamp}${name ? `${name}: ` : ""}${cleanTextLinks(item.text.replace(/[\r\n]+/g, " ").trim(), counts)}`);
  }
  return { markdown: lines.length ? `## 文字起こし\n\n${lines.join("\n\n")}\n` : "", count: lines.length };
}

export function hashGoogleDocsPayload(title: string, markdown: string): { payloadSha256: string; payloadBytes: number } {
  const titleBytes = Buffer.byteLength(title, "utf8");
  const payloadBytes = titleBytes + Buffer.byteLength(markdown, "utf8");
  return {
    payloadSha256: createHash("sha256").update(`${titleBytes}:${title}${markdown}`, "utf8").digest("hex"),
    payloadBytes,
  };
}

export function planGoogleDocsBatchPayload(page: GoogleDocsBatchTreePage, options: GoogleDocsBatchOptions): GoogleDocsBatchPayloadPlan {
  const counts = new Map<string, number>();
  const cleaned = cleanForGoogle(page.blocks, counts) as Block[];
  let markdown: string;
  try {
    markdown = exportFullMarkdown(cleaned, { boxes: "quote" });
  } catch (error) {
    const omissions = [...counts].map(([reason, count]) => ({ reason, count }));
    return { ok: false, reason: "unsupported_markdown", detail: error instanceof MarkdownExportError ? error.message : null, omissions };
  }
  if (options.includeBackground) {
    const background = backgroundMarkdown(page, counts);
    if (background.count > 0) markdown += `${markdown ? "\n" : ""}${background.markdown}`;
  } else if (page.backgroundCount > 0) {
    counts.set("background_not_selected", page.backgroundCount);
  }
  if (page.hasRecording) counts.set("original_audio_omitted", 1);
  if (options.includeTranscript) {
    const transcript = transcriptMarkdown(page, counts);
    if (transcript.count > 0) markdown += `${markdown ? "\n" : ""}${transcript.markdown}`;
  } else if (page.transcriptCount > 0) {
    counts.set("transcript_not_selected", page.transcriptCount);
  }
  const title = googleDocTitle(cleanTextLinks(page.title, counts));
  const omissions = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => ({ reason, count }));
  if (markdown === "") return { ok: false, reason: "empty", detail: null, omissions };
  if (checkExportRequest({ exportId: "00000000-0000-4000-8000-000000000000", title, markdown }) !== "ok") {
    return { ok: false, reason: "payload_too_large", detail: null, omissions };
  }
  const hash = hashGoogleDocsPayload(title, markdown);
  if (hash.payloadBytes > GOOGLE_DOCS_BATCH_MAX_ITEM_BYTES) {
    return { ok: false, reason: "payload_too_large", detail: null, omissions };
  }
  return { ok: true, payload: { schema: 1, title, markdown }, ...hash, omissions };
}

export function parseGoogleDocsBatchPayload(value: unknown): GoogleDocsBatchPlainPayload | null {
  const payload = record(value);
  if (!payload || Object.keys(payload).sort().join(",") !== "markdown,schema,title" || payload.schema !== 1
    || typeof payload.title !== "string" || typeof payload.markdown !== "string") return null;
  if (checkExportRequest({ exportId: "00000000-0000-4000-8000-000000000000", title: payload.title, markdown: payload.markdown }) !== "ok") return null;
  return { schema: 1, title: payload.title, markdown: payload.markdown };
}
