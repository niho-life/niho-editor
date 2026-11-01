// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import rootManifest from "../manifest";
import { metadata } from "./layout";
import photoManifest from "../../pwa/photo-manifest";
import { GET as getManifest } from "./manifest.webmanifest/route";

const publicDir = new URL("../../../public/", import.meta.url);

function pngSize(path: string) {
  const bytes = readFileSync(new URL(path.replace(/^\//, ""), publicDir));
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("NIHO photo manifest", () => {
  it("is a standalone Japanese app scoped exactly to /photo", () => {
    expect(photoManifest()).toMatchObject({
      id: "/photo",
      start_url: "/photo",
      scope: "/photo",
      name: "NIHO photo",
      short_name: "NIHO photo",
      lang: "ja",
      display: "standalone",
      theme_color: "#fcfbf8",
      background_color: "#fcfbf8",
    });
  });

  it("reuses the existing branded PNGs with valid declared dimensions", () => {
    const icons = photoManifest().icons ?? [];
    expect(icons.some((icon) => icon.sizes === "192x192" && icon.purpose === "any")).toBe(true);
    expect(icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable")).toBe(true);
    for (const icon of icons) {
      const [width, height] = (icon.sizes ?? "").split("x").map(Number);
      expect(icon.type).toBe("image/png");
      expect(pngSize(icon.src)).toEqual({ width, height });
    }
  });

  it("publishes photo-specific nested metadata while inheriting root icons and noindex", () => {
    expect(metadata).toMatchObject({
      title: { default: "NIHO photo", template: "%s · NIHO photo" },
      applicationName: "NIHO photo",
      manifest: "/photo/manifest.webmanifest",
      appleWebApp: { capable: true, title: "NIHO photo" },
    });
    expect(metadata).not.toHaveProperty("icons");
    expect(metadata).not.toHaveProperty("robots");
  });

  it("serves the public install manifest as an explicit nested Route Handler", async () => {
    const response = getManifest();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
    expect(response.headers.get("cache-control")).toBe("no-cache, must-revalidate");
    expect(await response.json()).toMatchObject({ id: "/photo", scope: "/photo", name: "NIHO photo" });
  });

  it("does not change the root Docs manifest contract", () => {
    expect(rootManifest()).toMatchObject({ id: "/", start_url: "/", scope: "/", name: "NIHO editor", short_name: "NIHO editor" });
  });
});
