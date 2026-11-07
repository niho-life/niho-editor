import { describe, expect, it } from "vitest";
import { PUBLISHABLE_FACE_DESTS, roleAllows } from "../src/types.js";

describe("publication face roles", () => {
  it("offers no operating face even when legacy roles are present", () => {
    expect(PUBLISHABLE_FACE_DESTS).toEqual([]);
    expect(roleAllows(["writer"], "exp")).toBe(false);
    expect(roleAllows([], "exp")).toBe(false);
    expect(roleAllows(["resident", "experience_host"], "exp")).toBe(false);
  });

  it("keeps the legacy kamakura wire role from granting NIHO publication", () => {
    expect(roleAllows(["kamakura"], "niho")).toBe(false);
    expect(roleAllows(["writer", "kamakura"], "niho")).toBe(false);
  });
});
