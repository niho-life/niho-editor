"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * `/photo` 専用 worker を本番だけ登録する。認証 route の直接表示では登録せず、
 * 既にある root worker を解除したり、更新時に画面を再読み込みしたりしない。
 */
export function RegisterPhotoServiceWorker() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname.startsWith("/photo/auth/") || process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/photo-sw.js", { scope: "/photo", updateViaCache: "none" }).catch(() => undefined);
    };
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, [pathname]);

  return null;
}
