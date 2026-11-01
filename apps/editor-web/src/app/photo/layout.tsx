import type { Metadata } from "next";
import type { ReactNode } from "react";
import { RegisterPhotoServiceWorker } from "@/components/RegisterPhotoServiceWorker";

export const metadata: Metadata = {
  title: { default: "NIHO photo", template: "%s · NIHO photo" },
  applicationName: "NIHO photo",
  manifest: "/photo/manifest.webmanifest",
  appleWebApp: { capable: true, title: "NIHO photo", statusBarStyle: "default" },
};

/** Photo route に Docs の identity や chrome を足さず、PWA 登録だけを狭く追加する。 */
export default function PhotoLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <RegisterPhotoServiceWorker />
    </>
  );
}
