import type { ReactNode } from "react";
import type { ShellIconName } from "./types";

/** モック v6 の SVG symbol をそのまま写した線画（24 の viewBox）。lucide-react は使わない。 */
const PATHS: Record<ShellIconName, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  panel: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M14.5 4.5v15" />
    </>
  ),
  side: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  more: (
    <>
      <circle cx="6" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="18" cy="12" r="1.2" />
    </>
  ),
  lock: (
    <>
      <rect x="5.5" y="10.5" width="13" height="10" rx="2.5" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3.5" width="6" height="11" rx="3" />
      <path d="M6 11.5a6 6 0 0 0 12 0M12 17.5v3" />
    </>
  ),
  spark: (
    <>
      <path d="M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z" />
      <path d="M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z" />
    </>
  ),
  img: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" />
    </>
  ),
  list: (
    <>
      <path d="M9 7h11M9 12h11M9 17h11" />
      <circle cx="5" cy="7" r=".8" />
      <circle cx="5" cy="12" r=".8" />
      <circle cx="5" cy="17" r=".8" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  back: <path d="m14.5 6-6 6 6 6" />,
  ext: <path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5" />,
  ship: <path d="M4 15.5 12 19l8-3.5M4 15.5V9l8-4 8 4v6.5M12 5v14" />,
  people: (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19c.6-3 2.7-4.8 5.5-4.8s4.9 1.8 5.5 4.8" />
      <circle cx="16.5" cy="8.5" r="2.5" />
      <path d="M15.5 13c2.4 0 4.3 1.6 4.9 4.5" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2 18 18M6 18l1.8-1.8M16.2 7.8 18 6" />
    </>
  ),
  play: <path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none" />,
  pause: <path d="M7.5 5.5h3v13h-3zM13.5 5.5h3v13h-3z" fill="currentColor" stroke="none" />,
  doc: (
    <>
      <path d="M7 3.5h7l4 4v13H7z" />
      <path d="M14 3.5v4h4M10 12h5M10 15.5h5" />
    </>
  ),
  cal: (
    <>
      <rect x="4" y="5.5" width="16" height="14" rx="2.5" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
  type: <path d="M5 6h14M12 6v13M9 19h6" />,
  h: <path d="M6 5v14M18 5v14M6 12h12" />,
  minus: <path d="M5 12h14" />,
  up: <path d="M12 19V6M6 12l6-6 6 6" />,
  pin: <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3zM12 15v5" />,
  phone: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2.5" />
      <path d="M11 17.5h2" />
    </>
  ),
  mail: (
    <>
      <rect x="3.5" y="6" width="17" height="12" rx="2.5" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  edit: (
    <>
      <path d="M4.5 19.5h4l10-10a2.8 2.8 0 0 0-4-4l-10 10z" />
      <path d="m13 7 4 4M4.5 19.5l1-4" />
    </>
  ),
  trash: <path d="M5 7h14M9 7V4.5h6V7M7 7l1 13h8l1-13" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
};

/** 装飾のアイコン。意味は隣の文字か、ボタンの aria-label が持つ。 */
export function Icon({ name, className }: { name: ShellIconName; className?: string }) {
  return (
    <svg className={className ? `es-ico ${className}` : "es-ico"} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
