import editorManifest from "@/pwa/editor-manifest";

export const dynamic = "force-dynamic";

/** Docsの既存URL・id・scope・表示名を保ち、写真manifestと独立して配る。 */
export function GET(): Response {
  return new Response(JSON.stringify(editorManifest()), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
}
