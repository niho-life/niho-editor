import { describe, expect, it } from "vitest";
import { AuthConfigError, isAllowedEmail, isTrustedNihoOrigin, parseAllowedEmails, resolveAuthMode } from "./config";
import { getAuthProvider, getPhotoAuthProvider } from "./index";
import { STUB_USER_ID } from "./stub";

const request = { headers: new Headers() };

// 合成のアドレスだけを使う（実際の許可リストは手元の deploy.env にあり、リポジトリには入れない）
const ALLOWED_ONE = "owner@example.test";
const ALLOWED_TWO = "owner.second@example.invalid";

describe("resolveAuthMode", () => {
  it("defaults to stub outside production", () => {
    expect(resolveAuthMode({ NODE_ENV: "development" })).toBe("stub");
    expect(resolveAuthMode({ NODE_ENV: "test" })).toBe("stub");
    expect(resolveAuthMode({})).toBe("stub");
    expect(resolveAuthMode({ NODE_ENV: "development", EDITOR_AUTH_MODE: "" })).toBe("stub");
  });

  it("accepts stub and niho explicitly outside production", () => {
    expect(resolveAuthMode({ NODE_ENV: "development", EDITOR_AUTH_MODE: "stub" })).toBe("stub");
    expect(resolveAuthMode({ NODE_ENV: "development", EDITOR_AUTH_MODE: "niho", EDITOR_NIHO_ORIGIN: "https://niho.example.invalid" })).toBe("niho");
  });

  it("requires niho in production and never falls back to stub", () => {
    expect(resolveAuthMode({ NODE_ENV: "production", EDITOR_AUTH_MODE: "niho", EDITOR_NIHO_ORIGIN: "https://niho.example.invalid" })).toBe("niho");
    expect(() => resolveAuthMode({ NODE_ENV: "production", EDITOR_AUTH_MODE: "stub" })).toThrow(AuthConfigError);
    expect(() => resolveAuthMode({ NODE_ENV: "production" })).toThrow(AuthConfigError);
    expect(() => resolveAuthMode({ NODE_ENV: "production", EDITOR_AUTH_MODE: "" })).toThrow(AuthConfigError);
  });

  it("rejects unknown values in every environment", () => {
    for (const NODE_ENV of ["development", "test", "production"]) {
      for (const EDITOR_AUTH_MODE of ["STUB", "none", "off", "niho2", "GOOGLE", "google-oauth"]) {
        expect(() => resolveAuthMode({ NODE_ENV, EDITOR_AUTH_MODE })).toThrow(AuthConfigError);
      }
    }
  });

  it("accepts google in production only with a non-empty allowlist (#47 の一時的な方式)", () => {
    const production = { NODE_ENV: "production", EDITOR_AUTH_MODE: "google" };
    expect(resolveAuthMode({ ...production, EDITOR_GOOGLE_ALLOWED_EMAILS: ALLOWED_ONE })).toBe("google");
    expect(resolveAuthMode({ ...production, EDITOR_GOOGLE_ALLOWED_EMAILS: `${ALLOWED_ONE},${ALLOWED_TWO}` })).toBe("google");
    // 許可リストが空・空白だけ・アドレスとして読めない値だけなら、port を開く前に落ちる
    for (const EDITOR_GOOGLE_ALLOWED_EMAILS of [undefined, "", "   ", ",,", "not-an-address", "@example.test", "owner@"]) {
      expect(() => resolveAuthMode({ ...production, EDITOR_GOOGLE_ALLOWED_EMAILS })).toThrow(AuthConfigError);
    }
    // 許可リストは google のときだけ要る（niho の守りは変わらない）
    expect(resolveAuthMode({ NODE_ENV: "production", EDITOR_AUTH_MODE: "niho", EDITOR_NIHO_ORIGIN: "https://niho.example.invalid" })).toBe("niho");
    // 本番以外では許可リストが無くても選べる（誰も許可リストに居ないので入れない）
    expect(resolveAuthMode({ NODE_ENV: "development", EDITOR_AUTH_MODE: "google" })).toBe("google");
  });
});

describe("EDITOR_NIHO_ORIGIN", () => {
  it("accepts only an exact HTTPS origin", () => {
    expect(isTrustedNihoOrigin("https://niho.example.invalid")).toBe(true);
    for (const value of [undefined, "", "http://localhost:3000", "https://user@niho.example.invalid", "https://niho.example.invalid/next", "https://niho.example.invalid?x=1"]) {
      expect(isTrustedNihoOrigin(value), String(value)).toBe(false);
    }
    expect(() => resolveAuthMode({ NODE_ENV: "production", EDITOR_AUTH_MODE: "niho" })).toThrow(/EDITOR_NIHO_ORIGIN/);
  });
});

describe("parseAllowedEmails", () => {
  it("reads one or more comma-separated addresses, ignoring case, spaces and empty items", () => {
    expect(parseAllowedEmails(ALLOWED_ONE)).toEqual([ALLOWED_ONE]);
    expect(parseAllowedEmails(`${ALLOWED_ONE},${ALLOWED_TWO}`)).toEqual([ALLOWED_ONE, ALLOWED_TWO]);
    expect(parseAllowedEmails(`  ${ALLOWED_ONE} , ${ALLOWED_TWO}  `)).toEqual([ALLOWED_ONE, ALLOWED_TWO]);
    expect(parseAllowedEmails(`${ALLOWED_ONE.toUpperCase()},${ALLOWED_TWO}`)).toEqual([ALLOWED_ONE, ALLOWED_TWO]);
    expect(parseAllowedEmails(`,${ALLOWED_ONE},,${ALLOWED_TWO},`)).toEqual([ALLOWED_ONE, ALLOWED_TWO]);
    // 同じアドレスは 1 つ
    expect(parseAllowedEmails(`${ALLOWED_ONE},${ALLOWED_ONE.toUpperCase()}`)).toEqual([ALLOWED_ONE]);
  });

  it("drops items that are not a single address", () => {
    expect(parseAllowedEmails(undefined)).toEqual([]);
    expect(parseAllowedEmails("")).toEqual([]);
    for (const raw of ["example.test", "@example.test", "owner@", "owner@a@b.test", "owner name@example.test", `${"a".repeat(320)}@example.test`]) {
      expect(parseAllowedEmails(raw), raw).toEqual([]);
    }
    // 読めない要素が混じっても、読める分は残る
    expect(parseAllowedEmails(`broken,${ALLOWED_ONE}`)).toEqual([ALLOWED_ONE]);
  });
});

describe("isAllowedEmail", () => {
  const allowed = parseAllowedEmails(`${ALLOWED_ONE},${ALLOWED_TWO}`);

  it("lets through exactly the listed addresses, ignoring case and surrounding spaces", () => {
    expect(isAllowedEmail(ALLOWED_ONE, allowed)).toBe(true);
    expect(isAllowedEmail(ALLOWED_TWO, allowed)).toBe(true);
    expect(isAllowedEmail(ALLOWED_ONE.toUpperCase(), allowed)).toBe(true);
    expect(isAllowedEmail(`  ${ALLOWED_TWO}  `, allowed)).toBe(true);
  });

  it("refuses anything else: a partial match, the same domain, an empty list", () => {
    for (const email of [
      undefined,
      "",
      "   ",
      "other@example.test",
      ALLOWED_ONE.replace("@", "+1@"),
      `x${ALLOWED_ONE}`,
      `${ALLOWED_ONE}.example.com`,
      ALLOWED_ONE.slice(0, -1),
      "owner@example.test.attacker.test",
    ]) {
      expect(isAllowedEmail(email, allowed), String(email)).toBe(false);
    }
    expect(isAllowedEmail(ALLOWED_ONE, [])).toBe(false);
  });
});

describe("auth providers", () => {
  it("stub returns one fixed synthetic user without cookies or tokens", async () => {
    const provider = getAuthProvider({ NODE_ENV: "development", EDITOR_AUTH_MODE: "stub" });
    expect(provider.mode).toBe("stub");
    const session = await provider.getSession(request);
    expect(session).toEqual({ userId: STUB_USER_ID, mode: "stub", profile: { name: "開発ユーザー" } });
    expect(Object.keys(session ?? {}).sort()).toEqual(["mode", "profile", "userId"]);
    const login = await provider.beginLogin({ request: new Request("http://editor.test/auth/login/start"), returnTo: "/p/new" });
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/p/new");
    expect(login.headers.get("set-cookie")).toBeNull();
  });

  it("selects the NIHO provider only with its trusted origin configured", () => {
    const env = { NODE_ENV: "production", EDITOR_AUTH_MODE: "niho", EDITOR_NIHO_ORIGIN: "https://niho.example.invalid" } as const;
    const provider = getAuthProvider(env);
    expect(provider.mode).toBe("niho");
    expect(getPhotoAuthProvider(env)).toBe(provider);
  });

  it("keeps the Docs provider while selecting NIHO only for photos with an explicit trusted origin", () => {
    const hybrid = {
      NODE_ENV: "production",
      EDITOR_AUTH_MODE: "google",
      EDITOR_GOOGLE_ALLOWED_EMAILS: ALLOWED_ONE,
      EDITOR_NIHO_ORIGIN: "https://niho.example.invalid",
    } as const;
    expect(getAuthProvider(hybrid).mode).toBe("google");
    expect(getPhotoAuthProvider(hybrid)?.mode).toBe("niho");
    expect(getPhotoAuthProvider({ ...hybrid, EDITOR_NIHO_ORIGIN: undefined })).toBeNull();
    expect(getPhotoAuthProvider({ NODE_ENV: "development", EDITOR_AUTH_MODE: "stub", EDITOR_NIHO_ORIGIN: "https://niho.example.invalid" })?.mode).toBe("niho");
    expect(getPhotoAuthProvider({ NODE_ENV: "development", EDITOR_AUTH_MODE: "stub" })).toBeNull();
  });

  it("does not bypass the production global-mode guard while selecting photo auth", () => {
    expect(() => getPhotoAuthProvider({ NODE_ENV: "production", EDITOR_NIHO_ORIGIN: "https://niho.example.invalid" })).toThrow(AuthConfigError);
    expect(() => getPhotoAuthProvider({ NODE_ENV: "production", EDITOR_AUTH_MODE: "google", EDITOR_NIHO_ORIGIN: "https://niho.example.invalid" })).toThrow(AuthConfigError);
  });

  it("refuses to pick a provider in production unless the mode is niho or google", () => {
    expect(() => getAuthProvider({ NODE_ENV: "production", EDITOR_AUTH_MODE: "stub" })).toThrow(AuthConfigError);
    expect(() => getAuthProvider({ NODE_ENV: "production" })).toThrow(AuthConfigError);
    expect(() => getAuthProvider({ NODE_ENV: "production", EDITOR_AUTH_MODE: "google" })).toThrow(AuthConfigError);
    const google = getAuthProvider({ NODE_ENV: "production", EDITOR_AUTH_MODE: "google", EDITOR_GOOGLE_ALLOWED_EMAILS: ALLOWED_ONE });
    expect(google.mode).toBe("google");
  });
});
