/** #41 接続の解除 and the list of pages published on a connection. */

import { describe, expect, it } from "vitest";
import { ConnectionService, deriveStatus } from "../src/index.js";
import { MemoryPublishStore } from "../test-support/memory-store.js";
import { ACTOR, OTHER_ACTOR, OTHER_HANDLE, PAGE_ID, createSiteWorld, type SiteWorld } from "./support/site-world.js";
import { SETTINGS } from "./support/world.js";

const PAGE_2 = "7a1d3b5f-2c4e-4d6f-9a81-0b2c3d4e5f60";
const PAGE_3 = "9c3f5d7b-4e6a-4b8c-9d0e-2f4a6b8c0d1e";
const OTHER_PAGE = "8b2e4c6a-3d5f-4e70-8b92-1c3d4e5f6a70";

/** Three pages on HANDLE (one already stopped), one on another owner's site. */
async function populated(): Promise<SiteWorld & { connectionId: string; otherConnectionId: string }> {
  const world = createSiteWorld();
  const { connectionId } = await world.connect();
  const other = await world.connect({ actorId: OTHER_ACTOR, handle: OTHER_HANDLE, siteUrl: "https://other.example.net" });
  world.addPage(PAGE_2, { title: "Second walk" });
  world.addPage(PAGE_3, { title: "Third walk" });
  world.addPage(OTHER_PAGE, { ownerId: OTHER_ACTOR, title: "Someone else's walk" });
  for (const pageId of [PAGE_ID, PAGE_2, PAGE_3]) expect((await world.publish(pageId)).ok).toBe(true);
  expect((await world.publish(OTHER_PAGE, OTHER_HANDLE, OTHER_ACTOR)).ok).toBe(true);
  expect((await world.publisher.stop({ actorId: ACTOR, pageId: PAGE_3 })).ok).toBe(true);
  return { ...world, connectionId, otherConnectionId: other.connectionId };
}

describe("disconnect", () => {
  it("revokes every key, removes the connection and stops every live page on it, in one go", async () => {
    const world = await populated();
    const versionsBefore = JSON.stringify([PAGE_ID, PAGE_2, PAGE_3].map((pageId) => world.store.versions(pageId)));
    const redirectsBefore = JSON.stringify(world.store.redirects());
    const otherBefore = JSON.stringify([world.store.publication(OTHER_PAGE), world.store.connection(world.otherConnectionId), world.store.keysOf(world.otherConnectionId)]);

    const result = await world.connections.disconnect({ actorId: ACTOR, connectionId: world.connectionId });
    if (!result.ok) throw new Error(result.reason);
    expect(result.revokedKeys).toBe(1);
    expect(result.stopped).toBe(2);
    expect(result.connection.removedAt).not.toBeNull();
    expect(result.connection.keys.every((key) => !key.active)).toBe(true);

    for (const pageId of [PAGE_ID, PAGE_2, PAGE_3]) {
      const publication = world.store.publication(pageId);
      expect(publication?.stoppedAt).not.toBeNull();
      const versions = world.store.versions(pageId);
      expect(deriveStatus(publication && { ...publication, fingerprint: versions.at(-1)?.snapshot.fingerprint ?? "" }, "")).toBe("stopped");
    }
    // The page stopped earlier keeps its own stop time.
    expect(world.store.publication(PAGE_3)?.stoppedAt).not.toBe(result.connection.removedAt);
    expect(world.store.publication(PAGE_ID)?.stoppedAt).toBe(result.connection.removedAt);
    // Versions stay, no redirect is made, the other owner's site is untouched.
    expect(JSON.stringify([PAGE_ID, PAGE_2, PAGE_3].map((pageId) => world.store.versions(pageId)))).toBe(versionsBefore);
    expect(JSON.stringify(world.store.redirects())).toBe(redirectsBefore);
    expect(JSON.stringify([world.store.publication(OTHER_PAGE), world.store.connection(world.otherConnectionId), world.store.keysOf(world.otherConnectionId)])).toBe(otherBefore);
    // Drafts stay.
    expect(world.store.page(PAGE_ID)?.title).toBe("A morning walk along the coast");
  });

  it("a second call changes nothing and reports 0 / 0", async () => {
    const world = await populated();
    const first = await world.connections.disconnect({ actorId: ACTOR, connectionId: world.connectionId });
    const dump = world.store.dump();
    const second = await world.connections.disconnect({ actorId: ACTOR, connectionId: world.connectionId });
    expect(second).toMatchObject({ ok: true, revokedKeys: 0, stopped: 0 });
    expect(first.ok && second.ok && second.connection).toEqual(first.ok && first.connection);
    expect(world.store.dump()).toBe(dump);
  });

  it("afterwards the site cannot be published to and its declaration is unavailable", async () => {
    const world = await populated();
    await world.connections.disconnect({ actorId: ACTOR, connectionId: world.connectionId });
    const before = world.store.dump();
    expect(await world.publish(PAGE_ID)).toEqual({ ok: false, reason: "forbidden_destination", detail: "connection" });
    expect(world.store.dump()).toBe(before);
    expect(await world.publisher.publish({ actorId: ACTOR, pageId: PAGE_ID, target: { dest: "exp" }, settings: SETTINGS.exp }))
      .toEqual({ ok: false, reason: "forbidden_destination", detail: "role" });
  });
});

describe("listPublished", () => {
  it("lists the pages on the connection with their status, stopped ones included, newest first", async () => {
    const world = await populated();
    world.editDraft({ title: "Second walk, revised" }, PAGE_2);
    const listed = await world.connections.listPublished({ actorId: ACTOR, connectionId: world.connectionId });
    if (!listed.ok) throw new Error(listed.reason);
    expect(listed.items.map((item) => [item.pageId, item.status])).toEqual([
      [PAGE_3, "stopped"],
      [PAGE_2, "updated"],
      [PAGE_ID, "published"],
    ]);
    expect(listed.items.find((item) => item.pageId === PAGE_2)).toMatchObject({ title: "Second walk", url: "https://notes.example.net/second-walk", slug: "second-walk", version: 1 });
    expect(listed.items.some((item) => item.pageId === OTHER_PAGE)).toBe(false);
  });

  it("after disconnecting, every page is still listed, as stopped", async () => {
    const world = await populated();
    await world.connections.disconnect({ actorId: ACTOR, connectionId: world.connectionId });
    const listed = await world.connections.listPublished({ actorId: ACTOR, connectionId: world.connectionId });
    if (!listed.ok) throw new Error(listed.reason);
    expect(listed.items).toHaveLength(3);
    expect(listed.items.every((item) => item.status === "stopped" && item.stoppedAt !== null)).toBe(true);
  });

  it("a page cannot move from the connection to a retired face", async () => {
    const world = await populated();
    const moved = await world.publisher.changeDestination({ actorId: ACTOR, pageId: PAGE_ID, target: { dest: "exp" }, settings: SETTINGS.exp });
    expect(moved).toEqual({ ok: false, reason: "forbidden_destination", detail: "role" });
    const listed = await world.connections.listPublished({ actorId: ACTOR, connectionId: world.connectionId });
    expect(listed.ok && listed.items.map((item) => item.pageId).sort()).toEqual([PAGE_ID, PAGE_2, PAGE_3].sort());
  });

  it("a page without a draft is never reported as updated", async () => {
    const world = await populated();
    const state = world.store.snapshotState();
    delete state.pages[PAGE_ID];
    const store = new MemoryPublishStore(state);
    const service = new ConnectionService({ store, clock: world.clock, drafts: { read: async () => null }, assetBytes: world.assetBytes });
    const listed = await service.listPublished({ actorId: ACTOR, connectionId: world.connectionId });
    expect(listed.ok && listed.items.find((item) => item.pageId === PAGE_ID)?.status).toBe("published");
  });
});

describe("handles", () => {
  it("a page cannot be published on another owner's site", async () => {
    const world = await populated();
    expect(await world.publish(PAGE_2, OTHER_HANDLE, ACTOR)).toEqual({ ok: false, reason: "forbidden_destination", detail: "connection" });
  });
});
