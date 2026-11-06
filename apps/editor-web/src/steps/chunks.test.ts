import { describe, expect, it } from "vitest";
import { stepBlocksText, type Block } from "@niho/editor-store";
import { CHUNK_TARGET_CHARS, CHUNK_THRESHOLD_CHARS, MAX_CHUNKS, chunkTail, packParagraphs, planChunks, splitLongParagraph } from "./chunks";

// 合成の値だけを使う
const paragraph = (text: string): Block => ({ type: "paragraph", content: [{ type: "text", text }] });
const len = (text: string) => Array.from(text).length;

describe("planChunks", () => {
  it("閾値（18,000 字）以下は区切らない", () => {
    const blocks = [paragraph("あ".repeat(CHUNK_THRESHOLD_CHARS))];
    expect(planChunks(blocks)).toEqual({ ok: true, chunks: null });
  });

  it("4 万字を段落の切れ目で約 1.6 万字ずつに分け、つなぐと元の全文になる", () => {
    // 1 段落 1,000 字 × 40（区切りの境目は段落の切れ目）
    const blocks = Array.from({ length: 40 }, (_, index) => paragraph(`${index}`.padEnd(1000, "話")));
    const plan = planChunks(blocks);
    expect(plan.ok).toBe(true);
    const chunks = plan.ok ? plan.chunks! : [];
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) expect(len(chunk)).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
    expect(chunks.join("\n\n")).toBe(stepBlocksText(blocks));
    // 段落の途中で切っていない
    for (const chunk of chunks) expect(chunk.split("\n\n").every((part) => len(part) === 1000)).toBe(true);
  });

  it("サロゲートペア（絵文字）も 1 字として数える", () => {
    const blocks = [paragraph("😀".repeat(CHUNK_THRESHOLD_CHARS))];
    expect(planChunks(blocks)).toEqual({ ok: true, chunks: null });
  });

  it("1 段落が長すぎるときは文末で切り、文末が無ければ字数で切る", () => {
    const sentence = "あ".repeat(99) + "。";
    const long = sentence.repeat(200); // 20,000 字・文末あり
    const pieces = splitLongParagraph(long);
    expect(pieces.length).toBe(2);
    expect(pieces[0]!.endsWith("。")).toBe(true);
    expect(len(pieces[0]!)).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
    expect(pieces.join("")).toBe(long);

    const plain = "い".repeat(40_000);
    const cut = splitLongParagraph(plain);
    expect(cut.map(len)).toEqual([16_000, 16_000, 8_000]);
    expect(cut.join("")).toBe(plain);
  });

  it("区切りが 60 を超える入力は too_long", () => {
    const blocks = Array.from({ length: MAX_CHUNKS + 1 }, () => paragraph("う".repeat(CHUNK_TARGET_CHARS)));
    expect(planChunks(blocks)).toEqual({ ok: false, reason: "too_long" });
    const exactly = Array.from({ length: MAX_CHUNKS }, () => paragraph("う".repeat(CHUNK_TARGET_CHARS)));
    const plan = planChunks(exactly);
    expect(plan.ok && plan.chunks?.length).toBe(MAX_CHUNKS);
  });

  it("決定的（同じ入力から同じ区切り）", () => {
    const blocks = Array.from({ length: 30 }, (_, index) => paragraph(`段落${index}。`.repeat(150)));
    expect(planChunks(blocks)).toEqual(planChunks(structuredClone(blocks)));
  });
});

describe("packParagraphs / chunkTail", () => {
  it("区切りの上限に段落の区切り（空行）も数える", () => {
    expect(packParagraphs(["あ".repeat(5), "い".repeat(5)], 11)).toEqual(["あああああ", "いいいいい"]);
    expect(packParagraphs(["あ".repeat(5), "い".repeat(5)], 12)).toEqual(["あああああ\n\nいいいいい"]);
  });

  it("末尾の 400 字だけを返す", () => {
    expect(len(chunkTail("え".repeat(1000)))).toBe(400);
    expect(chunkTail("  短い  ")).toBe("短い");
  });
});
