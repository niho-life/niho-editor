import { parsePublishedDoc } from "@niho/editor-publish-contract";
import { describe, expect, it } from "vitest";
import { deriveStatus, draftFingerprint, resolveRedirect, type PublishResult } from "../src/index.js";
import { ACTOR, AUDIO, COVER, DECLARATIONS, FIGURE, OTHER_ACTOR, OTHER_PAGE, PAGE_2, PAGE_ID, SITE, addPage, createWorld, type World } from "./support/world.js";

const SLUG = "a-morning-walk-along-the-coast";

function ok(result: PublishResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result;
}

async function statusOf(world: World, pageId = PAGE_ID) {
  const publication = world.store.publication(pageId);
  const page = world.store.page(pageId);
  if (!page) throw new Error("no page");
  const assets = [COVER, FIGURE, AUDIO];
  const versions = world.store.versions(pageId);
  const current = versions.find((record) => record.version === publication?.version);
  return deriveStatus(
    publication && current ? { range: publication.range, stoppedAt: publication.stoppedAt, fingerprint: current.snapshot.fingerprint } : null,
    await draftFingerprint(page, assets),
  );
}

describe("publish", () => {
  it.each([
    ["exp", "https://exp.example.com/guides/a-morning-walk-along-the-coast"],
    ["niho", "https://niho.example.com/article/a-morning-walk-along-the-coast"],
    ["site", "https://notes.example.net/a-morning-walk-along-the-coast"],
  ] as const)("publishes to %s with a slug from the title", async (dest, url) => {
    const world = createWorld();
    const result = ok(await world.service.publish(world.input(dest)));
    expect(result).toMatchObject({ status: "published", version: 1, url, notices: [{ id: "recording-dropped" }] });
    expect(result.publication).toMatchObject({ pageId: PAGE_ID, slug: SLUG, version: 1, stoppedAt: null, handle: dest === "site" ? SITE : dest });
    const [version] = world.store.versions(PAGE_ID);
    expect(version?.snapshot.canonicalUrl).toBe(url);
    const { fingerprint: _fingerprint, ...doc } = version?.snapshot ?? {};
    expect(parsePublishedDoc(doc, { requireProjection: true }).ok).toBe(true);
    expect(await statusOf(world)).toBe("published");
  });

  it("publishes as limited release on a face", async () => {
    const world = createWorld();
    const result = ok(await world.service.publish(world.input("niho", { settings: { ...world.input("niho").settings, range: "unlisted" } })));
    expect(result.status).toBe("limited");
  });

  it("uses a slug chosen on the sheet", async () => {
    const world = createWorld();
    const result = ok(await world.service.publish(world.input("niho", { slug: "coast-walk" })));
    expect(result.url).toBe("https://niho.example.com/article/coast-walk");
  });

  it("stores the author, settings and time of publication in the version", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("exp")));
    const snapshot = world.store.versions(PAGE_ID)[0]?.snapshot;
    expect(snapshot).toMatchObject({
      author: { name: "Example Writer", handle: "example-writer", url: "https://writer.example.com/" },
      category: "walks",
      related: ["coastal-tea-ceremony"],
      extras: { app: true, news: false, xp: true },
      publishedAt: "2026-10-01T09:00:00.000Z",
      updatedAt: "2026-10-01T09:00:00.000Z",
    });
  });

  it("passes the related experiences to the facts source", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("exp")));
    expect(world.facts.queries).toEqual([{ actorId: ACTOR, pageId: PAGE_ID, dest: "exp", handle: "exp", related: ["coastal-tea-ceremony"] }]);
  });
});

describe("reasons", () => {
  it.each([
    ["an unknown page", { pageId: OTHER_PAGE }],
    ["a malformed page id", { pageId: "not-a-uuid" }],
    ["someone else's page", { actorId: OTHER_ACTOR }],
  ] as const)("not_found for %s", async (_name, patch) => {
    const world = createWorld();
    const before = world.store.dump();
    expect(await world.service.publish(world.input("niho", patch))).toEqual({ ok: false, reason: "not_found" });
    expect(world.store.dump()).toBe(before);
  });

  it("forbidden_destination without the role for the face", async () => {
    const world = createWorld();
    world.roles.set(ACTOR, ["kamakura"]);
    expect(await world.service.publish(world.input("exp"))).toEqual({ ok: false, reason: "forbidden_destination", detail: "role" });
    world.roles.set(ACTOR, ["writer", "resident"]);
    expect(await world.service.publish(world.input("niho"))).toEqual({ ok: false, reason: "forbidden_destination", detail: "role" });
  });

  it("forbidden_destination for a site that is not connected, or someone else's", async () => {
    const world = createWorld();
    world.connections.disconnect(ACTOR, SITE);
    expect(await world.service.publish(world.input("site"))).toEqual({ ok: false, reason: "forbidden_destination", detail: "connection" });
    world.connections.connect(OTHER_ACTOR, SITE);
    expect(await world.service.publish(world.input("site"))).toEqual({ ok: false, reason: "forbidden_destination", detail: "connection" });
  });

  it.each([
    ["a reserved handle", { dest: "site", handle: "admin" }],
    ["a malformed handle", { dest: "site", handle: "Not A Handle" }],
    ["an unknown dest", { dest: "blog" }],
    ["a face with another handle", { dest: "exp", handle: "niho" }],
  ])("forbidden_destination for %s", async (_name, target) => {
    const world = createWorld();
    expect(await world.service.publish(world.input("site", { target: target as never }))).toEqual({ ok: false, reason: "forbidden_destination", detail: "target" });
  });

  it("forbidden_destination for a range or an extra the destination does not offer", async () => {
    const world = createWorld();
    const site = world.input("site").settings;
    expect(await world.service.publish(world.input("site", { settings: { ...site, range: "unlisted" } }))).toEqual({ ok: false, reason: "forbidden_destination", detail: "range" });
    const niho = world.input("niho").settings;
    expect(await world.service.publish(world.input("niho", { settings: { ...niho, extras: { app: false, news: false, xp: true } } }))).toEqual({ ok: false, reason: "forbidden_destination", detail: "extras" });
    expect(await world.service.publish(world.input("niho", { settings: { ...niho, range: "public" as never } }))).toEqual({ ok: false, reason: "forbidden_destination", detail: "range" });
  });

  it("destination_unavailable when the declaration is missing, broken or for another destination", async () => {
    const world = createWorld();
    world.declarations.remove("niho");
    expect(await world.service.publish(world.input("niho"))).toEqual({ ok: false, reason: "destination_unavailable" });
    world.declarations.set("niho", { ...DECLARATIONS.niho, requires: [{ id: "x", kind: "lead", message: "m", fix: "lead", strict: true }] });
    expect(await world.service.publish(world.input("niho"))).toEqual({ ok: false, reason: "destination_unavailable" });
    world.declarations.set("niho", DECLARATIONS.exp);
    expect(await world.service.publish(world.input("niho"))).toEqual({ ok: false, reason: "destination_unavailable" });
    world.declarations.set("niho", "{not json");
    expect(await world.service.publish(world.input("niho"))).toEqual({ ok: false, reason: "destination_unavailable" });
  });

  it("not_ready with the problems, even though the sheet would have disabled the button", async () => {
    const world = createWorld();
    world.editDraft({ lead: null, lang: "ja" });
    const before = world.store.dump();
    const result = await world.service.publish(world.input("exp"));
    expect(result).toMatchObject({ ok: false, reason: "not_ready" });
    if (result.ok || result.reason !== "not_ready") return;
    expect(result.problems.map((problem) => problem.id)).toEqual(["lang-en"]);
    expect(world.store.dump()).toBe(before);
  });

  it("not_ready when related experiences are not known to be live", async () => {
    const world = createWorld();
    world.facts.set(ACTOR, { relatedLive: null });
    expect(await world.service.publish(world.input("exp"))).toMatchObject({ ok: false, reason: "not_ready", problems: [{ id: "related-live" }] });
  });

  it.each([
    ["Bad Slug", "format"],
    ["index", "reserved"],
    ["x".repeat(161), "length"],
  ] as const)("invalid_slug for %s", async (slug, detail) => {
    const world = createWorld();
    expect(await world.service.publish(world.input("niho", { slug }))).toEqual({ ok: false, reason: "invalid_slug", detail });
  });

  it("slug_taken when another page holds the slug on the destination, with a suggestion", async () => {
    const world = createWorld();
    addPage(world, PAGE_2);
    ok(await world.service.publish(world.input("niho", { pageId: PAGE_2, slug: "coast-walk" })));
    expect(await world.service.publish(world.input("niho", { slug: "coast-walk" }))).toEqual({ ok: false, reason: "slug_taken", suggestion: "coast-walk-2" });
    // The same slug is free on another destination.
    ok(await world.service.publish(world.input("exp", { slug: "coast-walk" })));
  });

  it("suggests past a numbered candidate another page holds under the stem of a 160-character slug", async () => {
    const world = createWorld();
    const page3 = "8b2e4c60-3d5f-4e70-8b92-1c3d4e5f6071";
    addPage(world, PAGE_2);
    addPage(world, page3);
    const full = "x".repeat(160);
    const stem = "x".repeat(155);
    ok(await world.service.publish(world.input("niho", { pageId: PAGE_2, slug: full })));
    ok(await world.service.publish(world.input("niho", { pageId: page3, slug: `${stem}-2` })));
    expect(await world.service.publish(world.input("niho", { slug: full }))).toEqual({ ok: false, reason: "slug_taken", suggestion: `${stem}-3` });
  });

  it("keeps a stopped page's slug reserved", async () => {
    const world = createWorld();
    addPage(world, PAGE_2);
    ok(await world.service.publish(world.input("niho", { pageId: PAGE_2, slug: "coast-walk" })));
    expect((await world.service.stop({ actorId: ACTOR, pageId: PAGE_2 })).ok).toBe(true);
    expect(await world.service.publish(world.input("niho", { slug: "coast-walk" }))).toEqual({ ok: false, reason: "slug_taken", suggestion: "coast-walk-2" });
  });

  it("keeps a slug reserved by another page's redirect", async () => {
    const world = createWorld();
    addPage(world, PAGE_2);
    ok(await world.service.publish(world.input("niho", { pageId: PAGE_2, slug: "coast-walk" })));
    ok(await world.service.changeDestination(world.input("exp", { pageId: PAGE_2 })));
    expect(await world.service.publish(world.input("niho", { slug: "coast-walk" }))).toEqual({ ok: false, reason: "slug_taken", suggestion: "coast-walk-2" });
  });

  it("adds -2 to the title's slug when another page holds it", async () => {
    const world = createWorld();
    addPage(world, PAGE_2);
    ok(await world.service.publish(world.input("niho", { pageId: PAGE_2 })));
    const result = ok(await world.service.publish(world.input("niho")));
    expect(result.publication.slug).toBe(`${SLUG}-2`);
  });

  it("uses p- and the page id for a Japanese title", async () => {
    const world = createWorld();
    world.editDraft({ title: "鎌倉の朝" });
    expect(ok(await world.service.publish(world.input("niho"))).publication.slug).toBe("p-6f0c2a4e");
  });

  it("failed (retryable) when a port throws; nothing is written", async () => {
    const world = createWorld();
    const before = world.store.dump();
    world.roles.read = async () => {
      throw new Error("NIHO is down");
    };
    expect(await world.service.publish(world.input("niho"))).toEqual({ ok: false, reason: "failed", retryable: true });
    const other = createWorld();
    other.authors.read = async () => {
      throw new Error("profile unavailable");
    };
    expect(await other.service.publish(other.input("niho"))).toEqual({ ok: false, reason: "failed", retryable: true });
    expect(world.store.dump()).toBe(before);
  });

  it("failed (not retryable) when the published version does not pass the contract; nothing is written", async () => {
    const world = createWorld();
    world.authors.set(ACTOR, { name: "  ", handle: null, url: null });
    const before = world.store.dump();
    expect(await world.service.publish(world.input("niho"))).toEqual({ ok: false, reason: "failed", retryable: false });
    expect(world.store.dump()).toBe(before);
  });

  it("puts no page, author or error details into results", async () => {
    const world = createWorld();
    world.roles.read = async () => {
      throw new Error("secret detail from NIHO");
    };
    expect(JSON.stringify(await world.service.publish(world.input("niho")))).not.toContain("secret");
  });
});

describe("roles are read from NIHO on every operation, never stored", () => {
  it("reads roles for publish, update and changeDestination", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("niho")));
    expect(world.roles.reads).toBe(1);
    ok(await world.service.update(world.input("niho")));
    expect(world.roles.reads).toBe(2);
    ok(await world.service.changeDestination(world.input("exp")));
    expect(world.roles.reads).toBe(3);
    expect(world.store.dump()).not.toContain("kamakura");
  });

  it("refuses an update after the role was taken away", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("exp")));
    world.roles.set(ACTOR, ["kamakura"]);
    expect(await world.service.update(world.input("exp"))).toEqual({ ok: false, reason: "forbidden_destination", detail: "role" });
  });

  it("lets the owner stop without any role", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("exp")));
    world.roles.set(ACTOR, []);
    const reads = world.roles.reads;
    expect((await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID })).ok).toBe(true);
    expect(world.roles.reads).toBe(reads);
  });
});

describe("update and save", () => {
  it("adds a new version from the edited draft and keeps the old one unchanged", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("niho")));
    const first = world.store.versions(PAGE_ID)[0];
    world.editDraft({ title: "A morning walk, revised" });
    expect(await statusOf(world)).toBe("updated");
    const result = ok(await world.service.update(world.input("niho")));
    expect(result).toMatchObject({ status: "published", version: 2, url: `https://niho.example.com/article/${SLUG}` });
    const [v1, v2] = world.store.versions(PAGE_ID);
    expect(v1).toEqual(first);
    expect(v1?.snapshot.title).toBe("A morning walk along the coast");
    expect(v2?.snapshot.title).toBe("A morning walk, revised");
    expect(v2?.snapshot.publishedAt).toBe(v1?.snapshot.publishedAt);
    expect(Date.parse(v2?.snapshot.updatedAt ?? "")).toBeGreaterThan(Date.parse(v1?.snapshot.updatedAt ?? ""));
    expect(world.store.publication(PAGE_ID)).toMatchObject({ version: 2, slug: SLUG, publishedAt: v1?.snapshot.publishedAt });
    expect(await statusOf(world)).toBe("published");
  });

  it("does not follow draft edits until updated", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("niho")));
    world.editDraft({ title: "Edited", lead: "Edited lead", content: [{ type: "paragraph", content: [{ type: "text", text: "Edited body" }] }] });
    const [v1] = world.store.versions(PAGE_ID);
    expect(v1?.snapshot).toMatchObject({ title: "A morning walk along the coast", lead: "Start early, follow the shoreline, and stop for tea." });
    expect(v1?.snapshot.markdown).not.toContain("Edited");
    expect(world.store.publication(PAGE_ID)?.version).toBe(1);
  });

  it("saves settings only as a new version with the same content", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("niho")));
    const settings = { ...world.input("niho").settings, category: "food", range: "unlisted" as const };
    const result = ok(await world.service.update(world.input("niho", { settings })));
    expect(result).toMatchObject({ status: "limited", version: 2 });
    const [v1, v2] = world.store.versions(PAGE_ID);
    expect(v2?.snapshot.fingerprint).toBe(v1?.snapshot.fingerprint);
    expect(v2?.snapshot).toMatchObject({ category: "food", range: "unlisted" });
  });

  it("refuses to change the slug after the first publication", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("niho")));
    expect(await world.service.update(world.input("niho", { slug: "other" }))).toEqual({ ok: false, reason: "slug_locked", slug: SLUG });
    expect(ok(await world.service.update(world.input("niho", { slug: SLUG }))).version).toBe(2);
  });

  it("re-evaluates the conditions on update", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("niho")));
    world.editDraft({ coverAssetId: "missing-cover" });
    expect(await world.service.update(world.input("niho"))).toMatchObject({ ok: false, reason: "not_ready", problems: [{ id: "cover" }] });
    expect(world.store.versions(PAGE_ID)).toHaveLength(1);
  });

  it.each([
    ["never published", async (_world: World) => undefined],
    ["stopped", async (world: World) => {
      ok(await world.service.publish(world.input("niho")));
      await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID });
    }],
    ["live on another destination", async (world: World) => {
      ok(await world.service.publish(world.input("exp")));
    }],
  ])("not_found when the page is %s", async (_name, setup) => {
    const world = createWorld();
    await setup(world);
    expect(await world.service.update(world.input("niho"))).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("stop and re-publication", () => {
  it("stops, keeps every version, and redirects a face URL to the list", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("niho")));
    const versions = world.store.versions(PAGE_ID);
    const result = await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID });
    expect(result).toMatchObject({ ok: true, status: "stopped", publication: { stoppedAt: "2026-10-01T09:01:00.000Z", slug: SLUG } });
    expect(world.store.versions(PAGE_ID)).toEqual(versions);
    expect(resolveRedirect(world.store.redirects(), { handle: "niho", slug: SLUG })).toBe("list");
    expect(await statusOf(world)).toBe("stopped");
  });

  it("makes no redirect for an owner's site", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("site")));
    expect((await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID })).ok).toBe(true);
    expect(world.store.redirects()).toEqual([]);
  });

  it("returns the same result when called again and writes nothing", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("niho")));
    const first = await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID });
    const before = world.store.dump();
    expect(await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID })).toEqual(first);
    expect(world.store.dump()).toBe(before);
  });

  it("not_found for a page that was never published or is not the actor's", async () => {
    const world = createWorld();
    expect(await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID })).toEqual({ ok: false, reason: "not_found" });
    ok(await world.service.publish(world.input("niho")));
    expect(await world.service.stop({ actorId: OTHER_ACTOR, pageId: PAGE_ID })).toEqual({ ok: false, reason: "not_found" });
    expect(await world.service.stop({ actorId: ACTOR, pageId: "nope" })).toEqual({ ok: false, reason: "not_found" });
  });

  it("re-publishes on the same slug, URL and id and removes the list redirect", async () => {
    const world = createWorld();
    const first = ok(await world.service.publish(world.input("niho")));
    await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID });
    const again = ok(await world.service.publish(world.input("niho")));
    expect(again.url).toBe(first.url);
    expect(again.publication).toMatchObject({ slug: SLUG, stoppedAt: null, version: 2, publishedAt: first.publication.publishedAt });
    expect(world.store.versions(PAGE_ID)[1]?.snapshot.id).toBe(PAGE_ID);
    expect(resolveRedirect(world.store.redirects(), { handle: "niho", slug: SLUG })).toBeNull();
  });

  it("refuses another slug when re-publishing on the same destination", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("niho")));
    await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID });
    expect(await world.service.publish(world.input("niho", { slug: "other" }))).toEqual({ ok: false, reason: "slug_locked", slug: SLUG });
  });

  it("can publish a stopped page on another destination; the old face URL keeps going to the list", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("niho")));
    await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID });
    const result = ok(await world.service.publish(world.input("exp", { slug: "coast-walk" })));
    expect(result.url).toBe("https://exp.example.com/guides/coast-walk");
    expect(resolveRedirect(world.store.redirects(), { handle: "niho", slug: SLUG })).toBe("list");
  });
});

describe("changeDestination", () => {
  it("face → face: redirects the old URL to the new one", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("niho")));
    const result = ok(await world.service.changeDestination(world.input("exp")));
    expect(result).toMatchObject({ status: "published", version: 2, url: `https://exp.example.com/guides/${SLUG}` });
    expect(result.publication).toMatchObject({ dest: "exp", handle: "exp", slug: SLUG });
    expect(resolveRedirect(world.store.redirects(), { handle: "niho", slug: SLUG })).toEqual({ handle: "exp", slug: SLUG });
  });

  it("face → site: redirects the old URL to the list", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("niho")));
    ok(await world.service.changeDestination(world.input("site")));
    expect(resolveRedirect(world.store.redirects(), { handle: "niho", slug: SLUG })).toBe("list");
  });

  it("site → face: does nothing to the old URL", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("site")));
    ok(await world.service.changeDestination(world.input("niho")));
    expect(world.store.redirects()).toEqual([]);
  });

  it("keeps chains one step long across several moves and a stop", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("niho")));
    ok(await world.service.changeDestination(world.input("exp")));
    ok(await world.service.changeDestination(world.input("site")));
    const redirects = world.store.redirects();
    expect(resolveRedirect(redirects, { handle: "niho", slug: SLUG })).toBe("list");
    expect(resolveRedirect(redirects, { handle: "exp", slug: SLUG })).toBe("list");
    expect(redirects.every((redirect) => redirect.to === "list")).toBe(true);
  });

  it("moving back removes the redirect from the live URL", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("niho")));
    ok(await world.service.changeDestination(world.input("exp")));
    ok(await world.service.changeDestination(world.input("niho")));
    const redirects = world.store.redirects();
    expect(resolveRedirect(redirects, { handle: "niho", slug: SLUG })).toBeNull();
    expect(resolveRedirect(redirects, { handle: "exp", slug: SLUG })).toEqual({ handle: "niho", slug: SLUG });
  });

  it("re-evaluates the conditions on the new destination", async () => {
    const world = createWorld();
    world.editDraft({ lang: "ja" });
    ok(await world.service.publish(world.input("niho")));
    const before = world.store.dump();
    expect(await world.service.changeDestination(world.input("exp"))).toMatchObject({ ok: false, reason: "not_ready", problems: [{ id: "lang-en" }] });
    expect(world.store.dump()).toBe(before);
  });

  it("slug_taken on the new destination, and a new slug can be chosen there", async () => {
    const world = createWorld();
    addPage(world, PAGE_2);
    ok(await world.service.publish(world.input("exp", { pageId: PAGE_2, slug: SLUG })));
    ok(await world.service.publish(world.input("niho")));
    expect(await world.service.changeDestination(world.input("exp", { slug: SLUG }))).toEqual({ ok: false, reason: "slug_taken", suggestion: `${SLUG}-2` });
    const moved = ok(await world.service.changeDestination(world.input("exp", { slug: "coast-walk" })));
    expect(moved.url).toBe("https://exp.example.com/guides/coast-walk");
    expect(resolveRedirect(world.store.redirects(), { handle: "niho", slug: SLUG })).toEqual({ handle: "exp", slug: "coast-walk" });
  });

  it("without a slug, keeps the current one or suggests -2", async () => {
    const world = createWorld();
    addPage(world, PAGE_2);
    ok(await world.service.publish(world.input("exp", { pageId: PAGE_2, slug: SLUG })));
    ok(await world.service.publish(world.input("niho")));
    expect(ok(await world.service.changeDestination(world.input("exp"))).publication.slug).toBe(`${SLUG}-2`);
  });

  it("not_found unless the page is live on another destination", async () => {
    const world = createWorld();
    expect(await world.service.changeDestination(world.input("exp"))).toEqual({ ok: false, reason: "not_found" });
    ok(await world.service.publish(world.input("exp")));
    expect(await world.service.changeDestination(world.input("exp"))).toEqual({ ok: false, reason: "not_found" });
    await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID });
    expect(await world.service.changeDestination(world.input("niho"))).toEqual({ ok: false, reason: "not_found" });
  });

  it("publish on a live page acts as update (same destination) or as a move (another one)", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("niho")));
    expect(ok(await world.service.publish(world.input("niho"))).version).toBe(2);
    ok(await world.service.publish(world.input("exp")));
    expect(resolveRedirect(world.store.redirects(), { handle: "niho", slug: SLUG })).toEqual({ handle: "exp", slug: SLUG });
  });

  it("never touches another page", async () => {
    const world = createWorld();
    addPage(world, PAGE_2);
    ok(await world.service.publish(world.input("niho", { pageId: PAGE_2, slug: "other-page" })));
    const other = JSON.stringify([world.store.publication(PAGE_2), world.store.versions(PAGE_2)]);
    ok(await world.service.publish(world.input("niho")));
    ok(await world.service.changeDestination(world.input("exp")));
    await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID });
    expect(JSON.stringify([world.store.publication(PAGE_2), world.store.versions(PAGE_2)])).toBe(other);
  });
});
