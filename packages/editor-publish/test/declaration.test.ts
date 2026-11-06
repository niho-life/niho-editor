import { describe, expect, it } from "vitest";
import { destinationUrl, parseDestinationDeclaration, type DestinationDeclaration } from "../src/index.js";
import { DECLARATIONS, readFixture } from "./support/world.js";

interface ChangeCase {
  readonly name: string;
  readonly base: keyof typeof DECLARATIONS;
  readonly path: readonly (string | number)[];
  readonly value?: unknown;
  readonly delete?: boolean;
  readonly expect: { readonly path: string; readonly reason: string };
}

interface DocumentCase {
  readonly name: string;
  readonly text: string;
  readonly expect: { readonly path: string; readonly reason: string };
}

const invalid = readFixture<{ cases: ChangeCase[]; documents: DocumentCase[] }>("fixtures/destinations/invalid.json");

function applyChange(base: unknown, change: ChangeCase): unknown {
  const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  let parent: Record<string | number, unknown> = copy;
  change.path.slice(0, -1).forEach((key) => {
    parent = parent[key] as Record<string | number, unknown>;
  });
  const last = change.path[change.path.length - 1] as string | number;
  if (change.delete) delete parent[last];
  else parent[last] = change.value;
  return copy;
}

function parsed(json: unknown): DestinationDeclaration {
  const result = parseDestinationDeclaration(json);
  if (!result.ok) throw new Error(`rejected: ${JSON.stringify(result.errors)}`);
  return result.value;
}

describe("parseDestinationDeclaration: the fixture declarations (design §8.1)", () => {
  it("accepts NIHO Experience with all nine condition kinds", () => {
    const exp = parsed(DECLARATIONS.exp);
    expect(exp.id).toBe("exp");
    expect(exp.requires.map((condition) => condition.kind)).toEqual(["lang", "cover", "lead", "category", "headings", "noConfirm", "relatedLive", "title", "images"]);
    expect(exp.requires[7]).toEqual({ id: "title", kind: "title", max: 110, message: "題名を 110 字以内にしてください", fix: "body" });
    expect(exp.requires[8]).toEqual({ id: "image-alt", kind: "images", alt: true, message: "写真に代替テキスト（alt）を入れてください", fix: "body" });
    expect(exp.accepts.blocks).not.toContain("quote");
    expect(destinationUrl(exp, "a-walk")).toBe("https://exp.example.com/guides/a-walk");
  });

  it("accepts NIHO (cover, lead, category) with optional arguments omitted", () => {
    const niho = parsed(DECLARATIONS.niho);
    expect(niho.requires.map((condition) => condition.kind)).toEqual(["cover", "lead", "category"]);
    const lead = niho.requires[1];
    expect(lead && "max" in lead).toBe(false);
  });

  it("accepts an owner's site with no conditions and an empty path", () => {
    const site = parsed(DECLARATIONS.site);
    expect(site.requires).toEqual([]);
    expect(site.ranges).toEqual(["live"]);
    expect(destinationUrl(site, "a-walk")).toBe("https://notes.example.net/a-walk");
  });

  it("accepts title (max at the limit) and images with alt false", () => {
    const declaration = parsed({
      ...DECLARATIONS.site,
      requires: [
        { id: "title", kind: "title", max: 500, message: "題名を短くしてください", fix: "body" },
        { id: "image-alt", kind: "images", alt: false, message: "写真に代替テキストを入れてください", fix: "body" },
      ],
    });
    expect(declaration.requires).toEqual([
      { id: "title", kind: "title", max: 500, message: "題名を短くしてください", fix: "body" },
      { id: "image-alt", kind: "images", alt: false, message: "写真に代替テキストを入れてください", fix: "body" },
    ]);
  });

  it("rejects a fix outside the closed vocabulary on the new kinds", () => {
    const result = parseDestinationDeclaration({
      ...DECLARATIONS.site,
      requires: [{ id: "title", kind: "title", max: 110, message: "題名を短くしてください", fix: "title" }],
    });
    expect(result).toEqual({ ok: false, errors: [{ path: "$.requires[0].fix", reason: "enum" }] });
  });

  it("accepts JSON text as well as parsed JSON", () => {
    expect(parsed(JSON.stringify(DECLARATIONS.niho))).toEqual(parsed(DECLARATIONS.niho));
  });

  it("returns a deeply frozen declaration", () => {
    const exp = parsed(DECLARATIONS.exp);
    expect(Object.isFrozen(exp)).toBe(true);
    expect(Object.isFrozen(exp.requires)).toBe(true);
    expect(Object.isFrozen(exp.requires[0])).toBe(true);
    expect(Object.isFrozen(exp.accepts.blocks)).toBe(true);
  });

  it("does not freeze or change the input", () => {
    const input = JSON.parse(JSON.stringify(DECLARATIONS.exp)) as Record<string, unknown>;
    parsed(input);
    expect(Object.isFrozen(input)).toBe(false);
    expect(input).toEqual(DECLARATIONS.exp);
  });
});

describe("parseDestinationDeclaration: fail closed (fixtures/destinations/invalid.json)", () => {
  it.each(invalid.cases.map((change) => [change.name, change] as const))("rejects the whole declaration: %s", (_name, change) => {
    const result = parseDestinationDeclaration(applyChange(DECLARATIONS[change.base], change));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContainEqual(change.expect);
  });

  it.each(invalid.documents.map((document) => [document.name, document] as const))("rejects %s", (_name, document) => {
    const result = parseDestinationDeclaration(document.text);
    expect(result).toEqual({ ok: false, errors: [document.expect] });
  });

  it("covers every negative category the spec names", () => {
    const reasons = new Set(invalid.cases.map((change) => change.expect.reason));
    for (const reason of ["unknown-kind", "unknown-field", "type", "enum", "format"]) expect(reasons).toContain(reason);
    const accepts = invalid.cases.filter((change) => change.path[0] === "accepts");
    expect(accepts.length).toBeGreaterThanOrEqual(3);
    const hosts = invalid.cases.filter((change) => change.path[0] === "host");
    expect(hosts.length).toBeGreaterThanOrEqual(8);
  });

  it("rejects undefined, a function result and a class instance", () => {
    expect(parseDestinationDeclaration(undefined).ok).toBe(false);
    expect(parseDestinationDeclaration(new Map()).ok).toBe(false);
    expect(parseDestinationDeclaration(Object.assign(Object.create({ inherited: true }) as object, DECLARATIONS.exp)).ok).toBe(false);
  });

  it("rejects a __proto__ key as an unknown field", () => {
    const text = JSON.stringify(DECLARATIONS.site).replace("{", '{"__proto__":{"polluted":true},');
    const result = parseDestinationDeclaration(text);
    expect(result.ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("never echoes offending values or unsafe keys in issues", () => {
    const hostile = { ...DECLARATIONS.exp, host: "secret-host.example.com:1", "bad key<script>": 1, label: "\u0007" };
    const result = parseDestinationDeclaration(hostile);
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(text).not.toContain("secret-host");
    expect(text).not.toContain("<script>");
    expect(text).toContain("$[?]");
  });

  it("caps the number of conditions", () => {
    const many = Array.from({ length: 33 }, (_, index) => ({ id: `c${index}`, kind: "noConfirm", message: "x", fix: "body" }));
    const result = parseDestinationDeclaration({ ...DECLARATIONS.site, requires: many });
    expect(result).toEqual({ ok: false, errors: [{ path: "$.requires", reason: "too-many" }] });
  });
});
