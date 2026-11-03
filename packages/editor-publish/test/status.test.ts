import { describe, expect, it } from "vitest";
import {
  collectFacts,
  deriveStatus,
  draftFingerprint,
  sheetPlan,
  type DraftPage,
  type FactChoices,
  type SheetPlanInput,
  type SheetPublication,
  type SheetSelection,
} from "../src/index.js";
import { AUDIO, COVER, DECLARATIONS, FIGURE, PAGE_ID, SETTINGS, SITE, readyPage } from "./support/world.js";

const ASSETS = [COVER, FIGURE, AUDIO];
const DRAFT = "d".repeat(64);
const OTHER = "e".repeat(64);

describe("deriveStatus (docs-ui ShellStatusState)", () => {
  it.each([
    ["never published", null, DRAFT, "private"],
    ["live and unchanged", { range: "live", stoppedAt: null, fingerprint: DRAFT }, DRAFT, "published"],
    ["live with edits", { range: "live", stoppedAt: null, fingerprint: OTHER }, DRAFT, "updated"],
    ["limited and unchanged", { range: "unlisted", stoppedAt: null, fingerprint: DRAFT }, DRAFT, "limited"],
    ["limited with edits", { range: "unlisted", stoppedAt: null, fingerprint: OTHER }, DRAFT, "updated"],
    ["stopped", { range: "live", stoppedAt: "2026-10-01T10:00:00.000Z", fingerprint: DRAFT }, DRAFT, "stopped"],
    ["stopped with edits", { range: "unlisted", stoppedAt: "2026-10-01T10:00:00.000Z", fingerprint: OTHER }, DRAFT, "stopped"],
  ] as const)("%s → %s", (_name, publication, draft, status) => {
    expect(deriveStatus(publication, draft)).toBe(status);
  });
});

function selection(handle: string, patch: Partial<SheetSelection> = {}): SheetSelection {
  const active = handle === "niho" ? "exp" : handle;
  const settings = active === "exp" ? SETTINGS.exp : SETTINGS.site;
  return { handle: active, ...settings, slug: null, ...patch };
}

function plan(patch: Partial<SheetPlanInput> & { page?: Partial<DraftPage>; choices?: FactChoices } = {}) {
  const { page, choices, ...rest } = patch;
  const sel = rest.selection === undefined ? selection("exp") : rest.selection;
  const factChoices = choices ?? (sel ? { category: sel.category, related: sel.related } : { category: null, related: [] });
  const input: SheetPlanInput = {
    pageId: PAGE_ID,
    title: readyPage(page).title,
    roles: ["writer", "kamakura"],
    storageMode: "CLOUD",
    sites: [SITE],
    declarations: { exp: DECLARATIONS.exp, niho: DECLARATIONS.niho, [SITE]: DECLARATIONS.site },
    selection: sel,
    publication: null,
    draftFingerprint: DRAFT,
    facts: collectFacts(readyPage(page), ASSETS, { relatedLive: true }, factChoices),
    ...rest,
  };
  return sheetPlan(input);
}

function live(handle: string, patch: Partial<SheetPublication> = {}): SheetPublication {
  const active = handle === "niho" ? "exp" : handle;
  const settings = active === "exp" ? SETTINGS.exp : SETTINGS.site;
  return { handle: active, slug: "a-morning-walk-along-the-coast", range: settings.range, extras: settings.extras, category: settings.category, related: settings.related, stoppedAt: null, fingerprint: DRAFT, ...patch };
}

describe("sheetPlan: destinations", () => {
  it("lists both faces and the connected sites, with a reason for the ones that cannot be chosen", () => {
    const result = plan({ roles: ["writer"], declarations: { exp: DECLARATIONS.exp, niho: DECLARATIONS.niho, [SITE]: { ...DECLARATIONS.site, requires: [{ kind: "future" }] } } });
    expect(result.destinations).toEqual([
      { handle: "exp", dest: "exp", label: "NIHO Experience", available: true, reason: null },
      { handle: "niho", dest: "niho", label: "NIHO", available: false, reason: "role" },
      { handle: SITE, dest: "site", label: SITE, available: false, reason: "unavailable" },
    ]);
  });

  it("treats a missing declaration or one for another destination as unavailable", () => {
    const result = plan({ declarations: { exp: DECLARATIONS.niho, [SITE]: DECLARATIONS.site } });
    expect(result.destinations.map((entry) => entry.reason)).toEqual(["unavailable", "role", null]);
  });

  it("ignores site handles that are not connection handles", () => {
    expect(plan({ sites: ["admin", "Bad Handle", SITE] }).destinations.map((entry) => entry.handle)).toEqual(["exp", "niho", SITE]);
  });

  it("cannot publish to a destination that is not available", () => {
    const result = plan({ roles: ["writer"], selection: { ...selection("exp"), handle: "niho" } });
    expect(result.selected).toMatchObject({ handle: "niho", available: false, reason: "role" });
    expect(result.primary).toBeNull();
  });

  it("offers the declaration's ranges and extras", () => {
    expect(plan({ selection: selection("exp") })).toMatchObject({
      ranges: ["live", "unlisted"],
      extras: [{ key: "app", checked: true }, { key: "news", checked: false }, { key: "xp", checked: true }],
    });
    expect(plan({ selection: selection(SITE) })).toMatchObject({ ranges: ["live"], extras: [] });
  });
});

describe("sheetPlan: the primary button", () => {
  it("is disabled (null) while any problem remains, and lists the problems", () => {
    const result = plan({ page: { title: "" } });
    expect(result.problems.map((problem) => problem.id)).toEqual(["title"]);
    expect(result.primary).toBeNull();
  });

  it("is publish for a page that was never published", () => {
    const result = plan();
    expect(result).toMatchObject({
      status: "private",
      primary: "publish",
      url: "https://exp.example.com/guides/a-morning-walk-along-the-coast",
      slug: { value: "a-morning-walk-along-the-coast", editable: true, error: null },
      canStop: false,
      changesDestination: false,
    });
  });

  it.each([
    ["unchanged draft and settings", {}, {}, null],
    ["edited draft", { fingerprint: OTHER }, {}, "update"],
    ["only settings changed (category)", {}, { category: "food" }, "save"],
    ["only settings changed (extras)", {}, { extras: { app: false, news: true, xp: false } }, "save"],
    ["only settings changed (range)", {}, { range: "unlisted" as const }, "save"],
    ["edited draft and settings", { fingerprint: OTHER }, { category: "food" }, "update"],
  ] as const)("on a live page: %s → %s", (_name, publication, sel, primary) => {
    const result = plan({ publication: live("niho", publication), selection: selection("niho", sel) });
    expect(result.primary).toBe(primary);
    expect(result.canStop).toBe(true);
    expect(result.slug).toEqual({ value: "a-morning-walk-along-the-coast", editable: false, error: null });
  });

  it.each(["LOCAL", "CLOSING"] as const)("is null whatever the page needs while the storage mode is %s, and says why", (mode) => {
    expect(plan().primary).toBe("publish");
    const result = plan({ storageMode: mode });
    expect(result.primary).toBeNull();
    expect(result.storageBlock).toBe(mode);
    // Stopping is still possible.
    expect(plan({ storageMode: mode, publication: live("niho", { fingerprint: OTHER }) }).canStop).toBe(true);
  });

  it("has no storage block on CLOUD or UNSET", () => {
    expect(plan().storageBlock).toBeNull();
    expect(plan({ storageMode: "UNSET" }).storageBlock).toBeNull();
  });

  it("stays null on a live page with edits while a problem remains", () => {
    const result = plan({ publication: live("niho", { fingerprint: OTHER }), page: { coverAssetId: "missing-cover" } });
    expect(result.status).toBe("updated");
    expect(result.primary).toBeNull();
  });

  it("is publish after the page was stopped, on the same URL", () => {
    const result = plan({ publication: live("niho", { stoppedAt: "2026-10-01T10:00:00.000Z" }), selection: selection("niho", { slug: "something-else" }) });
    expect(result).toMatchObject({ status: "stopped", primary: "publish", canStop: false, slug: { value: "a-morning-walk-along-the-coast", editable: false } });
  });

  it("is publish (changing destination) when another destination is chosen for a live page", () => {
    const result = plan({ publication: { ...live("exp"), handle: "niho" }, selection: selection("exp") });
    expect(result).toMatchObject({ primary: "publish", changesDestination: true, slug: { editable: true }, url: "https://exp.example.com/guides/a-morning-walk-along-the-coast" });
  });

  it("is null for a range or an extra the destination does not offer", () => {
    expect(plan({ selection: selection(SITE, { range: "unlisted" }) })).toMatchObject({ selectionError: "range", primary: null });
    expect(plan({ selection: selection(SITE, { extras: { app: true, news: false, xp: false } }) })).toMatchObject({ selectionError: "extras", primary: null });
  });

  it("suggests -2 when the title's slug is taken, and refuses a taken or invalid slug", () => {
    expect(plan({ takenSlugs: ["a-morning-walk-along-the-coast"] }).slug).toEqual({ value: "a-morning-walk-along-the-coast-2", editable: true, error: null });
    expect(plan({ selection: selection("niho", { slug: "walk" }), takenSlugs: ["walk"] })).toMatchObject({ slug: { error: "slug_taken" }, primary: null });
    expect(plan({ selection: selection("niho", { slug: "Bad Slug" }) })).toMatchObject({ slug: { error: "format" }, primary: null, url: null });
    expect(plan({ selection: selection("niho", { slug: "index" }) })).toMatchObject({ slug: { error: "reserved" }, primary: null });
  });

  it("uses a draft fingerprint computed from the page", async () => {
    const fingerprint = await draftFingerprint(readyPage(), ASSETS);
    const result = plan({ draftFingerprint: fingerprint, publication: live("niho", { fingerprint }) });
    expect(result.status).toBe("published");
  });

  it("returns an empty plan without a selection", () => {
    expect(plan({ selection: null })).toMatchObject({ selected: null, primary: null, problems: [], url: null });
  });
});
