import { describe, expect, it } from "vitest";
import { validateBlocks } from "./blocks";
import { docFromBlocks, imageAttrsOf, imageNode } from "./doc";

const ASSET = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";

describe("blocks and the TipTap doc", () => {
  it("wraps the blocks, and gives an empty page one empty paragraph", () => {
    expect(docFromBlocks([])).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    const blocks = [{ type: "paragraph", content: [{ type: "text", text: "本文" }] }];
    expect(docFromBlocks(blocks)).toEqual({ type: "doc", content: blocks });
  });

  it("keeps image caption and rights attributes through the round trip, and the server accepts them", () => {
    const full = imageNode({ assetId: ASSET, alt: "合成の写真", caption: "合成の説明", credit: "合成の提供元", consent: true });
    expect(full).toEqual({ type: "image", attrs: { assetId: ASSET, alt: "合成の写真", caption: "合成の説明", credit: "合成の提供元", consent: true } });
    const result = validateBlocks([full]);
    expect(result.ok && result.blocks[0]).toEqual(full);
    // 保存した形から読み直しても同じ（往復で落ちない）
    expect(imageAttrsOf(result.ok ? result.blocks[0] : null)).toEqual({ assetId: ASSET, alt: "合成の写真", caption: "合成の説明", credit: "合成の提供元", consent: true });
  });

  it("treats an empty alt or credit as none, and never carries a URL", () => {
    const bare = imageNode({ assetId: ASSET, alt: "", credit: null });
    expect(bare).toEqual({ type: "image", attrs: { assetId: ASSET, alt: null, caption: null, credit: null, consent: false } });
    expect(validateBlocks([bare]).ok).toBe(true);
    expect(imageAttrsOf(bare)).toEqual({ assetId: ASSET, alt: null, caption: null, credit: null, consent: false });
    expect(JSON.stringify(bare)).not.toContain("http");
    expect(JSON.stringify(bare)).not.toContain("src");
  });

  it("reads nothing out of a node that is not an image or has no asset id", () => {
    for (const node of [
      null,
      "image",
      { type: "paragraph" },
      { type: "image" },
      { type: "image", attrs: {} },
      { type: "image", attrs: { src: "https://evil.example/a.png" } },
      { type: "image", attrs: { assetId: 1 } },
    ]) {
      expect(imageAttrsOf(node), JSON.stringify(node)).toBeNull();
    }
  });
});
