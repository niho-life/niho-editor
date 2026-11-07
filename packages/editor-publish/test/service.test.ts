import { describe, expect, it } from "vitest";
import type { FaceDest } from "@niho/editor-publish-contract";
import { ACTOR, PAGE_ID, SETTINGS, createWorld } from "./support/world.js";

describe("PublishService", () => {
  it.each(["exp", "niho"] as const)("refuses the retired %s face even with legacy roles and declarations", async (dest: FaceDest) => {
    const world = createWorld();
    const before = world.store.dump();
    expect(await world.service.publish({ actorId: ACTOR, pageId: PAGE_ID, target: { dest }, settings: SETTINGS[dest] }))
      .toEqual({ ok: false, reason: "forbidden_destination", detail: "role" });
    expect(world.store.dump()).toBe(before);
  });

  it("publishes, updates and stops a personal-site publication", async () => {
    const world = createWorld();
    const first = await world.service.publish(world.input("site"));
    expect(first).toMatchObject({ ok: true, publication: { dest: "site", handle: "example-notes", version: 1 } });
    world.editDraft({ title: "A revised coastal walk" });
    expect(await world.service.update(world.input("site"))).toMatchObject({ ok: true, version: 2 });
    expect(await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID })).toMatchObject({ ok: true, status: "stopped" });
    expect(world.store.versions(PAGE_ID)).toHaveLength(2);
  });

  it("does not let a retired face declaration restore publication", async () => {
    const world = createWorld();
    world.roles.set(ACTOR, ["writer"]);
    expect(await world.service.publish({ actorId: ACTOR, pageId: PAGE_ID, target: { dest: "exp" }, settings: SETTINGS.exp }))
      .toEqual({ ok: false, reason: "forbidden_destination", detail: "role" });
  });
});
