/** 保存先（design §2.1, Issue #50）: publishing needs the account's storage to be NIHO クラウド. */

import { describe, expect, it } from "vitest";
import { STORAGE_MODES, storageBlockOf, type PublishResult } from "../src/index.js";
import { ACTOR, PAGE_ID, createWorld } from "./support/world.js";

function ok(result: PublishResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result;
}

describe("storageBlockOf", () => {
  it("lets CLOUD and the never-chosen UNSET through", () => {
    expect(storageBlockOf("CLOUD")).toBeNull();
    expect(storageBlockOf("UNSET")).toBeNull();
  });

  it("blocks LOCAL and CLOSING by name", () => {
    expect(storageBlockOf("LOCAL")).toBe("LOCAL");
    expect(storageBlockOf("CLOSING")).toBe("CLOSING");
  });

  it.each([undefined, null, "", "cloud", "Local", 0, {}, ["CLOUD"]])("blocks a value it does not know (%s): fail closed", (value) => {
    expect(storageBlockOf(value)).toBe("unknown");
  });

  it("knows the same four names as DocsStorageMode", () => {
    expect([...STORAGE_MODES]).toEqual(["UNSET", "CLOUD", "CLOSING", "LOCAL"]);
  });
});

describe("PublishService and the storage mode", () => {
  it.each(["LOCAL", "CLOSING"] as const)("%s: publish, update and changeDestination are refused and write nothing", async (mode) => {
    const world = createWorld();
    ok(await world.service.publish(world.input("site")));
    world.storage.set(ACTOR, mode);
    const before = world.store.dump();
    const expected = { ok: false, reason: "storage_not_cloud", detail: mode };

    expect(await world.service.publish(world.input("site"))).toEqual(expected);
    expect(await world.service.update(world.input("site"))).toEqual(expected);
    expect(await world.service.changeDestination(world.input("site"))).toEqual(expected);
    expect(world.store.dump()).toBe(before);
  });

  it("refuses a first publication too", async () => {
    const world = createWorld();
    world.storage.set(ACTOR, "LOCAL");
    expect(await world.service.publish(world.input("site"))).toEqual({ ok: false, reason: "storage_not_cloud", detail: "LOCAL" });
    expect(world.store.publication(PAGE_ID)).toBeNull();
  });

  it("refuses a mode it does not know (fail closed)", async () => {
    const world = createWorld();
    world.storage.set(ACTOR, "ARCHIVED" as never);
    expect(await world.service.publish(world.input("site"))).toEqual({ ok: false, reason: "storage_not_cloud", detail: "unknown" });
  });

  it("stopping stays possible in every mode", async () => {
    for (const mode of ["LOCAL", "CLOSING"] as const) {
      const world = createWorld();
      ok(await world.service.publish(world.input("site")));
      world.storage.set(ACTOR, mode);
      const result = await world.service.stop({ actorId: ACTOR, pageId: PAGE_ID });
      expect(result, mode).toMatchObject({ ok: true, status: "stopped" });
      expect(world.store.publication(PAGE_ID)?.stoppedAt).not.toBeNull();
    }
  });

  it("treats UNSET like CLOUD", async () => {
    const world = createWorld();
    world.storage.set(ACTOR, "UNSET");
    ok(await world.service.publish(world.input("site")));
  });

  it("reads the mode on every operation and does not keep it", async () => {
    const world = createWorld();
    ok(await world.service.publish(world.input("site")));
    const reads = world.storage.reads;
    world.storage.set(ACTOR, "LOCAL");
    expect((await world.service.update(world.input("site"))).ok).toBe(false);
    world.storage.set(ACTOR, "CLOUD");
    ok(await world.service.update(world.input("site")));
    expect(world.storage.reads).toBe(reads + 2);
  });
});
