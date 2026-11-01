import { describe, expect, it } from "vitest";
import { loginStartLocation } from "./LoginView";

describe("LoginView login start path", () => {
  it("keeps the existing Docs start path as the default contract", () => {
    expect(loginStartLocation("/auth/login/start", null)).toBe("/auth/login/start");
    expect(loginStartLocation("/auth/login/start", "/settings")).toBe("/auth/login/start?next=%2Fsettings");
  });

  it("builds the narrow photo-scoped start path", () => {
    expect(loginStartLocation("/photo/auth/start", null)).toBe("/photo/auth/start");
    expect(loginStartLocation("/photo/auth/start", "/photo/trash")).toBe("/photo/auth/start?next=%2Fphoto%2Ftrash");
  });
});
