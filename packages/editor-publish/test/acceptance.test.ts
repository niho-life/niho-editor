/** The three acceptance rows of #39 (docs/architecture/editor-publish-core.md「受入との対応」). */

import { describe, expect, it } from "vitest";
import {
  collectFacts,
  deriveStatus,
  draftFingerprint,
  resolveRedirect,
  sheetPlan,
  type DraftPage,
  type PublishResult,
  type SheetPlanInput,
} from "../src/index.js";
import { SCENARIOS } from "./support/scenarios.js";
import {
  ACTOR,
  AUDIO,
  COVER,
  DECLARATIONS,
  FIGURE,
  PAGE_ID,
  SETTINGS,
  SITE,
  TARGETS,
  createWorld,
  readyPage,
  type DestName,
  type World,
} from "./support/world.js";

const ASSETS = [COVER, FIGURE, AUDIO];
const SLUG = "a-morning-walk-along-the-coast";

function handleOf(dest: DestName): string {
  return dest === "site" ? SITE : dest;
}

async function sheet(world: World, dest: DestName): Promise<ReturnType<typeof sheetPlan>> {
  const page = world.store.page(PAGE_ID) as DraftPage;
  const settings = SETTINGS[dest];
  const input: SheetPlanInput = {
    pageId: PAGE_ID,
    title: page.title,
    roles: await world.roles.read(ACTOR),
    storageMode: "CLOUD",
    sites: [SITE],
    declarations: { exp: DECLARATIONS.exp, niho: DECLARATIONS.niho, [SITE]: DECLARATIONS.site },
    selection: { handle: handleOf(dest), ...settings, slug: null },
    publication: null,
    draftFingerprint: await draftFingerprint(page, ASSETS),
    facts: collectFacts(page, ASSETS, await world.facts.read({
      actorId: ACTOR,
      pageId: PAGE_ID,
      dest: TARGETS[dest].dest,
      handle: handleOf(dest),
      related: settings.related,
    }), { category: settings.category, related: settings.related }),
  };
  return sheetPlan(input);
}

/** For each destination: one thing its conditions need, and how the author fixes it. */
const MISSING: readonly { dest: DestName; name: string; break: Partial<DraftPage>; problem: string }[] = [
  { dest: "exp", name: "English", break: { lang: "ja" }, problem: "lang-en" },
  { dest: "exp", name: "a heading", break: { content: [{ type: "paragraph", content: [{ type: "text", text: "Only text." }] }] }, problem: "headings" },
  { dest: "exp", name: "no CONFIRM", break: { title: "Walk [CONFIRM: name]" }, problem: "no-confirm" },
  { dest: "site", name: "a title", break: { title: "" }, problem: "title" },
  { dest: "site", name: "a body", break: { content: [] }, problem: "body" },
];

describe("条件がそろうまで公開ボタンが押せない", () => {
  it.each(["exp", "niho", "site"] as const)("%s: リードとカバーが未設定でも公開・更新できる", async (dest) => {
    const world = createWorld();
    world.editDraft({ coverAssetId: null, lead: null });
    expect((await sheet(world, dest)).primary).toBe("publish");
    expect(await world.service.publish(world.input(dest))).toMatchObject({ ok: true, version: 1 });
    expect(world.store.versions(PAGE_ID)[0]?.snapshot).toMatchObject({ cover: null, lead: null });

    world.editDraft({ title: "A revised title" });
    expect(await world.service.update(world.input(dest))).toMatchObject({ ok: true, version: 2 });
    expect(world.store.versions(PAGE_ID)[1]?.snapshot).toMatchObject({ cover: null, lead: null });
  });

  it.each(MISSING.map((entry) => [entry.dest, entry.name, entry] as const))("%s: without %s the button is disabled and publishing is refused", async (_dest, _name, entry) => {
    const world = createWorld();
    const original = world.store.page(PAGE_ID) as DraftPage;
    world.editDraft(entry.break);

    const blocked = await sheet(world, entry.dest);
    expect(blocked.primary).toBeNull();
    expect(blocked.problems.map((problem) => problem.id)).toContain(entry.problem);

    // The service does not trust the sheet: pressing anyway is refused and nothing is written.
    const before = world.store.dump();
    const refused = await world.service.publish(world.input(entry.dest));
    expect(refused).toMatchObject({ ok: false, reason: "not_ready" });
    expect(world.store.dump()).toBe(before);

    // Once fixed, the button is enabled and publishing goes through.
    world.editDraft(original);
    const ready = await sheet(world, entry.dest);
    expect(ready.problems).toEqual([]);
    expect(ready.primary).toBe("publish");
    expect((await world.service.publish(world.input(entry.dest))).ok).toBe(true);
  });

  it("exp: the button stays disabled while related experiences are not known to be live", async () => {
    const world = createWorld();
    const page = world.store.page(PAGE_ID) as DraftPage;
    const facts = collectFacts(page, ASSETS, { relatedLive: null }, { category: "walks", related: ["coastal-tea-ceremony"] });
    const plan = sheetPlan({
      pageId: PAGE_ID,
      title: page.title,
      roles: ["writer"],
      storageMode: "CLOUD",
      sites: [],
      declarations: { exp: DECLARATIONS.exp },
      selection: { handle: "exp", ...SETTINGS.exp, slug: null },
      publication: null,
      draftFingerprint: await draftFingerprint(page, ASSETS),
      facts,
    });
    expect(plan.primary).toBeNull();
    world.facts.set(ACTOR, { relatedLive: null });
    expect(await world.service.publish(world.input("exp"))).toMatchObject({ ok: false, reason: "not_ready", problems: [{ id: "related-live" }] });
  });

  it("keeps an unchanged final-stage title out of the sheet and refuses publish until it is edited", async () => {
    const world = createWorld();
    world.editDraft({ title: "記事本文" });
    world.facts.set(ACTOR, { relatedLive: true, finalStepNames: ["旧・記事本文", "記事本文"] });

    const blocked = await sheet(world, "niho");
    expect(blocked.primary).toBeNull();
    expect(blocked.problems.map((problem) => problem.id)).toEqual(["step-title"]);
    const before = world.store.dump();
    expect(await world.service.publish(world.input("niho"))).toMatchObject({ ok: false, reason: "not_ready", problems: [{ id: "step-title" }] });
    expect(world.store.dump()).toBe(before);

    world.editDraft({ title: "海辺の朝" });
    const ready = await sheet(world, "niho");
    expect(ready.primary).toBe("publish");
    expect(ready.problems).toEqual([]);
    expect((await world.service.publish(world.input("niho"))).ok).toBe(true);
  });

  it("a destination whose declaration is broken cannot be published to (fail closed)", async () => {
    const world = createWorld();
    world.declarations.set("niho", { ...DECLARATIONS.niho, requires: [{ id: "x", kind: "somethingNew", message: "m", fix: "body" }] });
    expect(await world.service.publish(world.input("niho"))).toEqual({ ok: false, reason: "destination_unavailable" });
  });
});

describe("公開に失敗しても前の公開版と下書きが残る", () => {
  async function publishedThenEdited(): Promise<World> {
    const world = createWorld();
    const result: PublishResult = await world.service.publish(world.input("niho"));
    expect(result.ok).toBe(true);
    world.editDraft({ title: "A morning walk, revised", lead: "A revised lead." });
    return world;
  }

  it.each([
    ["update", (world: World) => world.service.update(world.input("niho"))],
    ["stop", (world: World) => world.service.stop({ actorId: ACTOR, pageId: PAGE_ID })],
    ["changeDestination", (world: World) => world.service.changeDestination(world.input("exp"))],
  ] as const)("%s: a failure at any store call keeps the previous version, the draft and the redirects", async (_name, operation) => {
    const probe = await publishedThenEdited();
    probe.store.resetCallCount();
    expect((await operation(probe)).ok).toBe(true);
    for (let k = 1; k <= probe.store.callCount; k += 1) {
      const world = await publishedThenEdited();
      const version = world.store.versions(PAGE_ID);
      const draft = world.store.page(PAGE_ID);
      const publication = world.store.publication(PAGE_ID);
      const redirects = world.store.redirects();
      world.store.failOnCall(k);
      expect(await operation(world)).toEqual({ ok: false, reason: "failed", retryable: true });
      expect(world.store.versions(PAGE_ID)).toEqual(version);
      expect(world.store.versions(PAGE_ID)[0]?.snapshot.title).toBe("A morning walk along the coast");
      expect(world.store.page(PAGE_ID)).toEqual(draft);
      expect(world.store.page(PAGE_ID)?.title).toBe("A morning walk, revised");
      expect(world.store.publication(PAGE_ID)).toEqual(publication);
      expect(world.store.redirects()).toEqual(redirects);
      const current = world.store.versions(PAGE_ID)[0];
      expect(deriveStatus(
        { range: "live", stoppedAt: null, fingerprint: current?.snapshot.fingerprint ?? "" },
        await draftFingerprint(world.store.page(PAGE_ID) as DraftPage, ASSETS),
      )).toBe("updated");
    }
  });

  it("publish: a failure at any store call leaves the page private with its draft", async () => {
    const probe = createWorld();
    probe.store.resetCallCount();
    expect((await probe.service.publish(probe.input("exp"))).ok).toBe(true);
    for (let k = 1; k <= probe.store.callCount; k += 1) {
      const world = createWorld();
      const draft = world.store.page(PAGE_ID);
      world.store.failOnCall(k);
      expect(await world.service.publish(world.input("exp"))).toEqual({ ok: false, reason: "failed", retryable: true });
      expect(world.store.publication(PAGE_ID)).toBeNull();
      expect(world.store.versions(PAGE_ID)).toEqual([]);
      expect(world.store.page(PAGE_ID)).toEqual(draft);
    }
  });

  it("covers every operation in the exhaustive atomicity suite", () => {
    const names = SCENARIOS.map((scenario) => scenario.name).join(" ");
    for (const operation of ["publish", "update", "stop", "changeDestination"]) expect(names).toContain(operation);
  });
});

describe("公開をやめた記事の URL が一覧へ転送される（NIHO の面）", () => {
  it.each(["exp", "niho"] as const)("%s: after stop, the old URL resolves to the list", async (dest) => {
    const world = createWorld();
    expect((await world.service.publish(world.input(dest))).ok).toBe(true);
    expect(resolveRedirect(world.store.redirects(), { handle: dest, slug: SLUG })).toBeNull();
    expect(await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID })).toMatchObject({ ok: true, status: "stopped" });
    expect(world.store.redirects()).toEqual([
      { from: { handle: dest, slug: SLUG }, to: "list", pageId: PAGE_ID, createdAt: "2026-10-01T09:01:00.000Z" },
    ]);
    expect(resolveRedirect(world.store.redirects(), { handle: dest, slug: SLUG })).toBe("list");
  });

  it("older URLs of a moved page also go to the list after stop (one step)", async () => {
    const world = createWorld();
    expect((await world.service.publish(world.input("niho"))).ok).toBe(true);
    expect((await world.service.changeDestination(world.input("exp"))).ok).toBe(true);
    expect((await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID })).ok).toBe(true);
    const redirects = world.store.redirects();
    expect(redirects.map((redirect) => redirect.to)).toEqual(["list", "list"]);
    expect(resolveRedirect(redirects, { handle: "niho", slug: SLUG })).toBe("list");
    expect(resolveRedirect(redirects, { handle: "exp", slug: SLUG })).toBe("list");
  });

  it("an owner's site gets no redirect promise", async () => {
    const world = createWorld();
    expect((await world.service.publish({ actorId: ACTOR, pageId: PAGE_ID, target: TARGETS.site, settings: SETTINGS.site })).ok).toBe(true);
    expect((await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID })).ok).toBe(true);
    expect(resolveRedirect(world.store.redirects(), { handle: SITE, slug: SLUG })).toBeNull();
  });

  it("re-publishing brings the same URL back and removes the redirect", async () => {
    const world = createWorld();
    const first = await world.service.publish(world.input("niho"));
    await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID });
    const again = await world.service.publish(world.input("niho"));
    expect(again.ok && first.ok && again.url === first.url).toBe(true);
    expect(resolveRedirect(world.store.redirects(), { handle: "niho", slug: SLUG })).toBeNull();
    expect(readyPage().id).toBe(PAGE_ID);
  });
});
