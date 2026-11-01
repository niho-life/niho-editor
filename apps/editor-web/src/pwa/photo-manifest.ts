import type { MetadataRoute } from "next";

/** `/photo` 用manifest。Nextのfile-based manifestはapp root専用なので、専用GET routeから配る。 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/photo",
    name: "NIHO photo",
    short_name: "NIHO photo",
    lang: "ja",
    start_url: "/photo",
    scope: "/photo",
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
