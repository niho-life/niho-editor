import { PAGE_FIELD_LIMITS, PAGE_MAX_BYTES } from "@niho/editor-store";
import { describe, expect, it } from "vitest";
import { RECORDING_FIELD_LIMITS } from "@/lib/page-limits";
import { PAGE_BODY_MAX_BYTES } from "./http.ts";

/**
 * 画面の上限は、サーバー専用の module（editor-store）の値の写し（画面はその module を読めない。eslint の
 * no-restricted-imports）。食い違ったらここで落とす。
 */
describe("画面の上限はサーバーの値と同じ", () => {
  it("ページ要求の上限は30 MiBの内容とJSON envelope分", () => {
    expect(PAGE_BODY_MAX_BYTES).toBe(PAGE_MAX_BYTES + 16 * 1024);
  });

  it("フォルダの欄の件数", () => {
    expect(RECORDING_FIELD_LIMITS.entities).toBe(PAGE_FIELD_LIMITS.entities);
    expect(RECORDING_FIELD_LIMITS.terms).toBe(PAGE_FIELD_LIMITS.terms);
    expect(RECORDING_FIELD_LIMITS.backgroundChars).toBe(PAGE_FIELD_LIMITS.backgroundChars);
  });
});
