// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkStartupConfig } from "./startup-check";

describe("checkStartupConfig: public API settings (#40)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("ignores retired face credentials and reports an invalid rate limit without its value", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    checkStartupConfig({
      NODE_ENV: "test",
      EDITOR_AUTH_MODE: "stub",
      EDITOR_FACE_CREDENTIALS: "[{\"audience\":\"exp\",\"sha256\":\"secret-looking-value\"}]",
      EDITOR_PUBLIC_API_RATE_LIMIT_PER_MINUTE: "lots",
    });
    expect(exit).not.toHaveBeenCalled();
    expect(error.mock.calls).toEqual([["editor-web: EDITOR_PUBLIC_API_RATE_LIMIT_PER_MINUTE is invalid; using the default"]]);
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret-looking-value");
  });

  it("says nothing when they are unset or valid", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    checkStartupConfig({ NODE_ENV: "test", EDITOR_AUTH_MODE: "stub" });
    checkStartupConfig({
      NODE_ENV: "test",
      EDITOR_AUTH_MODE: "stub",
      EDITOR_FACE_CREDENTIALS: JSON.stringify([{ audience: "niho", sha256: "a".repeat(64), expiresAt: "2027-01-01T00:00:00.000Z" }]),
      EDITOR_PUBLIC_API_RATE_LIMIT_PER_MINUTE: "1200",
    });
    expect(error).not.toHaveBeenCalled();
  });
});

describe("checkStartupConfig: Google Docs durable batch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("batch modeだけを開いてruntime設定が欠けた状態では起動を止める", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    checkStartupConfig({ NODE_ENV: "test", EDITOR_AUTH_MODE: "stub", EDITOR_GOOGLE_DOCS_BATCH_MODE: "cloud-tasks" });
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.some(([message]) => String(message).includes("Google Docs batch runtime is incomplete"))).toBe(true);
  });
});
