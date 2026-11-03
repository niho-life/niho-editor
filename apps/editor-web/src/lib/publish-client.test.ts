import { afterEach, describe, expect, it, vi } from "vitest";
import { PUBLISH_MESSAGES } from "@/publish/messages";
import { loadPublishSheet, sheetQuery } from "./publish-client";

const PAGE = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";

afterEach(() => vi.unstubAllGlobals());

const answer = (body: BodyInit | null, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: { "content-type": "application/json" } })));

describe("sheetQuery", () => {
  it("明示的に空にした関連付けも送る", () => {
    expect(sheetQuery({ handle: "exp", range: "unlisted", extras: { app: false, news: false, xp: false }, slug: null, category: null, related: [] }))
      .toBe("?handle=exp&range=unlisted&extras=&related=");
  });
});

describe("loadPublishSheet", () => {
  it("returns the sheet of a good answer", async () => {
    answer(JSON.stringify({ sheet: { status: "private" } }));
    expect(await loadPublishSheet(PAGE, null)).toEqual({ ok: true, sheet: { status: "private" } });
  });

  it("returns a failure, not an exception, when the answer is not a sheet (another JSON, no JSON, null)", async () => {
    for (const body of [JSON.stringify({ results: [] }), "not json", "null", JSON.stringify({ sheet: null }), JSON.stringify({ sheet: "x" })]) {
      answer(body);
      expect(await loadPublishSheet(PAGE, null), body).toEqual({ ok: false, status: 200, error: null, message: PUBLISH_MESSAGES.unavailable });
    }
  });

  it("maps a refusal to the one-line message", async () => {
    answer(JSON.stringify({ error: "unauthorized" }), 401);
    expect(await loadPublishSheet(PAGE, null)).toMatchObject({ ok: false, status: 401, error: "unauthorized", message: PUBLISH_MESSAGES.signedOut });
  });
});
