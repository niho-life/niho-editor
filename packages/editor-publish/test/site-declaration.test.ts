/** #41: the declaration editor builds for a connected site, and PublishService publishing through it. */

import { describe, expect, it } from "vitest";
import { BLOCK_TYPES, MARK_TYPES } from "@niho/editor-publish-contract";
import { connectionSource, parseDestinationDeclaration, siteDeclarationOf, siteDeclarationSource } from "../src/index.js";
import { MemoryDeclarations } from "../test-support/memory-store.js";
import { ACTOR, HANDLE, OTHER_ACTOR, OTHER_HANDLE, PAGE_ID, createSiteWorld } from "./support/site-world.js";
import { SETTINGS } from "./support/world.js";

describe("siteDeclarationSource", () => {
  it("builds a declaration that parseDestinationDeclaration accepts: no conditions, live only, no extras, everything accepted", async () => {
    const world = createSiteWorld();
    await world.connect({ urlShape: { host: "blog.example.net", path: "posts" } });
    const json = await siteDeclarationSource(world.store).get(HANDLE);
    const parsed = parseDestinationDeclaration(json);
    if (!parsed.ok) throw new Error("declaration refused");
    expect(parsed.value).toEqual({
      schemaVersion: 1,
      id: "site",
      label: "blog.example.net",
      host: "blog.example.net",
      path: "posts",
      ranges: ["live"],
      extras: [],
      accepts: { blocks: [...BLOCK_TYPES], marks: [...MARK_TYPES] },
      requires: [],
    });
  });

  it("is valid for any URL shape a connection can hold (long hosts fall back to the handle as label)", () => {
    const longHost = `${"a".repeat(60)}.${"b".repeat(60)}.example.net`;
    for (const urlShape of [{ host: "notes.example.net", path: "" }, { host: longHost, path: "a".repeat(64) }]) {
      const parsed = parseDestinationDeclaration(siteDeclarationOf({ handle: HANDLE, urlShape }));
      expect(parsed.ok).toBe(true);
      expect(parsed.ok && parsed.value.label).toBe(urlShape.host.length <= 80 ? urlShape.host : HANDLE);
    }
  });

  it("answers null for removed and unknown connections, and passes faces to the other source", async () => {
    const world = createSiteWorld();
    const { connectionId } = await world.connect();
    const faces = new MemoryDeclarations();
    faces.set("niho", { marker: true });
    const source = siteDeclarationSource(world.store, faces);
    expect(await source.get("unknown-notes")).toBeNull();
    expect(await source.get("niho")).toEqual({ marker: true });
    expect(await siteDeclarationSource(world.store).get("niho")).toBeNull();
    await world.connections.disconnect({ actorId: ACTOR, connectionId });
    expect(await source.get(HANDLE)).toBeNull();
  });
});

describe("connectionSource", () => {
  it("is true only for the owner's live connection", async () => {
    const world = createSiteWorld();
    const { connectionId } = await world.connect();
    const source = connectionSource(world.store);
    expect(await source.has(ACTOR, HANDLE)).toBe(true);
    expect(await source.has(OTHER_ACTOR, HANDLE)).toBe(false);
    expect(await source.has(ACTOR, OTHER_HANDLE)).toBe(false);
    expect(await source.has(ACTOR, "niho")).toBe(false);
    expect(await source.has("", HANDLE)).toBe(false);
    await world.connections.disconnect({ actorId: ACTOR, connectionId });
    expect(await source.has(ACTOR, HANDLE)).toBe(false);
  });
});

describe("PublishService through the connection adapters", () => {
  it("publishes to the owner's site at the connection's URL shape", async () => {
    const world = createSiteWorld();
    await world.connect({ urlShape: { host: "notes.example.net", path: "posts" } });
    const result = await world.publish();
    expect(result).toMatchObject({ ok: true, status: "published", url: "https://notes.example.net/posts/a-morning-walk-along-the-coast", publication: { dest: "site", handle: HANDLE } });
    expect(world.store.versions(PAGE_ID).at(-1)?.snapshot).toMatchObject({ dest: "site", canonicalUrl: "https://notes.example.net/posts/a-morning-walk-along-the-coast" });
  });

  it("refuses another owner's site, and limited release / extras the site does not offer", async () => {
    const world = createSiteWorld();
    await world.connect();
    await world.connect({ actorId: OTHER_ACTOR, handle: OTHER_HANDLE, siteUrl: "https://other.example.net" });
    expect(await world.publish(PAGE_ID, OTHER_HANDLE)).toEqual({ ok: false, reason: "forbidden_destination", detail: "connection" });
    const target = { dest: "site", handle: HANDLE } as const;
    expect(await world.publisher.publish({ actorId: ACTOR, pageId: PAGE_ID, target, settings: { range: "unlisted", extras: { app: false, news: false, xp: false }, category: null, related: [] } }))
      .toEqual({ ok: false, reason: "forbidden_destination", detail: "range" });
    expect(await world.publisher.publish({ actorId: ACTOR, pageId: PAGE_ID, target, settings: { range: "live", extras: { app: true, news: false, xp: false }, category: null, related: [] } }))
      .toEqual({ ok: false, reason: "forbidden_destination", detail: "extras" });
  });

  it("Experience still works through the same declaration source", async () => {
    const world = createSiteWorld();
    const result = await world.publisher.publish({
      actorId: ACTOR,
      pageId: PAGE_ID,
      target: { dest: "exp" },
      settings: SETTINGS.exp,
    });
    expect(result).toMatchObject({ ok: true, publication: { dest: "exp" } });
  });
});
