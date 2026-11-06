import { describe, expect, it } from "vitest";
import { parseDestinationDeclaration } from "@niho/editor-publish";
import type { Session } from "../auth/types";
import { assetOriginOf, declarationUrlsOf, publishConfig, stubRolesOf } from "./config";
import { DEV_DECLARATIONS } from "./dev-declarations";
import { assetUrlsOf, faceDeclarations, roleReaderOf, sessionAuthors } from "./ports";

const SESSION: Session = { userId: "user-a", mode: "stub", profile: { name: "合成の書き手" } };
const FIREBASE_WEB_API_KEY = "A".repeat(39);

describe("公開の設定（環境変数）", () => {
  it("EDITOR_STUB_ROLES: 未設定は writer、空は役割なし、形の合わないものは捨てる", () => {
    expect(stubRolesOf(undefined)).toEqual(["writer"]);
    expect(stubRolesOf("")).toEqual([]);
    expect(stubRolesOf(" writer , Bad Role,writer,kamakura ")).toEqual(["writer", "kamakura"]);
  });

  it("EDITOR_DESTINATION_DECLARATIONS: https の URL だけ。読めない値は none（dev 用へ落とさない）", () => {
    expect(declarationUrlsOf(undefined)).toBeNull();
    expect(declarationUrlsOf(" ")).toBeNull();
    expect(declarationUrlsOf('{"exp":"https://experience.example.com/.well-known/niho-editor-destination.json"}')).toEqual({
      kind: "fetch",
      urls: { exp: "https://experience.example.com/.well-known/niho-editor-destination.json" },
    });
    for (const value of ["{", "[]", '{"exp":"http://experience.example.com/d.json"}', '{"site":"https://example.com/d.json"}', '{"exp":"https://user:pw@example.com/d.json"}']) {
      expect(declarationUrlsOf(value), value).toEqual({ kind: "none" });
    }
  });

  it("EDITOR_ASSET_ORIGIN: https の origin だけ", () => {
    expect(assetOriginOf("https://assets.example.com")).toBe("https://assets.example.com");
    expect(assetOriginOf("https://assets.example.com/")).toBe("https://assets.example.com");
    for (const value of [undefined, "", "http://assets.example.com", "https://assets.example.com/a", "https://assets.example.com/?x=1"]) {
      expect(assetOriginOf(value), String(value)).toBeNull();
    }
  });

  it("方式ごとの既定: stub は dev の宣言と既定の役割、niho は宣言も役割も無し（fail closed）", () => {
    expect(publishConfig({ EDITOR_AUTH_MODE: "stub" })).toEqual({ mode: "stub", stubRoles: ["writer"], declarations: { kind: "dev" }, assetOrigin: null });
    expect(publishConfig({ EDITOR_AUTH_MODE: "niho", EDITOR_NIHO_ORIGIN: "https://niho.example.invalid", EDITOR_NIHO_FIREBASE_API_KEY: FIREBASE_WEB_API_KEY, EDITOR_STUB_ROLES: "writer" })).toEqual({ mode: "niho", stubRoles: [], declarations: { kind: "none" }, assetOrigin: null });
  });
});

describe("dev の宣言", () => {
  it("どちらも editor-publish の検証を通り、条件は本文で直せるもの（見出し・未確認の印・題名の長さ・写真の代替テキスト）だけ", () => {
    for (const declaration of Object.values(DEV_DECLARATIONS)) {
      const parsed = parseDestinationDeclaration(declaration);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.requires.map((condition) => condition.kind).every((kind) => ["headings", "noConfirm", "title", "images"].includes(kind))).toBe(true);
      expect(parsed.value.requires.every((condition) => condition.fix === "body")).toBe(true);
    }
  });

  it("NIHO Experience は題名 110 字以内と写真の代替テキストを求める", () => {
    const parsed = parseDestinationDeclaration(DEV_DECLARATIONS.exp);
    if (!parsed.ok) throw new Error("rejected");
    expect(parsed.value.requires.filter((condition) => condition.kind === "title" || condition.kind === "images")).toEqual([
      { id: "title", kind: "title", max: 110, message: "題名を 110 字以内にしてください", fix: "body" },
      { id: "image-alt", kind: "images", alt: true, message: "写真に代替テキスト（alt）を入れてください", fix: "body" },
    ]);
  });

  it("faceDeclarations: dev は同梱の宣言（呼ぶたびに別の複製）、none は null", async () => {
    const dev = faceDeclarations({ kind: "dev" });
    const first = (await dev.get("exp")) as Record<string, unknown>;
    first.label = "changed";
    expect(((await dev.get("exp")) as Record<string, unknown>).label).toBe("NIHO Experience");
    expect(await dev.get("field-notes")).toBeNull();
    expect(await faceDeclarations({ kind: "none" }).get("exp")).toBeNull();
  });
});

describe("ポート", () => {
  it("役割: stub は設定の値を本人にだけ返す。niho は無し", async () => {
    const stub = roleReaderOf(publishConfig({ EDITOR_AUTH_MODE: "stub", EDITOR_STUB_ROLES: "writer" }), SESSION);
    expect(await stub.read("user-a")).toEqual(["writer"]);
    expect(await stub.read("user-b")).toEqual([]);
    expect(await roleReaderOf(publishConfig({ EDITOR_AUTH_MODE: "niho", EDITOR_NIHO_ORIGIN: "https://niho.example.invalid", EDITOR_NIHO_FIREBASE_API_KEY: FIREBASE_WEB_API_KEY }), { ...SESSION, mode: "niho" }).read("user-a")).toEqual([]);
  });

  it("著者: session の profile の名前（handle・url は null）。名前が無ければ例外（公開は失敗）", async () => {
    expect(await sessionAuthors(SESSION).read("user-a")).toEqual({ name: "合成の書き手", handle: null, url: null });
    await expect(sessionAuthors({ userId: "user-a", mode: "niho" }).read("user-a")).rejects.toThrow();
    await expect(sessionAuthors(SESSION).read("user-b")).rejects.toThrow();
  });

  it("著者: 公開用の著者紹介を読めれば profile として添える（無ければ名前だけ。読めなければ公開は失敗）", async () => {
    const profile = async () => ({ role: "合成の案内人", bio: null });
    expect(await sessionAuthors(SESSION, profile).read("user-a")).toEqual({ name: "合成の書き手", handle: null, url: null, profile: { role: "合成の案内人", bio: null } });
    expect(await sessionAuthors(SESSION, async () => null).read("user-a")).toEqual({ name: "合成の書き手", handle: null, url: null });
    await expect(sessionAuthors(SESSION, async () => {
      throw new Error("settings unavailable");
    }).read("user-a")).rejects.toThrow();
    // 本人でなければ紹介文を読みに行かない
    const reads: string[] = [];
    await expect(sessionAuthors(SESSION, async (actor) => {
      reads.push(actor);
      return null;
    }).read("user-b")).rejects.toThrow();
    expect(reads).toEqual([]);
  });

  it("写真の URL: `${origin}/assets/${sha256}.${ext}`。origin が無ければ例外", () => {
    const asset = { id: "a1", sha256: "c".repeat(64), contentType: "image/webp" };
    expect(assetUrlsOf("https://assets.example.com").urlFor(asset)).toBe(`https://assets.example.com/assets/${"c".repeat(64)}.webp`);
    expect(() => assetUrlsOf(null).urlFor(asset)).toThrow("EDITOR_ASSET_ORIGIN is not set");
    expect(() => assetUrlsOf("https://assets.example.com").urlFor({ ...asset, contentType: "image/svg+xml" })).toThrow();
  });
});
