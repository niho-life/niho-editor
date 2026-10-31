import { PAGE_FIELD_LIMITS } from "@niho/editor-store";
import { describe, expect, it } from "vitest";
import { FOLDER_FIELD_LIMITS } from "@/lib/page-limits";

/**
 * 画面の上限は、サーバー専用の module（editor-store）の値の写し（画面はその module を読めない。eslint の
 * no-restricted-imports）。食い違ったらここで落とす。
 */
describe("画面の上限はサーバーの値と同じ", () => {
  it("フォルダの欄の件数", () => {
    expect(FOLDER_FIELD_LIMITS.entities).toBe(PAGE_FIELD_LIMITS.entities);
    expect(FOLDER_FIELD_LIMITS.terms).toBe(PAGE_FIELD_LIMITS.terms);
  });
});
