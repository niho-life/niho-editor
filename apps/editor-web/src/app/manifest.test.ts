// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import nextConfig, { ALL_BUT_PUBLIC_API } from "../../next.config";
import { metadata, viewport } from "./layout";
import manifest from "../pwa/editor-manifest";
import { GET as getEditorManifest } from "./manifest.webmanifest/route";

const publicDir = new URL("../../public/", import.meta.url);

/** PNG の IHDR から幅・高さ・色の種類（2 = RGB、6 = RGBA）を読む。 */
function pngInfo(path: string) {
  const bytes = readFileSync(new URL(path.replace(/^\//, ""), publicDir));
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colorType: bytes[25] };
}

describe("web app manifest", () => {
  const data = manifest();

  it("installs as a standalone app that starts at the root", () => {
    expect(data.display).toBe("standalone");
    expect(data.start_url).toBe("/");
    expect(data.scope).toBe("/");
    expect(data.id).toBe("/");
    expect(data.name).toBe("NIHO editor");
    expect(data.theme_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(data.background_color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("serves the existing root manifest URL with unchanged app identity", async () => {
    const response = getEditorManifest();
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
    expect(await response.json()).toEqual(data);
    expect(metadata.manifest).toBe("/manifest.webmanifest");
  });

  it("lists icons that exist, have the size they declare, and cover any and maskable", () => {
    const icons = data.icons ?? [];
    expect(icons.some((icon) => icon.sizes === "192x192" && icon.purpose === "any")).toBe(true);
    expect(icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "any")).toBe(true);
    expect(icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable")).toBe(true);
    for (const icon of icons) {
      const [width, height] = (icon.sizes ?? "").split("x").map(Number);
      expect(icon.type).toBe("image/png");
      expect(pngInfo(icon.src), icon.src).toMatchObject({ width, height });
    }
  });

  it("gives maskable and apple-touch icons a full-bleed opaque background (platforms fill transparency with black)", () => {
    expect(pngInfo("/icons/icon-maskable-512.png").colorType).toBe(2);
    expect(pngInfo("/icons/apple-touch-icon.png")).toMatchObject({ width: 180, height: 180, colorType: 2 });
    expect(pngInfo("/icons/icon-512.png").colorType).toBe(6);
  });
});

describe("install metadata and noindex", () => {
  it("links the apple-touch icon and marks the page as a web app, and keeps every page noindex", () => {
    const icons = metadata.icons as { apple?: unknown } | undefined;
    expect(JSON.stringify(icons?.apple)).toContain("/icons/apple-touch-icon.png");
    expect(existsSync(new URL("icons/apple-touch-icon.png", publicDir))).toBe(true);
    expect(metadata.appleWebApp).toMatchObject({ capable: true, title: "NIHO editor" });
    expect(viewport.themeColor).toBe(manifest().theme_color);
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("sends noindex on the manifest, the service worker and the offline page too (they match the catch-all rule)", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const catchAll = rules.find((rule) => rule.source === ALL_BUT_PUBLIC_API);
    expect(catchAll?.headers).toEqual(expect.arrayContaining([{ key: "X-Robots-Tag", value: "noindex, nofollow" }]));
    expect(readFileSync(new URL("offline.html", publicDir), "utf8")).toContain('<meta name="robots" content="noindex, nofollow" />');
  });

  it("keeps the service worker out of the browser's HTTP cache so updates arrive", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules.find((rule) => rule.source === "/sw.js")?.headers).toEqual([{ key: "Cache-Control", value: "no-cache, must-revalidate" }]);
  });
});
