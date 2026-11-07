import { describe, expect, it } from "vitest";
import type { Session } from "../auth/types";
import { assetOriginOf, publishConfig } from "./config";
import { assetUrlsOf, NO_FACE_DECLARATIONS, NO_ROLES, sessionAuthors } from "./ports";

const SESSION: Session = { userId: "user-a", mode: "stub", profile: { name: "合成の書き手" } };

describe("公開の設定", () => {
  it("has no operated-face roles or declaration source", async () => {
    expect(await NO_ROLES.read("user-a")).toEqual([]);
    expect(await NO_FACE_DECLARATIONS.get("exp")).toBeNull();
    expect(await NO_FACE_DECLARATIONS.get("niho")).toBeNull();
  });

  it("ignores retired declaration configuration and keeps asset configuration", () => {
    expect(publishConfig({ EDITOR_AUTH_MODE: "stub", EDITOR_DESTINATION_DECLARATIONS: '{"exp":"https://upstream.invalid/declaration"}' }))
      .toEqual({ assetOrigin: null });
    expect(assetOriginOf("https://assets.example.com")).toBe("https://assets.example.com");
    expect(assetUrlsOf("https://assets.example.com").urlFor({ id: "a", sha256: "c".repeat(64), contentType: "image/webp" }))
      .toBe(`https://assets.example.com/assets/${"c".repeat(64)}.webp`);
  });

  it("keeps session authors for personal-site publishing", async () => {
    expect(await sessionAuthors(SESSION).read("user-a")).toEqual({ name: "合成の書き手", handle: null, url: null });
  });
});
