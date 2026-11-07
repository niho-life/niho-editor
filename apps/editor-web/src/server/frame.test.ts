import { describe, expect, it } from "vitest";
import { frameMe, guessNarrow } from "./frame";

describe("frameMe", () => {
  it("uses the profile name and e-mail, and falls back without a profile", () => {
    expect(frameMe({ userId: "u", mode: "niho", profile: { name: "合成 太郎", email: "synthetic@example.invalid" } })).toEqual({
      name: "合成 太郎",
      caption: "synthetic@example.invalid",
      initial: "合",
    });
    expect(frameMe({ userId: "u", mode: "stub", profile: { name: "開発ユーザー" } })).toEqual({ name: "開発ユーザー", caption: "stub", initial: "開" });
    expect(frameMe({ userId: "u", mode: "niho" })).toEqual({ name: "名前を取得できません", caption: "", initial: "?" });
  });
});

describe("guessNarrow", () => {
  const headers = (init: Record<string, string>) => new Headers(init);

  it("reads the mobile client hint and common phone user agents", () => {
    expect(guessNarrow(headers({ "sec-ch-ua-mobile": "?1" }))).toBe(true);
    expect(guessNarrow(headers({ "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" }))).toBe(true);
    expect(guessNarrow(headers({ "user-agent": "Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari/537.36" }))).toBe(true);
    expect(guessNarrow(headers({ "sec-ch-ua-mobile": "?0", "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) Safari/605.1.15" }))).toBe(false);
    expect(guessNarrow(headers({}))).toBe(false);
  });
});
