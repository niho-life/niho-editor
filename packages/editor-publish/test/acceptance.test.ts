import { describe, expect, it } from "vitest";
import { ACTOR, PAGE_ID, SETTINGS, createWorld } from "./support/world.js";

describe("operating destination acceptance", () => {
  it("keeps personal-site publishing available while all operating faces stay closed", async () => {
    const world = createWorld();
    expect(await world.service.publish(world.input("site"))).toMatchObject({ ok: true, publication: { dest: "site" } });

    const second = createWorld();
    for (const dest of ["exp", "niho"] as const) {
      const before = second.store.dump();
      expect(await second.service.publish({ actorId: ACTOR, pageId: PAGE_ID, target: { dest }, settings: SETTINGS[dest] }))
        .toEqual({ ok: false, reason: "forbidden_destination", detail: "role" });
      expect(second.store.dump()).toBe(before);
    }
  });

  it("allows an owner to stop a stored publication without consulting current face roles", async () => {
    const world = createWorld();
    expect((await world.service.publish(world.input("site"))).ok).toBe(true);
    world.roles.set(ACTOR, []);
    expect(await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID })).toMatchObject({ ok: true, status: "stopped" });
  });
});
