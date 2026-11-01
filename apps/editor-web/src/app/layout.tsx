import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { RegisterServiceWorker } from "@/components/RegisterServiceWorker";
import { StubBadge } from "@/components/StubBadge";

// editor.niho.life は全ページ noindex, nofollow（設計 §2）。header の X-Robots-Tag は next.config.ts で全 route に付ける。
// インストール（#49）: manifest は src/pwa/editor-manifest.ts と明示GET route、アイコンは public/icons。インストール後も同じ noindex。
export const metadata: Metadata = {
  title: { default: "NIHO editor", template: "%s · NIHO editor" },
  applicationName: "NIHO editor",
  manifest: "/manifest.webmanifest",
  robots: { index: false, follow: false },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "NIHO editor", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#fcfbf8",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // 全ての route を要求のときに描く。CSP の nonce は要求ごとに変わるので、build のときの静的な HTML には入れられない（src/proxy.ts）
  await connection();
  return (
    <html lang="ja">
      <body>
        {children}
        <StubBadge />
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
