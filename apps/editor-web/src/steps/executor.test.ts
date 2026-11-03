import { describe, expect, it } from "vitest";
import { parseBlocks } from "../server/page-input";
import { StepError, createFakeExecutor, fakeExecutor } from "./executor";
import { DEFAULT_RECIPES, findRecipeIn } from "./recipes";

const recipe = findRecipeIn(DEFAULT_RECIPES, "tpl-1")!;
const transcript = [{ type: "paragraph", content: [{ type: "text", text: "合成の文字起こしの冒頭です。ここから三十文字を超えるまで続く合成の本文。" }] }];

describe("fakeExecutor", () => {
  it("returns the same marked blocks for the same input, and they pass the blocks check", async () => {
    const input = { recipe, stepIndex: 0, parentBlocks: transcript, backgroundBlocks: [], previousBlocks: null };
    const first = await fakeExecutor.run(input);
    const second = await fakeExecutor.run(input);
    expect(second).toEqual(first);
    expect(parseBlocks(first.blocks).ok).toBe(true);
    const text = JSON.stringify(first.blocks);
    expect(text).toContain("[fake]");
    expect(text).toContain("文字起こし修正");
    expect(text).toContain("合成の文字起こしの冒頭です。ここから三十文字を超えるまで続");
    expect(text).not.toContain("続く合成の本文");
    expect(first.blocks[0]).toMatchObject({ type: "heading" });
  });

  it("reads the previous step after the first one, and never emits an empty text node", async () => {
    const previous = [{ type: "paragraph", content: [{ type: "text", text: "前の段階の合成の結果" }] }];
    const output = await fakeExecutor.run({ recipe, stepIndex: 1, parentBlocks: transcript, backgroundBlocks: [], previousBlocks: previous });
    expect(JSON.stringify(output.blocks)).toContain("前の段階の合成の結果");
    expect(JSON.stringify(output.blocks)).toContain("記事方針");
    const empty = await fakeExecutor.run({ recipe, stepIndex: 2, parentBlocks: [], backgroundBlocks: [], previousBlocks: [] });
    expect(JSON.stringify(empty.blocks)).not.toContain('"text":""');
    expect(parseBlocks(empty.blocks).ok).toBe(true);
  });

  it("can fail the first n calls, throw what it is told, and be slow until aborted", async () => {
    const input = { recipe, stepIndex: 0, parentBlocks: transcript, backgroundBlocks: [], previousBlocks: null };
    const flaky = createFakeExecutor({ failures: 2 });
    await expect(flaky.run(input)).rejects.toMatchObject({ name: "StepError", code: "fake_failure", retryable: true });
    await expect(flaky.run(input)).rejects.toBeInstanceOf(StepError);
    await expect(flaky.run(input)).resolves.toHaveProperty("blocks");
    expect(flaky.calls).toBe(3);

    const broken = createFakeExecutor({ failures: 1, error: () => new StepError("invalid_input", false) });
    await expect(broken.run(input)).rejects.toMatchObject({ code: "invalid_input", retryable: false });

    const slow = createFakeExecutor({ delayMs: 10_000 });
    const controller = new AbortController();
    const running = slow.run({ ...input, signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "aborted" });
  });
});
