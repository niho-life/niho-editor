import { describe, expect, it } from "vitest";
import {
  API_ORIGIN,
  CONTRACT_VERSION,
  DESTS,
  ENDPOINTS,
  ERROR_CODES,
  ERROR_RETRYABLE,
  ERROR_STATUS,
  FACE_DESTS,
  HANDLE_PATTERN,
  IMAGE_CONTENT_TYPES,
  PREVIEW_TOKEN_MAX_TTL_SECONDS,
  PUBLISHED_LIMITS,
  RESERVED_HANDLES,
  RESPONSE_HEADERS,
  SLUG_MAX_LENGTH,
  SLUG_PATTERN,
  destOfHandle,
  isConnectionHandle,
  type ErrorBody,
  type GoneBody,
} from "../src/v1.js";

describe("v1 constants", () => {
  it("pins the version, origin, destinations and limits", () => {
    expect(CONTRACT_VERSION).toBe("1");
    expect(API_ORIGIN).toBe("https://api.editor.niho.life");
    expect(DESTS).toEqual(["exp", "niho", "site"]);
    expect(FACE_DESTS).toEqual(["exp", "niho"]);
    expect(PUBLISHED_LIMITS).toEqual({
      maxBlockChars: 20_000,
      maxBlocks: 2_000,
      maxDocBytes: 1_048_576,
      minLimit: 1,
      maxLimit: 100,
      defaultLimit: 50,
      maxAuthorRoleChars: 120,
      maxAuthorBioChars: 600,
    });
    expect(PREVIEW_TOKEN_MAX_TTL_SECONDS).toBe(900);
    expect(IMAGE_CONTENT_TYPES.some((type) => type.startsWith("audio/") || type.includes("svg"))).toBe(false);
  });

  it("maps every error code to its status and never uses 403", () => {
    expect(ERROR_CODES).toEqual(["invalid_request", "unauthenticated", "not_found", "gone", "rate_limited", "temporarily_unavailable"]);
    expect(ERROR_STATUS).toEqual({
      invalid_request: 400,
      unauthenticated: 401,
      not_found: 404,
      gone: 410,
      rate_limited: 429,
      temporarily_unavailable: 503,
    });
    expect(Object.values(ERROR_STATUS)).not.toContain(403);
    expect(Object.entries(ERROR_RETRYABLE).filter(([, retryable]) => retryable).map(([code]) => code))
      .toEqual(["rate_limited", "temporarily_unavailable"]);
    const notFound = { error: { code: "not_found", requestId: "req_x", retryable: false } } satisfies ErrorBody;
    const gone = { error: { code: "gone", requestId: "req_x", retryable: false }, movedTo: { dest: "niho", canonicalUrl: "https://niho.example.com/a" } } satisfies GoneBody;
    expect(notFound).not.toHaveProperty("movedTo");
    expect(gone.movedTo.dest).toBe("niho");
  });

  it("describes the three read-only endpoints", () => {
    expect(ENDPOINTS).toEqual({
      "published.list": {
        methods: ["GET", "HEAD"],
        path: "/v1/{handle}/published.json",
        query: ["limit", "cursor", "include"],
        response: "PublishedIndex",
        cacheControl: "private, no-cache",
      },
      "published.get": {
        methods: ["GET", "HEAD"],
        path: "/v1/{handle}/published/{id}.json",
        query: [],
        response: "PublishedDoc",
        cacheControl: "private, no-cache",
      },
      "preview.get": {
        methods: ["GET", "HEAD"],
        path: "/v1/preview/{token}.json",
        query: [],
        response: "PreviewDoc",
        cacheControl: "no-store",
      },
    });
    expect(RESPONSE_HEADERS).toEqual({
      contentType: "application/json; charset=utf-8",
      robotsTag: "noindex",
      vary: "Authorization",
      wwwAuthenticate: "Bearer",
    });
  });

  it("validates handles and keeps reserved names away from connections", () => {
    expect(RESERVED_HANDLES).toEqual(["exp", "niho", "preview", "v1", "api", "admin", "editor"]);
    for (const handle of ["abc", "my-site", "a1-b2", "x".repeat(32)]) expect(isConnectionHandle(handle)).toBe(true);
    for (const handle of ["ab", "x".repeat(33), "-abc", "abc-", "ABC", "a_b", "a.b", "", ...RESERVED_HANDLES]) {
      expect(isConnectionHandle(handle)).toBe(false);
    }
    expect(HANDLE_PATTERN.test("exp")).toBe(true);
    expect(destOfHandle("exp")).toBe("exp");
    expect(destOfHandle("niho")).toBe("niho");
    expect(destOfHandle("my-site")).toBe("site");
    expect(destOfHandle("preview")).toBeNull();
    expect(destOfHandle("Bad_Handle")).toBeNull();
  });

  it("defines slugs", () => {
    expect(SLUG_MAX_LENGTH).toBe(160);
    for (const slug of ["a", "morning-walk", "x1-2y"]) expect(SLUG_PATTERN.test(slug)).toBe(true);
    for (const slug of ["", "-a", "a-", "a--b", "A", "a_b", "a b"]) expect(SLUG_PATTERN.test(slug)).toBe(false);
  });
});
