import { describe, expect, it } from "vitest";
import { collectFacts, deriveStatus, draftFingerprint, sheetPlan } from "../src/index.js";
import { DECLARATIONS, PAGE_ID, SETTINGS, SITE, createWorld, readyPage } from "./support/world.js";

async function sitePlan(overrides: Partial<Parameters<typeof sheetPlan>[0]> = {}) {
  const world = createWorld();
  const page = readyPage();
  const assets = world.store.assetsOf(PAGE_ID);
  return sheetPlan({
    pageId: PAGE_ID,
    title: page.title,
    roles: ["writer", "kamakura"],
    storageMode: "CLOUD",
    sites: [SITE],
    declarations: { exp: DECLARATIONS.exp, niho: DECLARATIONS.niho, [SITE]: DECLARATIONS.site },
    selection: { handle: SITE, range: "live", extras: SETTINGS.site.extras, category: null, related: [], slug: null },
    publication: null,
    draftFingerprint: await draftFingerprint(page, assets),
    facts: collectFacts(page, assets, { relatedLive: true }, { category: null, related: [] }),
    ...overrides,
  });
}

describe("sheetPlan", () => {
  it("lists only personal sites even when legacy face declarations and roles exist", async () => {
    const plan = await sitePlan();
    expect(plan.destinations.map((item) => [item.handle, item.dest])).toEqual([[SITE, "site"]]);
    expect(plan.primary).toBe("publish");
  });

  it.each(["exp", "niho"] as const)("does not select legacy %s wire data", async (handle) => {
    const plan = await sitePlan({ selection: { handle, range: "live", extras: SETTINGS[handle].extras, category: null, related: [], slug: null } });
    expect(plan.selected).toBeNull();
    expect(plan.primary).toBeNull();
    expect(plan.destinations.some((item) => item.handle === handle)).toBe(false);
  });

  it("keeps the stored status stoppable without offering its retired face", async () => {
    const plan = await sitePlan({
      selection: null,
      publication: { handle: "exp", slug: "legacy", range: "live", extras: SETTINGS.exp.extras, category: "walks", related: [], stoppedAt: null, fingerprint: "legacy" },
    });
    expect(plan.canStop).toBe(true);
    expect(plan.primary).toBeNull();
    expect(plan.destinations.map((item) => item.dest)).toEqual(["site"]);
  });
});

describe("deriveStatus (docs-ui ShellStatusState)", () => {
  it.each([
    ["never published", null, "d".repeat(64), "private"],
    ["live and unchanged", { range: "live", stoppedAt: null, fingerprint: "d".repeat(64) }, "d".repeat(64), "published"],
    ["live with edits", { range: "live", stoppedAt: null, fingerprint: "e".repeat(64) }, "d".repeat(64), "updated"],
    ["limited and unchanged", { range: "unlisted", stoppedAt: null, fingerprint: "d".repeat(64) }, "d".repeat(64), "limited"],
    ["limited with edits", { range: "unlisted", stoppedAt: null, fingerprint: "e".repeat(64) }, "d".repeat(64), "updated"],
    ["stopped", { range: "live", stoppedAt: "2026-10-01T10:00:00.000Z", fingerprint: "d".repeat(64) }, "d".repeat(64), "stopped"],
    ["stopped with edits", { range: "unlisted", stoppedAt: "2026-10-01T10:00:00.000Z", fingerprint: "e".repeat(64) }, "d".repeat(64), "stopped"],
  ] as const)("%s → %s", (_name, publication, draft, status) => {
    expect(deriveStatus(publication, draft)).toBe(status);
  });
});
