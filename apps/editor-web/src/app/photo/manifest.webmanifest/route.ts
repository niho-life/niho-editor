import photoManifest from "@/pwa/photo-manifest";

export const dynamic = "force-dynamic";

/** 個人情報を含まない、写真アプリ専用のインストール情報。 */
export function GET(): Response {
  return new Response(JSON.stringify(photoManifest()), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "no-cache, must-revalidate",
    },
  });
}
