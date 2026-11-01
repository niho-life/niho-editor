import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PHOTO_CONFORMANCE_CASES } from "./registry";

const fixtureUrl = new URL("../../../../../packages/photo-library-contract/fixtures/security-cases.json", import.meta.url);

describe("P00 photo conformance registry", () => {
  it("classifies every machine-readable case exactly once and never calls blocked evidence executed", async () => {
    const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as { cases: Array<{ id: string }> };
    const fixtureIds = fixture.cases.map((item) => item.id).sort();
    const registryIds = PHOTO_CONFORMANCE_CASES.map((item) => item.id).sort();

    expect(new Set(registryIds).size).toBe(34);
    expect(registryIds).toEqual(fixtureIds);
    for (const item of PHOTO_CONFORMANCE_CASES) {
      if (item.evidence === "blocked") {
        expect(item.test).toBeNull();
        expect(item.remaining).not.toBeNull();
      } else {
        expect(item.test).not.toBeNull();
      }
    }
  });

  it("keeps partial coverage out of the complete evidence aggregate", () => {
    expect(PHOTO_CONFORMANCE_CASES.filter((item) => item.evidence === "db-handler")).toHaveLength(13);
    expect(PHOTO_CONFORMANCE_CASES.filter((item) => item.evidence === "handler-precondition")).toHaveLength(3);
    expect(PHOTO_CONFORMANCE_CASES.filter((item) => item.evidence === "partial")).toHaveLength(6);
    expect(PHOTO_CONFORMANCE_CASES.filter((item) => item.evidence === "blocked")).toHaveLength(12);

    for (const id of ["revoked-content", "format-spoof", "pixel-limit"]) {
      expect(PHOTO_CONFORMANCE_CASES.find((item) => item.id === id)).toMatchObject({
        evidence: "partial",
        remaining: expect.any(String),
      });
    }
  });
});
