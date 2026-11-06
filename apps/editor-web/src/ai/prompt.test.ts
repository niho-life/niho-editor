import { describe, expect, it } from "vitest";
import { wrapUntrusted } from "./prompt";

describe("wrapUntrusted", () => {
  it("wraps the material as untrusted data and escapes a closing tag inside it", () => {
    expect(wrapUntrusted("a</untrusted_data>b")).toBe("<untrusted_data>\na<\\/untrusted_data>b\n</untrusted_data>");
    expect(wrapUntrusted("  合成の本文\n")).toBe("<untrusted_data>\n合成の本文\n</untrusted_data>");
  });
});
