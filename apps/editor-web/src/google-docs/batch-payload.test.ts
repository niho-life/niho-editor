import { describe, expect, it } from "vitest";
import type { GoogleDocsBatchTreePage } from "@niho/editor-store";
import { hashGoogleDocsPayload, parseGoogleDocsBatchPayload, planGoogleDocsBatchPayload } from "./batch-payload";

function page(extra: Partial<GoogleDocsBatchTreePage> = {}): GoogleDocsBatchTreePage {
  return {
    id: "00000000-0000-4000-8000-000000000001", title: " 合成の題名 ", revision: 3, parent: null, depth: 0,
    blocks: [{ type: "paragraph", content: [{ type: "text", text: "本文" }] }],
    entities: [], terms: [], transcriptSegments: [], speakerNames: {}, hasRecording: false, hasBackground: false, hasTranscript: false,
    backgroundCount: 0, transcriptCount: 0, ...extra,
  };
}

describe("Google Docs batch payload", () => {
  it("matches the shared UTF-8 Japanese/emoji hash vector", () => {
    expect(hashGoogleDocsPayload("日本語😀題名", "## 見出し\n\n本文🙂\n")).toEqual({
      payloadBytes: 44,
      payloadSha256: "cd2f2e884391aa87d50b6ad7d6dee53b184c8256054170e5b7d0aa69bc1efbcb",
    });
  });

  it("explains every omitted image/audio/background/transcript and never sends private or token URLs", () => {
    const target = page({
      hasRecording: true,
      backgroundCount: 2,
      transcriptCount: 1,
      entities: [{ name: "合成人物", reading: "", role: "案内", note: "" }],
      terms: [{ term: "合成語", reading: "", variants: [], note: "" }],
      transcriptSegments: [{ start: 3, end: 5, text: "合成の発話", speaker: 1 }],
      speakerNames: { "1": "話者A" },
      blocks: [
        { type: "paragraph", content: [
          { type: "text", text: "秘密リンク", marks: [{ type: "link", attrs: { href: "https://private.invalid/path?access_token=synthetic" } }] },
        ] },
        { type: "image", attrs: { src: "https://private.invalid/image?token=synthetic", alt: "非公開画像" } },
        { type: "recording", attrs: { url: "https://private.invalid/audio?sig=synthetic" } },
      ],
    });
    const excluded = planGoogleDocsBatchPayload(target, { includeBackground: false, includeTranscript: false });
    expect(excluded.ok).toBe(true);
    if (!excluded.ok) return;
    expect(excluded.omissions).toEqual(expect.arrayContaining([
      { reason: "image_omitted", count: 1 },
      { reason: "recording_block_omitted", count: 1 },
      { reason: "original_audio_omitted", count: 1 },
      { reason: "background_not_selected", count: 2 },
      { reason: "transcript_not_selected", count: 1 },
      { reason: "private_link_removed", count: 1 },
    ]));
    expect(excluded.payload.markdown).toContain("秘密リンク");
    expect(excluded.payload.markdown).not.toMatch(/private\.invalid|synthetic|access_token|\?sig/);

    const included = planGoogleDocsBatchPayload(target, { includeBackground: true, includeTranscript: true });
    expect(included.ok).toBe(true);
    if (!included.ok) return;
    expect(included.payload.markdown).toContain("## 背景");
    expect(included.payload.markdown).toContain("合成人物: 案内");
    expect(included.payload.markdown).toContain("## 文字起こし");
    expect(included.payload.markdown).toContain("[00:00:03] 話者A: 合成の発話");
    expect(included.omissions).not.toEqual(expect.arrayContaining([{ reason: "transcript_not_selected", count: 1 }]));
  });

  it("rejects empty, unconvertible and oversized pages before a job can call Google", () => {
    expect(planGoogleDocsBatchPayload(page({ blocks: [{ type: "image", attrs: { src: "https://example.invalid/x" } }] }), { includeBackground: false, includeTranscript: false }))
      .toMatchObject({ ok: false, reason: "empty" });
    expect(planGoogleDocsBatchPayload(page({ blocks: [{ type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 2 }, content: [] }] }] }] }), { includeBackground: false, includeTranscript: false }))
      .toMatchObject({ ok: false, reason: "unsupported_markdown" });
    expect(planGoogleDocsBatchPayload(page({ blocks: [{ type: "paragraph", content: [{ type: "text", text: "あ".repeat(1_000_001) }] }] }), { includeBackground: false, includeTranscript: false }))
      .toMatchObject({ ok: false, reason: "payload_too_large" });
  });

  it("link markが無い本文・code内のprivate/token URLも置換して外へ渡さない", () => {
    const planned = planGoogleDocsBatchPayload(page({ blocks: [
      { type: "paragraph", content: [{ type: "text", text: "内部 http://10.0.0.2/raw と https://public.example.test/open" }] },
      { type: "codeBlock", content: [{ type: "text", text: "https://api.example.test/x?access_token=synthetic" }] },
      { type: "paragraph", content: [{ type: "text", text: "https://storage.example.test/x?X-Amz-Signature=synthetic" }] },
    ] }), { includeBackground: false, includeTranscript: false });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.payload.markdown).toContain("[非公開リンクを省略]");
    expect(planned.payload.markdown).toContain("https://public.example.test/open");
    expect(planned.payload.markdown).not.toContain("10.0.0.2");
    expect(planned.payload.markdown).not.toContain("access_token");
    expect(planned.payload.markdown).not.toContain("X-Amz-Signature");
    expect(planned.omissions).toContainEqual({ reason: "private_link_removed", count: 3 });
  });

  it("does not treat public DNS names beginning with IPv6 prefixes as private", () => {
    const planned = planGoogleDocsBatchPayload(page({ blocks: [{ type: "paragraph", content: [
      { type: "text", text: "FDA", marks: [{ type: "link", attrs: { href: "https://fda.gov/guidance" } }] },
      { type: "text", text: "FC2", marks: [{ type: "link", attrs: { href: "https://fc2.com/" } }] },
      { type: "text", text: "private", marks: [{ type: "link", attrs: { href: "https://[fd12::1]/private" } }] },
    ] }] }), { includeBackground: false, includeTranscript: false });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.payload.markdown).toContain("[FDA](https://fda.gov/guidance)");
    expect(planned.payload.markdown).toContain("[FC2](https://fc2.com/)");
    expect(planned.payload.markdown).not.toContain("fd12::1");
    expect(planned.omissions).toContainEqual({ reason: "private_link_removed", count: 1 });
  });

  it("未知blockをcontentごと黙ってskipせず理由を数え、安全な通常linkは保つ", () => {
    const planned = planGoogleDocsBatchPayload(page({ blocks: [
      { type: "paragraph", content: [{ type: "text", text: "公開", marks: [{ type: "link", attrs: { href: "https://public.example.test/page" } }] }] },
      { type: "futureWidget", content: [{ type: "paragraph", content: [{ type: "text", text: "未対応の中身" }] }] },
    ] }), { includeBackground: false, includeTranscript: false });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.payload.markdown).toContain("[公開](https://public.example.test/page)");
    expect(planned.payload.markdown).not.toContain("未対応の中身");
    expect(planned.omissions).toContainEqual({ reason: "unsupported_block", count: 1 });
  });

  it("accepts only the exact encrypted payload schema", () => {
    expect(parseGoogleDocsBatchPayload({ schema: 1, title: "題名", markdown: "本文" })).toEqual({ schema: 1, title: "題名", markdown: "本文" });
    expect(parseGoogleDocsBatchPayload({ schema: 1, title: "題名", markdown: "本文", token: "no" })).toBeNull();
    expect(parseGoogleDocsBatchPayload({ schema: 2, title: "題名", markdown: "本文" })).toBeNull();
  });
});
