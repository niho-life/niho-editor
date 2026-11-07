import { describe, expect, it } from "vitest";
import type { DraftPage } from "@niho/editor-publish";
import { MemoryPublishStore } from "@niho/editor-publish/test-support";
import type { AuthProvider, Session } from "../auth/types";
import { snapshot } from "../public-api/testing/synthetic";
import { wirePublishPorts } from "../publish/ports";
import { getPublishSheetRoute, placeBodyOf, publishRoute, selectionQueryOf, type PublishApiDeps } from "./publish-api";

const ORIGIN = "http://editor.test";
const PAGE = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
const SESSION: Session = { userId: "user-a", mode: "stub", profile: { name: "合成の書き手" } };
const page: DraftPage = { id: PAGE, ownerId: SESSION.userId, title: "Morning walk", lang: "ja", lead: null, coverAssetId: null, content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }] };
const auth: AuthProvider = { mode: "stub", getSession: async () => SESSION, beginLogin: async () => new Response(), completeLogin: async () => new Response(), logout: async () => new Response() };

function setup() {
  const store = new MemoryPublishStore();
  store.putPage(page);
  const wiring = wirePublishPorts(store, SESSION, { env: { EDITOR_AUTH_MODE: "stub" } });
  const deps: PublishApiDeps = { auth: () => auth, ports: () => wiring, env: {} };
  return { store, wiring, deps };
}

describe("publish API", () => {
  it("keeps legacy wire parsing but does not offer or select exp", async () => {
    expect(selectionQueryOf(new URLSearchParams("handle=exp&range=live&extras="))).toMatchObject({ ok: true, value: { handle: "exp" } });
    const { deps } = setup();
    const response = await getPublishSheetRoute(new Request(`${ORIGIN}/api/pages/${PAGE}/publish?handle=exp&range=live&extras=`), PAGE, deps);
    expect(response.status).toBe(200);
    const sheet = ((await response.json()) as { sheet: { destinations: unknown[]; selection: unknown; primary: unknown } }).sheet;
    expect(sheet.destinations).toEqual([]);
    expect(sheet.selection).toBeNull();
    expect(sheet.primary).toBeNull();
  });

  it("rejects exp publication server-side without writing", async () => {
    const parsed = placeBodyOf({ handle: "exp", range: "live", extras: { app: false, news: false, xp: false }, category: null, related: [] });
    expect(parsed.ok).toBe(true);
    const { store, deps } = setup();
    const before = store.dump();
    const response = await publishRoute(new Request(`${ORIGIN}/api/pages/${PAGE}/publish`, {
      method: "POST", headers: { host: "editor.test", origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ handle: "exp", range: "live", extras: { app: false, news: false, xp: false }, category: null, related: [] }),
    }), PAGE, deps);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "forbidden_destination", detail: "role" });
    expect(store.dump()).toBe(before);
  });
});


it("hides a retained Experience publication from the sheet without changing its saved version", async () => {
  const { store, deps } = setup();
  const at = "2026-11-01T00:00:00.000Z";
  await store.transaction(async (tx) => {
    await tx.addVersion({ pageId: PAGE, version: 1, handle: "exp", snapshot: { ...snapshot({ id: PAGE, dest: "exp", slug: "legacy-walk", title: "Legacy walk", updatedAt: at }), range: "live", fingerprint: "f".repeat(64) } });
    await tx.putPublication({ pageId: PAGE, dest: "exp", handle: "exp", slug: "legacy-walk", range: "live", extras: { app: false, news: false, xp: false }, category: null, related: [], version: 1, publishedAt: at, updatedAt: at, stoppedAt: null });
  });
  const before = store.dump();
  const response = await getPublishSheetRoute(new Request(`${ORIGIN}/api/pages/${PAGE}/publish`), PAGE, deps);
  expect(response.status).toBe(200);
  expect((await response.json()).sheet).toMatchObject({ status: "private", publication: null, selection: null, canStop: false });
  expect(store.dump()).toBe(before);
});
