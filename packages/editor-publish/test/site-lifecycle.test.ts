import { describe, expect, it } from "vitest";
import type { PublishResult } from "../src/index.js";
import { ACTOR, OTHER_ACTOR, PAGE_ID, SITE, createWorld } from "./support/world.js";

async function success(pending: Promise<PublishResult>) {
  const result = await pending;
  if (!result.ok) throw new Error(`unexpected ${result.reason}`);
  return result;
}

describe("personal-site publication history", () => {
  it("fixes content and author introduction in each immutable version", async () => {
    const w = createWorld();
    w.authors.set(ACTOR, { name: "Synthetic author", handle: null, url: null, profile: { role: "Guide", bio: "Synthetic biography" } });
    const first = await success(w.service.publish(w.input("site", { slug: "chosen-walk" })));
    const before = w.store.versions(PAGE_ID)[0];
    expect(first.url).toBe("https://notes.example.net/chosen-walk");
    expect(before?.snapshot).toMatchObject({ author: { name: "Synthetic author" }, authorProfile: { role: "Guide", bio: "Synthetic biography" }, category: null, related: [] });
    w.editDraft({ title: "Edited after publication" });
    w.authors.set(ACTOR, { name: "Synthetic author", handle: null, url: null, profile: { role: "Editor", bio: null } });
    expect(w.store.versions(PAGE_ID)).toEqual([before]);
    const second = await success(w.service.update(w.input("site")));
    expect(second).toMatchObject({ version: 2, url: first.url });
    expect(w.store.versions(PAGE_ID)[0]).toEqual(before);
    expect(w.store.versions(PAGE_ID)[1]?.snapshot).toMatchObject({ title: "Edited after publication", authorProfile: { role: "Editor", bio: null } });
    expect(second.publication.publishedAt).toBe(first.publication.publishedAt);
  });

  it("keeps the slug fixed through update, idempotent stop, and republication", async () => {
    const w = createWorld();
    const first = await success(w.service.publish(w.input("site")));
    expect(await w.service.update(w.input("site", { slug: "another-slug" }))).toMatchObject({ ok: false, reason: "slug_locked" });
    const stopped = await w.service.stop({ actorId: ACTOR, pageId: PAGE_ID });
    const state = w.store.dump();
    expect(await w.service.stop({ actorId: ACTOR, pageId: PAGE_ID })).toEqual(stopped);
    expect(w.store.dump()).toBe(state);
    expect(w.store.versions(PAGE_ID)).toHaveLength(1);
    const again = await success(w.service.publish(w.input("site")));
    expect(again).toMatchObject({ version: 2, url: first.url });
    expect(w.store.versions(PAGE_ID)).toHaveLength(2);
  });

  it("does not expose private port failures or mutate stored data", async () => {
    const w = createWorld();
    const before = w.store.dump();
    w.declarations.get = async () => { throw new Error("synthetic private failure details"); };
    const result = await w.service.publish(w.input("site"));
    expect(result).toEqual({ ok: false, reason: "failed", retryable: true });
    expect(JSON.stringify(result)).not.toContain("private failure");
    expect(w.store.dump()).toBe(before);
  });

  it("requires the caller's own live site connection", async () => {
    const w = createWorld();
    const before = w.store.dump();
    expect(await w.service.publish(w.input("site", { actorId: OTHER_ACTOR }))).toMatchObject({ ok: false, reason: "forbidden_destination", detail: "connection" });
    w.connections.disconnect(ACTOR, SITE);
    expect(await w.service.publish(w.input("site"))).toMatchObject({ ok: false, reason: "forbidden_destination", detail: "connection" });
    expect(w.store.dump()).toBe(before);
  });
});
