import type { MetadataRoute } from "next";

/**
 * インストールできる Web アプリの manifest（#49）。`/manifest.webmanifest` の明示GETで配り、root metadataからlinkする。写真の別manifestをNextのroot file優先で上書きしない。
 * アイコンは NIHO docs の icon.svg から作る（scripts/build-icons.mjs）。インストール後も全ページ noindex（next.config.ts の header と meta）。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "NIHO editor",
    short_name: "NIHO editor",
    description: "ページを書く工房",
    lang: "ja",
    start_url: "/",
    scope: "/",
    display: "standalone",
    theme_color: "#fcfbf8",
    background_color: "#fcfbf8",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
