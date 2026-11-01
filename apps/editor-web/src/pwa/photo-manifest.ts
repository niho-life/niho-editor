import type { MetadataRoute } from "next";

/** `/photo` 用manifest。Nextのfile-based manifestはapp root専用なので、専用GET routeから配る。 */
export default function manifest(): MetadataRoute.Manifest {
  // next.configが共有--ed-canvasから解決する。runtimeの環境値やCSS配信には依存しない。
  const canvasColor = process.env.PHOTO_PWA_CANVAS_COLOR;
  if (!canvasColor) throw new Error("photo manifest theme was not configured at build time");
  return {
    id: "/photo",
    name: "NIHO photo",
    short_name: "NIHO photo",
    lang: "ja",
    start_url: "/photo",
    scope: "/photo",
    display: "standalone",
    theme_color: canvasColor,
    background_color: canvasColor,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
