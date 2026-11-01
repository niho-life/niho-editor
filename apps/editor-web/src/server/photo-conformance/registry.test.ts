import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PHOTO_CONFORMANCE_CASES, type ConformanceCase } from "./registry";

const fixtureUrl = new URL("../../../../../packages/photo-library-contract/fixtures/security-cases.json", import.meta.url);
const cases: readonly ConformanceCase[] = PHOTO_CONFORMANCE_CASES;

describe("P00 photo conformance registry", () => {
  it("classifies every machine-readable case exactly once and never calls blocked evidence executed", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as { cases: Array<{ id: string }> };
    const fixtureIds = fixture.cases.map((item) => item.id).sort();
    const registryIds = cases.map((item) => item.id).sort();

    expect(new Set(registryIds).size).toBe(34);
    expect(registryIds).toEqual(fixtureIds);
    for (const item of cases) {
      if (item.evidence === "blocked") {
        expect(item.test).toBeNull();
        expect(item.remaining).not.toBeNull();
      } else {
        expect(item.test).not.toBeNull();
      }
    }
  });

  it("keeps partial coverage out of the complete evidence aggregate", () => {
    expect(cases.filter((item) => item.evidence === "db-handler")).toHaveLength(24);
    expect(cases.filter((item) => item.evidence === "handler-precondition")).toHaveLength(3);
    expect(cases.filter((item) => item.evidence === "partial")).toHaveLength(7);
    expect(cases.filter((item) => item.evidence === "blocked")).toHaveLength(0);

    for (const id of [
      "revoked-content",
      "format-spoof",
      "pixel-limit",
      "missing-mask",
      "pending-purge-retains-quota",
    ]) {
      expect(cases.find((item) => item.id === id)).toMatchObject({
        evidence: "partial",
        remaining: expect.any(String),
      });
    }
    for (const id of ["stale-preview", "stored-media-failed"]) {
      expect(cases.find((item) => item.id === id)).toMatchObject({ evidence: "db-handler", remaining: null });
    }
    expect(cases.find((item) => item.id === "unknown-recipe")).toMatchObject({
      evidence: "db-handler",
      remaining: null,
    });
  });
});
