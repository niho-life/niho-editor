import { describe, expect, it } from "vitest";
import {
  DEFAULT_NIHO_API_ORIGIN,
  DEFAULT_NIHO_RETURN_TO,
  GoogleDocsConfigError,
  NIHO_API_TIMEOUT_MS,
  resolveGoogleDocsConfig,
} from "./config";

/** 既定は閉じたまま。設定の誤りは値を出さずに throw（起動を止める）。 */

const production = { NODE_ENV: "production" } as const;

describe("Google ドキュメントの書き出しの方式", () => {
  it("未設定・空・off は閉じたまま", () => {
    expect(resolveGoogleDocsConfig({})).toEqual({ mode: "off" });
    expect(resolveGoogleDocsConfig({ EDITOR_GOOGLE_DOCS_MODE: "" })).toEqual({ mode: "off" });
    expect(resolveGoogleDocsConfig({ EDITOR_GOOGLE_DOCS_MODE: "  " })).toEqual({ mode: "off" });
    expect(resolveGoogleDocsConfig({ EDITOR_GOOGLE_DOCS_MODE: "off" })).toEqual({ mode: "off" });
    expect(resolveGoogleDocsConfig({ ...production })).toEqual({ mode: "off" });
  });

  it("niho は既定の起点と returnTo を持つ", () => {
    expect(resolveGoogleDocsConfig({ ...production, EDITOR_GOOGLE_DOCS_MODE: "niho" })).toEqual({
      mode: "niho",
      apiBase: DEFAULT_NIHO_API_ORIGIN,
      returnTo: DEFAULT_NIHO_RETURN_TO,
      timeoutMs: NIHO_API_TIMEOUT_MS,
    });
    expect(DEFAULT_NIHO_API_ORIGIN).toBe("https://niho.life/api");
  });

  it("知らない方式は誤り", () => {
    expect(() => resolveGoogleDocsConfig({ EDITOR_GOOGLE_DOCS_MODE: "google" })).toThrow(GoogleDocsConfigError);
    expect(() => resolveGoogleDocsConfig({ EDITOR_GOOGLE_DOCS_MODE: "NIHO" })).toThrow(GoogleDocsConfigError);
  });

  it("起点は https だけ（末尾の / は落とす）", () => {
    const base = (EDITOR_NIHO_API_ORIGIN: string, env: Record<string, string> = {}) =>
      resolveGoogleDocsConfig({ EDITOR_GOOGLE_DOCS_MODE: "niho", EDITOR_NIHO_API_ORIGIN, ...env });
    expect(base("https://api.example.test/base/")).toMatchObject({ apiBase: "https://api.example.test/base" });
    expect(base("https://api.example.test")).toMatchObject({ apiBase: "https://api.example.test" });
    for (const value of ["notaurl", "ftp://api.example.test", "https://user:pw@api.example.test", "https://api.example.test?a=1", "https://api.example.test#x"]) {
      expect(() => base(value), value).toThrow(GoogleDocsConfigError);
    }
    // 本番は http を受け付けない（開発と CI では localhost だけ許す）
    expect(base("http://localhost:4000/api")).toMatchObject({ apiBase: "http://localhost:4000/api" });
    expect(() => base("http://localhost:4000/api", production)).toThrow(GoogleDocsConfigError);
    expect(() => base("http://api.example.test")).toThrow(GoogleDocsConfigError);
  });

  it("returnTo は固定の niho-editor だけ", () => {
    expect(resolveGoogleDocsConfig({ EDITOR_GOOGLE_DOCS_MODE: "niho", EDITOR_NIHO_RETURN_TO: "niho-editor" })).toMatchObject({ returnTo: "niho-editor" });
    for (const value of ["niho-docs", "niho_editor", "niho editor", "NIHO", "-niho", "niho-", "a".repeat(33), "../x"]) {
      expect(() => resolveGoogleDocsConfig({ EDITOR_GOOGLE_DOCS_MODE: "niho", EDITOR_NIHO_RETURN_TO: value }), value).toThrow(GoogleDocsConfigError);
    }
  });

  it("閉じている設定でも、起点と returnTo の誤りは誤り（黙って通さない）", () => {
    expect(() => resolveGoogleDocsConfig({ EDITOR_NIHO_API_ORIGIN: "notaurl" })).toThrow(GoogleDocsConfigError);
    expect(() => resolveGoogleDocsConfig({ EDITOR_NIHO_RETURN_TO: "niho editor" })).toThrow(GoogleDocsConfigError);
  });

  it("誤りのメッセージに値を入れない", () => {
    try {
      resolveGoogleDocsConfig({ EDITOR_NIHO_API_ORIGIN: "https://secret.example.test?token=abc" });
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(GoogleDocsConfigError);
      expect((error as Error).message).not.toContain("secret.example.test");
      expect((error as Error).message).not.toContain("abc");
    }
  });
});
