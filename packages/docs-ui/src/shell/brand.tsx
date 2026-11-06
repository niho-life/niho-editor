/**
 * 左上のアプリ名とアイコン（オーナー決定 2026-11-06）。一覧の上の 1 行の左と、一覧をしまったときのヘッダー（「一覧を出す」の右隣）に出す。
 * 絵は Mac アプリの apps/docs/src-tauri/icons/icon.svg のグリフ（書類と筆）を、全面の地の中央に置いたもの
 * （apps/editor-web/scripts/build-icons.mjs が PWA の maskable アイコンに同じ置き方で描いている）。
 * グリフの塗りはアイコン自身の固定色なので hex のまま。地は CSS の color（`.es-brand svg`）を currentColor で受ける。
 */
export function ShellBrand() {
  return (
    // 素の span に aria-label は付けられない（axe の aria-prohibited-attr）ので、絵と文字をまとめて 1 つの img として名前を持たせる
    <span className="es-brand" role="img" aria-label="Editor">
      <svg viewBox="0 0 256 256" aria-hidden="true" focusable="false">
        <rect width="256" height="256" fill="currentColor" />
        <g transform="translate(128 128) scale(2.05) translate(-50 -50)">
          <path fill="#A6D2DE" d="M22 14 C34 11 46 12 58 11 L79 31 C80 48 81 68 79 87 C60 90 40 88 21 89 C19 66 20 40 22 14 Z" />
          <path fill="#DCEDF2" d="M58 11 C59 18 58 25 59 31 C66 31 73 31 79 31 Z" />
          <path fill="#4B5F73" d="M31 42 C38 40 48 40 56 41 C58 43 58 46 56 48 C48 49 38 49 31 48 C29 46 29 44 31 42 Z" />
          <path fill="#4B5F73" d="M31 56 C36 54 42 54 46 55 C48 57 48 60 46 62 C42 63 36 63 31 62 C29 60 29 58 31 56 Z" />
          <g transform="translate(78 34.2) rotate(36.4)">
            <path
              fill="#EE9B7E"
              d="M-5.6 -1 C-5.2 -5.4 5.4 -6 6.2 -1.4 C6.6 10 5.6 24 6.4 36 C6.6 41 5.9 45 5.2 47.5 C2 48.6 -2 48.4 -5.4 47.4 C-6.2 44 -5.8 38 -6.4 30 C-6.8 20 -5.4 10 -5.6 -1 Z"
            />
            <path fill="#FAF0D6" d="M-4.2 -3.4 C-2.6 -6.6 3.2 -6.4 4.8 -3 C5.4 -0.4 3 2.6 -0.4 2.4 C-3.4 2.2 -5.2 -0.6 -4.2 -3.4 Z" />
            <path
              fill="#4B5F73"
              d="M-5.2 46.4 C-3.6 45 -0.8 45.8 1.6 45.6 C3.4 45.4 4.6 46.2 5.1 47.2 C4.4 48.9 4.9 50.7 3.9 52.3 C3.3 53.6 2.6 54.8 0.8 55.4 C-1 55.8 -2.8 54.9 -3.6 53.6 C-4.1 52.6 -4 51.3 -4.7 50 C-5.3 48.9 -5.6 47.7 -5.2 46.4 Z"
            />
          </g>
        </g>
      </svg>
      <span aria-hidden="true">Editor</span>
    </span>
  );
}
