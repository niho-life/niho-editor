import { AnthropicError, type AnthropicClient, type CompleteInput, type Completion, type ToolCall, type Turn } from "./anthropic";

/**
 * 偽物の 1 往復（`EDITOR_AI_MODE=fake`。開発と CI だけ。本番では config.ts が受け付けない）。
 * 決定的で、返す文には必ず `[fake]` の印を入れる（本物の文書と見間違えないため）。usage の model は `fake`。
 *
 * 返すのは compose.ts が読める JSON（見出し 1 つと段落 2 つ）。プロンプトの中身は読まず、
 * 「## 頼むこと」の次の行（手順と段階の名前）と資料の先頭だけを写す。
 *
 * AI チャット（`converse`）は道具を順に呼ぶ: list_pages → read_page → write_page → 返答。
 * 本物と同じ道を通すための決まった動きで、書き足すのは `[fake]` の印を付けた 1 段落だけ。
 *
 * Web 検索（#283）: `web_search` の道具を渡され、今回の頼むことに「調べて」があれば、サーバー側の検索の往復を 1 つ通す:
 * 1 往復目は検索の呼び出しと結果（合成の URL）を返して `pause_turn` で止まり、2 往復目は返されたブロックが手つかずか確かめて
 * （崩れていれば本物と同じく 400 = bad_request）、引用つきの返答で終わる。ページは書かない。
 */

export const FAKE_CLIENT_MODEL = "fake";

/** プロンプトから印として写す部分の長さ（文字）。 */
const HEAD_CHARS = 60;

function head(text: string, length: number): string {
  const chars = Array.from(text.replace(/\s+/gu, " ").trim());
  return chars.length > length ? `${chars.slice(0, length).join("")}…` : chars.join("");
}

/** 「## 頼むこと」の次の行（無ければ空）。 */
function askedFor(user: string): string {
  const lines = user.split("\n");
  const position = lines.indexOf("## 頼むこと");
  return position >= 0 ? (lines[position + 1] ?? "") : "";
}

/** 資料（`<untrusted_data>` の中）の先頭（無ければ空）。「あなたについて」も同じ包みなので、最後の包み＝資料を見る。 */
function sourceHead(user: string): string {
  const all = [...user.matchAll(/<untrusted_data>\n([\s\S]*?)\n<\/untrusted_data>/g)];
  return all.at(-1)?.[1] ?? "";
}

function countChars(text: string): number {
  return Array.from(text).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** いちばん後ろの道具の結果と、それを出した道具の名前（messages の並びから読む）。 */
function lastTool(messages: readonly unknown[]): { name: string; result: unknown } | null {
  const blocks = messages.flatMap((message) => (isRecord(message) && Array.isArray(message.content) ? message.content : []));
  const names = new Map<string, string>();
  for (const block of blocks) {
    if (isRecord(block) && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") names.set(block.id, block.name);
  }
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (!isRecord(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    const name = names.get(block.tool_use_id);
    if (name === undefined) continue;
    let result: unknown = null;
    try {
      result = JSON.parse(String(block.content));
    } catch {
      result = null;
    }
    return { name, result };
  }
  return null;
}

const FAKE_LINE = "[fake] AI チャットが足した段落です。";

/** 偽の検索の呼び出しの id と、結果に載せる合成の出典（実在の店・URL ではない）。 */
const FAKE_SEARCH_ID = "srvtoolu_fake_1";
const FAKE_SEARCH_URL = "https://example.com/fake-hours";
const FAKE_SEARCH_TITLE = "[fake] 営業時間のページ";
const FAKE_ENCRYPTED = "fake-encrypted-content";

function hasWebSearchTool(tools: readonly unknown[] | undefined): boolean {
  return (tools ?? []).some((tool) => isRecord(tool) && tool.name === "web_search" && typeof tool.type === "string" && tool.type.startsWith("web_search_"));
}

/** 今回の頼むこと（いちばん後ろの、文字列の user）。 */
function lastInstruction(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isRecord(message) && message.role === "user" && typeof message.content === "string") return message.content;
  }
  return "";
}

/** 返された assistant の中の偽の検索のブロック（呼び出しと結果）。 */
function returnedSearch(messages: readonly unknown[]): { call: Record<string, unknown> | null; result: Record<string, unknown> | null } {
  let call: Record<string, unknown> | null = null;
  let result: Record<string, unknown> | null = null;
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "server_tool_use" && block.id === FAKE_SEARCH_ID) call = block;
      if (block.type === "web_search_tool_result" && block.tool_use_id === FAKE_SEARCH_ID) result = block;
    }
  }
  return { call, result };
}

/** 偽の検索の往復。検索の対象ではないときは null（いつもの list_pages → read_page → write_page へ）。 */
function searchTurn(input: { messages: unknown[]; tools?: unknown[] }, usage: Turn["usage"]): Turn | null {
  if (!hasWebSearchTool(input.tools) && returnedSearch(input.messages).call === null) return null;
  if (!lastInstruction(input.messages).includes("調べて")) return null;
  const { call, result } = returnedSearch(input.messages);
  if (call === null) {
    const content = [
      { type: "text", text: "[fake] Web で調べます。" },
      { type: "server_tool_use", id: FAKE_SEARCH_ID, name: "web_search", input: { query: "[fake] 営業時間" } },
      {
        type: "web_search_tool_result",
        tool_use_id: FAKE_SEARCH_ID,
        content: [{ type: "web_search_result", url: FAKE_SEARCH_URL, title: FAKE_SEARCH_TITLE, encrypted_content: FAKE_ENCRYPTED, page_age: null }],
      },
    ];
    return { text: "[fake] Web で調べます。", toolCalls: [], stopReason: "pause_turn", usage: { ...usage, webSearchRequests: 1 }, content };
  }
  // 本物は、返されたブロック（encrypted_content を含む）が崩れていると 400 で断る
  const results = result && Array.isArray(result.content) ? result.content : [];
  const intact = results.some((item) => isRecord(item) && item.encrypted_content === FAKE_ENCRYPTED && item.url === FAKE_SEARCH_URL);
  if (!intact) throw new AnthropicError("bad_request", { status: 400 });
  const answer = "[fake] 営業時間は 10 時から 18 時です。";
  const content = [
    {
      type: "text",
      text: answer,
      citations: [{ type: "web_search_result_location", url: FAKE_SEARCH_URL, title: FAKE_SEARCH_TITLE, encrypted_index: "fake-index", cited_text: "[fake] 10:00–18:00" }],
    },
  ];
  return { text: answer, toolCalls: [], stopReason: "end_turn", usage, content };
}

/** 偽物の道具の呼び出し（id は決定的）。 */
function callTool(name: string, input: unknown, step: number): ToolCall {
  return { id: `fake-tool-${step}`, name, input };
}

/** 文書を作る側（手順の段階）の偽の答え（compose.ts が読む JSON）。 */
function composeAnswer(user: string): string {
  const asked = head(askedFor(user), HEAD_CHARS) || "（頼むことなし）";
  const source = head(sourceHead(user), HEAD_CHARS) || "（資料なし）";
  return JSON.stringify({
    blocks: [
      { kind: "heading", level: 2, text: "[fake] 偽の結果" },
      { kind: "paragraph", text: `[fake] ${asked}` },
      { kind: "paragraph", text: `[fake] 資料の先頭: ${source}` },
    ],
  });
}

/** 決定的な偽物の 1 往復。usage は送った文字数・返した文字数の 1/4（切り上げ）。 */
export function createFakeClient(): AnthropicClient {
  const usageOf = (sent: number, returned: number) => ({ model: FAKE_CLIENT_MODEL, inputTokens: Math.ceil(sent / 4), outputTokens: Math.ceil(returned / 4) });
  type FakeConverseInput = {
    system: string;
    messages: unknown[];
    tools?: unknown[];
    signal?: AbortSignal;
    onText?: (delta: string) => void;
    onServerBlock?: (block: Record<string, unknown>) => void;
  };
  const answer = async (input: FakeConverseInput): Promise<Turn> => {
    input.signal?.throwIfAborted();
    const sent = countChars(input.system) + countChars(JSON.stringify(input.messages));
    const usage = usageOf(sent, 64);
    // 道具を渡されない往復は、文書を作る側（手順の段階。compose.ts）
    if (!input.tools || input.tools.length === 0) {
      const first = input.messages[0];
      const user = isRecord(first) && typeof first.content === "string" ? first.content : "";
      const text = composeAnswer(user);
      return { text, toolCalls: [], stopReason: "end_turn", usage: usageOf(sent, countChars(text)) };
    }
    const searched = searchTurn(input, usage);
    if (searched) return searched;
    const last = lastTool(input.messages);
    if (last === null) return { text: "", toolCalls: [callTool("list_pages", {}, 1)], stopReason: "tool_use", usage };
    if (last.name === "list_pages") {
      const pages = isRecord(last.result) && Array.isArray(last.result.pages) ? last.result.pages : [];
      const open = pages.find((page) => isRecord(page) && page.open === true && page.writable === true) ?? pages[0];
      const id = isRecord(open) && typeof open.id === "string" ? open.id : "";
      return { text: "開いているページを読みます。", toolCalls: [callTool("read_page", { page_id: id }, 2)], stopReason: "tool_use", usage };
    }
    if (last.name === "read_page") {
      const body = isRecord(last.result) ? last.result : {};
      const id = typeof body.id === "string" ? body.id : "";
      // read_page は段落ごと（n・markdown）に返る。つなげて全体の本文にする
      const paragraphs = Array.isArray(body.paragraphs) ? body.paragraphs : [];
      const markdown = paragraphs.map((paragraph) => (isRecord(paragraph) && typeof paragraph.markdown === "string" ? paragraph.markdown : "")).join("\n\n");
      const next = markdown.trim().length > 0 ? `${markdown.trim()}\n\n${FAKE_LINE}` : FAKE_LINE;
      const revision = typeof body.revision === "number" ? body.revision : 0;
      return { text: "", toolCalls: [callTool("write_page", { page_id: id, markdown: next, base_revision: revision }, 3)], stopReason: "tool_use", usage };
    }
    return { text: "[fake] 本文に 1 段落足しました。元に戻せます。", toolCalls: [], stopReason: "end_turn", usage };
  };
  // streaming（思考の中継）を頼まれたら、書いた文を 1 回で流す（画面の fake の経路でも途中の文が見える）
  const converse = async (input: FakeConverseInput): Promise<Turn> => {
    const turn = await answer(input);
    if (input.onText && turn.text) input.onText(turn.text);
    // 本物の streaming と同じく、サーバー側の道具のブロックを知らせる
    if (input.onText) for (const block of turn.content ?? []) if (isRecord(block) && (block.type === "server_tool_use" || block.type === "web_search_tool_result")) input.onServerBlock?.(block);
    return turn;
  };
  return {
    converse,
    async complete(input: CompleteInput): Promise<Completion> {
      input.signal?.throwIfAborted();
      let text: string;
      if (input.system.startsWith("You are the NIHO editor managed translation engine.")) {
        let fields: unknown = null;
        try {
          fields = (JSON.parse(input.user) as { fields?: unknown }).fields;
        } catch {
          fields = null;
        }
        const translations = Array.isArray(fields)
          ? fields.flatMap((field) => isRecord(field) && typeof field.path === "string" && typeof field.text === "string"
            ? [{ path: field.path, text: `[fake en] ${field.text}` }]
            : [])
          : [];
        text = JSON.stringify({ translations });
      } else {
        text = composeAnswer(input.user);
      }
      const sent = countChars(input.system) + countChars(input.user);
      return { text, usage: usageOf(sent, countChars(text)) };
    },
  };
}
