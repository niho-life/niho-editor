"use client";

import { useCallback, useEffect, useId, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "../shell/icons";
import { ShellSheet } from "../shell/sheet";
import { IMAGE_ACCEPT, IMAGE_ALT_MAX_CHARS, IMAGE_CREDIT_MAX_CHARS, IMAGE_MAX_BYTES, IMAGE_PAGE_MAX_COUNT, isAllowedImageSize, isAllowedImageType } from "./image-limits";
import { IMAGE_PROBLEM_TEXT } from "./image-node";
import type { ImageMeta, ImageProblem, ImageSrcOf, PageImageEntry, PageImages } from "./images";
import { PAGE_IMAGE_DRAG_TYPE, encodePagePhotoDrag, type PagePhotosBody } from "./page-photos";

/**
 * 「このページの写真」（左のサイドバーの下。モック docs/mockups/editor-photo-library-v1.html。オーナー決定 2026-11-05）。
 * 写真の原本はここ（そのページの画像の資産）にあり、本文の画像はそれを指す。
 *
 * - 既定で閉じる（写真アイコンの 1 行だけ）。アイコンを押すと開き、もう一度押すと閉じる。開閉と高さは呼ぶ側がメモリに持つ（保存しない）。
 *   枚数は出さない。＋は開いているときだけ出し、100 枚に達したら押せなくして理由をツールチップと通知で出す。
 * - タイルは正方形 3 列・新しい順。本文で使っている写真には形のある ✓（色だけで表さない）。
 *   押す → 大きく見る（本文に入れる／alt／クレジット／掲載許諾／パネルから外す）。ドラッグ → 本文の落とした位置に入る（image-node.ts）。
 * - ＋とパネルへのファイルのドロップは、パネルにだけ足す（本文には入れない）。閉じた行に落としたら開いて上げる。
 *   上げている間は細い進み具合、失敗は 1 行で「再試行・取り消す」。
 * - パネルから外すと、本文の全ての出現（とカバー）からも消える。サーバーで外せてから本文を変え、外せなければ何も変えない。
 * - 開いている間は一覧との境目（role=separator）のドラッグと ↑↓ キーで高さを変えられる。
 *
 * 通信は持たない（`images` の口の list・upload・remove・saveMeta を使う）。口に list・remove が無い host では何も描かない。
 */

export const PAGE_PHOTOS_LABEL = "このページの写真";
/** 100 枚に達したときの理由（＋のツールチップと通知）。 */
export const PAGE_PHOTOS_FULL_TEXT = `このページの写真は ${IMAGE_PAGE_MAX_COUNT} 枚までです`;
/** ＋のツールチップ（本文には入れない）。 */
export const PAGE_PHOTOS_ADD_TEXT = "写真を足す（本文には入れない）";
/** 開いているときの高さの下限と、一覧に残す高さ。 */
export const PAGE_PHOTOS_MIN_HEIGHT = 150;
const LIST_KEEP_HEIGHT = 230;
/** ↑↓ キーで変える高さ。 */
const KEY_STEP = 24;
/** 欄を直してから資産の行へ書くまでの間（打っている間は送らない。ImageNodeView と同じ）。 */
const SAVE_DELAY_MS = 600;
/** 通知を出しておく時間。 */
const NOTICE_VISIBLE_MS = 6000;

export type PagePhotosProps = {
  /** 開いているページ（作ってあるページだけ。作る前は出さない）。 */
  pageId: string;
  images: PageImages;
  srcOf: ImageSrcOf;
  /** 本文との橋渡し（page-photos.ts の pagePhotosBody）。 */
  body: PagePhotosBody;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 開いているときの高さ（px）。 */
  height: number;
  onHeightChange: (height: number) => void;
  /** 狭い画面（タイルをドラッグできないので、押して「本文に入れる」）。 */
  narrow?: boolean;
  /** 「本文に入れる」で入れたあと（狭い画面ではページへ戻る）。 */
  onInserted?: () => void;
  /** パネルで上げている途中の写真があるか（変わったら呼ぶ。何も足していないページを捨てる判定に使う）。 */
  onUploadingChange?: (uploading: boolean) => void;
};

type Pending = {
  key: string;
  pageId: string;
  file: File;
  /** 手元のプレビュー（blob: の URL。作れない環境では null）。 */
  preview: string | null;
  status: "waiting" | "uploading" | "failed";
  problem: ImageProblem | null;
};

type Loaded = { pageId: string; entries: PageImageEntry[] | null; error: boolean };

const CHECK = (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

function hasFiles(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.types ?? []).includes("Files"));
}

function isTile(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.types ?? []).includes(PAGE_IMAGE_DRAG_TYPE));
}

function isHeic(file: File): boolean {
  return /\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type);
}

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function previewOf(file: File): string | null {
  try {
    return typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null;
  } catch {
    return null;
  }
}

function releasePreview(preview: string | null): void {
  if (preview === null) return;
  try {
    URL.revokeObjectURL(preview);
  } catch {
    // 作れない環境では何もしない
  }
}

let pendingSeq = 0;

export function PagePhotos({ pageId, images, srcOf, body, open, onOpenChange, height, onHeightChange, narrow = false, onInserted, onUploadingChange }: PagePhotosProps) {
  const bodyId = useId();
  const section = useRef<HTMLElement | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ pageId, entries: null, error: false });
  const [pending, setPending] = useState<Pending[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [uses, setUses] = useState<ReadonlyMap<string, number>>(() => new Map());
  const pageRef = useRef(pageId);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const unknownKey = useRef("");
  const overDepth = useRef(0);
  useEffect(() => {
    pageRef.current = pageId;
  }, [pageId]);
  // 通知は少しして消す（パネルの下の案内に戻す）
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const list = images.list;
  const remove = images.remove;
  const entries = loaded.pageId === pageId ? loaded.entries : null;
  const loadError = loaded.pageId === pageId && loaded.error;
  const mine = pending.filter((item) => item.pageId === pageId);
  const active = mine.filter((item) => item.status !== "failed").length;
  const count = (entries?.length ?? 0) + active;
  const full = count >= IMAGE_PAGE_MAX_COUNT;

  const reload = useCallback(() => {
    if (!list) return;
    const target = pageId;
    void list(target).then((result) => {
      if (pageRef.current !== target) return;
      setLoaded(result ? { pageId: target, entries: result, error: false } : { pageId: target, entries: null, error: true });
    });
  }, [list, pageId]);

  // 開いたとき・ページが替わったときに読む（閉じている間は読まない）
  useEffect(() => {
    if (!open) return;
    unknownKey.current = "";
    reload();
  }, [open, reload]);

  // 本文で使っている写真（✓）。開いている間だけ数える
  useEffect(() => {
    if (!open) return;
    setUses(body.uses());
    return body.subscribe(() => setUses(body.uses()));
  }, [open, body]);

  // 本文の画像ボタン・貼り付け・ドロップで新しく上がった写真は、パネルにも出す（知らない写真が本文に出たら一覧を読み直す）
  useEffect(() => {
    if (!open || !entries) return;
    const known = new Set(entries.map((entry) => entry.assetId.toLowerCase()));
    const unknown = [...uses.keys()].filter((id) => !known.has(id)).sort().join(",");
    if (unknown === "" || unknown === unknownKey.current) return;
    unknownKey.current = unknown;
    reload();
  }, [open, entries, uses, reload]);

  // 上げている途中の写真があるか
  const uploadingNow = active > 0;
  useEffect(() => {
    onUploadingChange?.(uploadingNow);
  }, [uploadingNow, onUploadingChange]);
  useEffect(() => () => onUploadingChange?.(false), [onUploadingChange]);

  const upload = useCallback(
    (item: Pending) => {
      queue.current = queue.current.then(async () => {
        setPending((current) => current.map((entry) => (entry.key === item.key ? { ...entry, status: "uploading" } : entry)));
        const result = await images.upload(item.file, item.pageId).catch(() => ({ ok: false as const, problem: "failed" as const }));
        if (!result.ok) {
          setPending((current) => current.map((entry) => (entry.key === item.key ? { ...entry, status: "failed", problem: result.problem } : entry)));
          return;
        }
        setPending((current) => current.filter((entry) => entry.key !== item.key));
        releasePreview(item.preview);
        const entry: PageImageEntry = { assetId: result.assetId, meta: result.meta, bytes: item.file.size, contentType: item.file.type, createdAt: new Date().toISOString() };
        setLoaded((current) =>
          current.pageId === item.pageId && current.entries
            ? { ...current, entries: [entry, ...current.entries.filter((known) => known.assetId !== entry.assetId)] }
            : current,
        );
      });
    },
    [images],
  );

  /** ファイルをパネルにだけ足す（本文には入れない）。入れられないものは数えて通知に出す。 */
  const addFiles = useCallback(
    (files: readonly File[]) => {
      let heic = 0;
      let type = 0;
      let big = 0;
      const accepted: File[] = [];
      for (const file of files) {
        if (isHeic(file)) heic++;
        else if (!isAllowedImageType(file.type)) type++;
        else if (!isAllowedImageSize(file.size)) big++;
        else accepted.push(file);
      }
      const room = Math.max(0, IMAGE_PAGE_MAX_COUNT - count);
      const take = accepted.slice(0, room);
      const left = accepted.length - take.length;
      const notes: string[] = [];
      if (heic) notes.push(`HEIC の写真はまだ入れられません（${heic} 枚）。JPEG・PNG・WebP・AVIF・GIF にしてください。`);
      if (type) notes.push(`この形式は入れられません（${type} 枚）。`);
      if (big) notes.push(`${Math.round(IMAGE_MAX_BYTES / (1024 * 1024))} MB を超える写真は入れられません（${big} 枚）。`);
      if (left) notes.push(`${PAGE_PHOTOS_FULL_TEXT}（${left} 枚は入れませんでした）。`);
      const added = take.map(
        (file): Pending => ({ key: `p${++pendingSeq}`, pageId, file, preview: previewOf(file), status: "waiting", problem: null }),
      );
      // 新しい順に出す（最後に選んだものが上）。上げるのは選んだ順
      if (added.length > 0) setPending((current) => [...[...added].reverse(), ...current]);
      for (const item of added) upload(item);
      setNotice(notes.length > 0 ? notes.join(" ") : added.length > 0 ? `${added.length} 枚をこのページの写真に足しています（本文には入れていません）。` : null);
    },
    [count, pageId, upload],
  );

  const retry = (item: Pending) => {
    setPending((current) => current.map((entry) => (entry.key === item.key ? { ...entry, status: "waiting", problem: null } : entry)));
    upload({ ...item, status: "waiting", problem: null });
  };
  const dismiss = (item: Pending) => {
    // 失敗したアップロードの予約は、口（upload）が取り消してある
    setPending((current) => current.filter((entry) => entry.key !== item.key));
    releasePreview(item.preview);
    setNotice("取り消しました。");
  };

  const choose = () => {
    if (full) {
      setNotice(`${PAGE_PHOTOS_FULL_TEXT}。`);
      return;
    }
    const input = picker.current;
    if (!input) return;
    input.value = "";
    input.click();
  };

  // 境目: ドラッグと ↑↓ キーで高さを変える（一覧に少し残す）
  const clamp = (value: number) => {
    const total = section.current?.closest(".es-sb")?.getBoundingClientRect().height ?? 0;
    const max = Math.max(PAGE_PHOTOS_MIN_HEIGHT + 10, total - LIST_KEEP_HEIGHT);
    return Math.round(Math.max(PAGE_PHOTOS_MIN_HEIGHT, Math.min(max, value)));
  };
  const maxHeight = () => {
    const total = section.current?.closest(".es-sb")?.getBoundingClientRect().height ?? 0;
    return Math.round(Math.max(PAGE_PHOTOS_MIN_HEIGHT + 10, total - LIST_KEEP_HEIGHT));
  };
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const from = event.clientY;
    const start = height;
    const move = (next: PointerEvent) => onHeightChange(clamp(start - (next.clientY - from)));
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const resizeByKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    onHeightChange(clamp(height + (event.key === "ArrowUp" ? KEY_STEP : -KEY_STEP)));
  };

  // パネルへのファイルのドロップ（パネルにだけ足す）。タイル自身のドラッグは受けない
  const dragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (!hasFiles(event.dataTransfer) || isTile(event.dataTransfer)) return;
    overDepth.current++;
    setOver(true);
  };
  const dragLeave = () => {
    if (overDepth.current > 0 && --overDepth.current === 0) setOver(false);
  };
  const dragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!hasFiles(event.dataTransfer) || isTile(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const drop = (event: ReactDragEvent<HTMLElement>) => {
    overDepth.current = 0;
    setOver(false);
    if (!hasFiles(event.dataTransfer) || isTile(event.dataTransfer)) return;
    event.preventDefault();
    // 閉じた行に落としたときは、開いて上げている様子を見せる
    if (!open) onOpenChange(true);
    addFiles(Array.from(event.dataTransfer.files ?? []));
  };

  if (!list || !remove) return null;

  const viewed = viewing && entries ? entries.find((entry) => entry.assetId === viewing) ?? null : null;
  const anyUsed = entries?.some((entry) => uses.has(entry.assetId.toLowerCase())) ?? false;

  return (
    <>
      {open && (
        <div
          className="es-ph-split"
          role="separator"
          aria-orientation="horizontal"
          aria-label="ページの一覧と写真の境目"
          aria-valuemin={PAGE_PHOTOS_MIN_HEIGHT}
          aria-valuemax={maxHeight()}
          aria-valuenow={height}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={resizeByKey}
        />
      )}
      <section
        ref={section}
        className={`es-ph${open ? "" : " es-ph--folded"}${over ? " es-ph--over" : ""}`}
        aria-label={PAGE_PHOTOS_LABEL}
        style={open ? { height } : undefined}
        onDragEnter={dragEnter}
        onDragLeave={dragLeave}
        onDragOver={dragOver}
        onDrop={drop}
      >
        <div className="es-ph-hd">
          <button
            type="button"
            className="es-ph-fold"
            aria-expanded={open}
            // 閉じている間は中身が無いので、指す先も持たない（無い id を指さない）
            aria-controls={open ? bodyId : undefined}
            aria-label={PAGE_PHOTOS_LABEL}
            title={PAGE_PHOTOS_LABEL}
            onClick={() => onOpenChange(!open)}
          >
            <span className="es-ph-caret" aria-hidden="true">
              {open ? "▾" : "▸"}
            </span>
            <Icon name="img" />
          </button>
          <span className="es-sp" />
          {open && (
            <button
              type="button"
              className="es-ib es-ib--sm"
              aria-label={full ? PAGE_PHOTOS_FULL_TEXT : PAGE_PHOTOS_ADD_TEXT}
              title={full ? PAGE_PHOTOS_FULL_TEXT : PAGE_PHOTOS_ADD_TEXT}
              aria-disabled={full || undefined}
              data-page-photos-add=""
              onClick={choose}
            >
              <Icon name="plus" />
            </button>
          )}
          <input
            ref={picker}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => {
              const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
              if (files.length > 0) addFiles(files);
            }}
          />
        </div>
        {open && (
          <div className="es-ph-body" id={bodyId}>
            {entries === null && !loadError && (
              <p className="es-ph-hint" role="status">
                読み込んでいます…
              </p>
            )}
            {loadError && (
              <p className="es-ph-hint" role="alert">
                写真を読み込めませんでした。
                <button type="button" className="es-ph-link" onClick={reload}>
                  もう一度
                </button>
              </p>
            )}
            {entries !== null && entries.length === 0 && mine.length === 0 && (
              <div className="es-ph-empty">
                <Icon name="img" />
                <b>関連する写真をここに落とす</b>
                <span>＋ から選ぶこともできます。ここに上げただけでは本文に入りません。</span>
              </div>
            )}
            {(mine.length > 0 || (entries !== null && entries.length > 0)) && (
              <ul className="es-ph-tiles" aria-label={PAGE_PHOTOS_LABEL}>
                {mine.map((item) =>
                  item.status === "failed" ? (
                    <li key={item.key} className="es-ph-fail" data-page-photo-failed="">
                      {item.preview ? <img src={item.preview} alt="" /> : <span className="es-ph-noimg" aria-hidden="true" />}
                      <span className="es-ph-fail-t">
                        <b>{item.file.name}</b>
                        <span>{item.problem ? IMAGE_PROBLEM_TEXT[item.problem] : IMAGE_PROBLEM_TEXT.failed}</span>
                      </span>
                      <span className="es-ph-fail-acts">
                        <button type="button" className="es-btn es-btn--outline es-btn--sm" onClick={() => retry(item)}>
                          再試行
                        </button>
                        <button type="button" className="es-btn es-btn--quiet es-btn--sm" onClick={() => dismiss(item)}>
                          取り消す
                        </button>
                      </span>
                    </li>
                  ) : (
                    <li key={item.key}>
                      <span className="es-ph-tile es-ph-tile--up" role="img" aria-label={`${item.file.name}（上げています）`} data-page-photo-uploading="">
                        {item.preview ? <img src={item.preview} alt="" draggable={false} /> : null}
                        <span className="es-ph-prog" aria-hidden="true">
                          <i />
                        </span>
                      </span>
                    </li>
                  ),
                )}
                {entries?.map((entry, index) => {
                  const used = uses.get(entry.assetId.toLowerCase()) ?? 0;
                  const name = entry.meta.alt ?? `写真 ${index + 1}`;
                  return (
                    <li key={entry.assetId}>
                      <button
                        type="button"
                        className={`es-ph-tile${used > 0 ? " es-ph-tile--used" : ""}`}
                        aria-label={used > 0 ? `${name}（本文で使っています）` : name}
                        draggable={!narrow}
                        data-asset-id={entry.assetId}
                        onClick={() => setViewing(entry.assetId)}
                        onDragStart={(event) => {
                          if (narrow) {
                            event.preventDefault();
                            return;
                          }
                          event.dataTransfer.setData(PAGE_IMAGE_DRAG_TYPE, encodePagePhotoDrag({ assetId: entry.assetId, ...entry.meta }));
                          event.dataTransfer.effectAllowed = "copy";
                        }}
                      >
                        <img src={srcOf(entry.assetId)} alt="" loading="lazy" draggable={false} />
                        {used > 0 && <span className="es-ph-ck">{CHECK}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {open && (notice || (entries !== null && entries.length > 0)) && (
          <p className="es-ph-hint" role="status">
            {notice ?? `${anyUsed ? "✓ は本文で使っている写真 · " : ""}${narrow || !body.insert ? "押して「本文に入れる」" : "タイルを本文へドラッグして入れる"}`}
          </p>
        )}
      </section>
      {viewed && (
        <PhotoSheet
          key={viewed.assetId}
          pageId={pageId}
          entry={viewed}
          images={images}
          srcOf={srcOf}
          body={body}
          used={uses.get(viewed.assetId.toLowerCase()) ?? 0}
          onClose={() => setViewing(null)}
          onMeta={(meta) =>
            setLoaded((current) =>
              current.entries ? { ...current, entries: current.entries.map((entry) => (entry.assetId === viewed.assetId ? { ...entry, meta } : entry)) } : current,
            )
          }
          onInserted={() => {
            setViewing(null);
            onInserted?.();
          }}
          onRemoved={(removedFromBody) => {
            setViewing(null);
            // 本文から消した分の ✓ をすぐ外す（まとめて数える時計を待つと、消した写真を「知らない写真」として読み直してしまう）
            setUses(body.uses());
            setLoaded((current) => (current.entries ? { ...current, entries: current.entries.filter((entry) => entry.assetId !== viewed.assetId) } : current));
            setNotice(removedFromBody > 0 ? `写真を外し、本文の ${removedFromBody} か所からも消しました。` : "写真をパネルから外しました。");
          }}
        />
      )}
    </>
  );
}

/** 大きく見る（ダイアログ）。本文に入れる・alt・クレジット・掲載許諾・パネルから外す。 */
function PhotoSheet(props: {
  pageId: string;
  entry: PageImageEntry;
  images: PageImages;
  srcOf: ImageSrcOf;
  body: PagePhotosBody;
  used: number;
  onClose: () => void;
  onMeta: (meta: ImageMeta) => void;
  onInserted: () => void;
  onRemoved: (removedFromBody: number) => void;
}) {
  const { pageId, entry, images, body } = props;
  const [meta, setMeta] = useState<ImageMeta>(entry.meta);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waiting = useRef<Partial<ImageMeta>>({});
  const removeButton = useRef<HTMLButtonElement | null>(null);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const patch = waiting.current;
    waiting.current = {};
    if (Object.keys(patch).length === 0) return;
    void images.saveMeta(entry.assetId, patch).then((saved) => {
      if (!saved) {
        setProblem("欄を保存できませんでした。もう一度試してください。");
        return;
      }
      body.update?.(entry.assetId, patch);
    });
  }, [body, entry.assetId, images]);
  // 閉じるときに、まだ送っていない欄を送る
  useEffect(() => flush, [flush]);
  useEffect(() => {
    if (confirm !== null) removeButton.current?.focus();
  }, [confirm]);

  const change = (patch: Partial<ImageMeta>, now = false) => {
    const next = { ...meta, ...patch };
    setMeta(next);
    props.onMeta(next);
    setProblem(null);
    waiting.current = { ...waiting.current, ...patch };
    if (timer.current !== null) clearTimeout(timer.current);
    if (now) flush();
    else timer.current = setTimeout(flush, SAVE_DELAY_MS);
  };

  const insert = () => {
    flush();
    if (!body.insert?.({ assetId: entry.assetId, ...meta })) {
      setProblem("本文に入れられませんでした。ページを開き直してから試してください。");
      return;
    }
    props.onInserted();
  };

  const confirmRemove = async () => {
    if (busy || !images.remove) return;
    setBusy(true);
    setProblem(null);
    // 先にサーバーで外す。外せなければ本文は何も変えない
    const removed = await images.remove(pageId, entry.assetId);
    if (!removed) {
      setBusy(false);
      setProblem("外せませんでした。もう一度試してください。");
      return;
    }
    const before = body.uses().get(entry.assetId.toLowerCase()) ?? 0;
    body.removed(entry.assetId);
    props.onRemoved(before);
  };

  const used = props.used;
  return (
    <ShellSheet label="写真" className="es-sheet--photo" onClose={props.onClose}>
      <div className="es-sh-hd">
        <h2>写真</h2>
        <span className="es-sp" />
        <button type="button" className="es-ib" aria-label="閉じる" onClick={props.onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className="es-sh-body">
        <div className="es-sh-sec">
          <img className="es-ph-big" src={props.srcOf(entry.assetId)} alt={meta.alt ?? ""} />
          <p className="es-ph-meta">
            <span>{sizeText(entry.bytes)}</span>
            <span className={`es-ph-used${used > 0 ? " es-ph-used--on" : ""}`}>{used > 0 ? `✓ 本文で使っています（${used} か所）` : "まだ本文で使っていません"}</span>
          </p>
          <div className="es-ph-fields">
            <label>
              代替テキスト（alt）
              <input
                className="es-input"
                type="text"
                value={meta.alt ?? ""}
                maxLength={IMAGE_ALT_MAX_CHARS}
                placeholder="写真に写っているもの"
                onChange={(event) => change({ alt: event.target.value === "" ? null : event.target.value })}
                onBlur={flush}
              />
            </label>
            <label>
              クレジット
              <input
                className="es-input"
                type="text"
                value={meta.credit ?? ""}
                maxLength={IMAGE_CREDIT_MAX_CHARS}
                placeholder="撮った人・出典"
                onChange={(event) => change({ credit: event.target.value === "" ? null : event.target.value })}
                onBlur={flush}
              />
            </label>
            <label className="es-ph-consent">
              <input type="checkbox" checked={meta.consent} onChange={(event) => change({ consent: event.target.checked }, true)} />
              掲載の許諾をもらっている
            </label>
          </div>
        </div>
      </div>
      <div className="es-sh-foot">
        {problem && (
          <span role="alert" className="es-sh-note es-sh-left">
            {problem}
          </span>
        )}
        {confirm === null ? (
          <>
            {body.insert && (
              <button type="button" className="es-btn es-btn--primary" data-autofocus="" onClick={insert}>
                本文に入れる
              </button>
            )}
            <span className="es-sp" />
            <button type="button" className="es-btn es-btn--quiet" onClick={() => setConfirm(body.uses().get(entry.assetId.toLowerCase()) ?? 0)}>
              パネルから外す
            </button>
          </>
        ) : (
          <div className="es-ph-confirm" role="group" aria-label="パネルから外す">
            <span>{confirm > 0 ? `この写真をパネルから外すと、本文の ${confirm} か所からも消えます。元に戻せません。` : "この写真をパネルから外します。元に戻せません。"}</span>
            <span className="es-ph-confirm-acts">
              <button
                ref={removeButton}
                type="button"
                className="es-btn es-btn--outline es-btn--sm"
                aria-disabled={busy || undefined}
                onClick={() => void confirmRemove()}
              >
                外す
              </button>
              <button type="button" className="es-btn es-btn--quiet es-btn--sm" aria-disabled={busy || undefined} onClick={() => !busy && setConfirm(null)}>
                やめる
              </button>
            </span>
          </div>
        )}
      </div>
    </ShellSheet>
  );
}
