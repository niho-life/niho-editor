/**
 * Shared shapes of @niho/editor-publish. Spec: docs/architecture/editor-publish-core.md (#39).
 * Inputs from the editor store and other ports are typed here but still checked at run time:
 * every function below treats them as untrusted data.
 */

import {
  destOfHandle,
  isConnectionHandle,
  isFaceDest,
  type Dest,
  type Extras,
  type FaceDest,
  type Lang,
  type PublicationRange,
} from "@niho/editor-publish-contract";

/**
 * The account's storage mode (design §2.1). The names are `DocsStorageMode`'s in @niho/docs-core, which this
 * package does not depend on. `UNSET` (never chosen) is read as `CLOUD`.
 */
export const STORAGE_MODES = ["UNSET", "CLOUD", "CLOSING", "LOCAL"] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];

/** Why publishing is off: the pages live only on the Mac, are being moved there, or the mode is not one we know. */
export type StorageBlock = "LOCAL" | "CLOSING" | "unknown";

/** `null` when the server may hold pages and publish (`CLOUD`, `UNSET`). Anything else, a value we do not know included, blocks (fail closed). */
export function storageBlockOf(mode: unknown): StorageBlock | null {
  if (mode === "CLOUD" || mode === "UNSET") return null;
  return mode === "LOCAL" || mode === "CLOSING" ? mode : "unknown";
}

/** The field of the sheet / page that "直す" opens. Closed vocabulary. */
export const FIXES = ["lang", "cover", "lead", "category", "body", "related"] as const;
export type Fix = (typeof FIXES)[number];

/** Something that stops publishing. `node` names the offending node type when there is one. */
export interface Problem {
  readonly id: string;
  readonly message: string;
  readonly fix: Fix;
  readonly node?: string;
}

/** Something the author should know that does not stop publishing. */
export interface Notice {
  readonly id: string;
  readonly message: string;
}

/** "あわせて" options. `xp` is only offered by NIHO Experience. */
export const EXTRA_KEYS = ["app", "news", "xp"] as const;
export type ExtraKey = (typeof EXTRA_KEYS)[number];

/**
 * A page as the editor stores it (#33). `content` is TipTap's top-level node list (or a `doc` node);
 * image nodes carry `attrs: { assetId, alt, caption? }`.
 */
export interface DraftPage {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly lang: Lang;
  readonly lead: string | null;
  readonly coverAssetId: string | null;
  readonly content: unknown;
}

/** An asset as the editor stores it. `kind` is `image` or `audio`; only images are ever published. */
export interface AssetRecord {
  readonly id: string;
  readonly kind: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly alt: string | null;
  readonly credit: string | null;
  readonly consent: boolean;
  /**
   * 共有画像にも使ってよい（OG 画像・`Article.image`）。掲載許諾（consent）とは別の、画像ごとの許諾。
   * Missing means false. Only a cover with both consent and share makes the published version say `coverShareable`.
   */
  readonly share?: boolean;
}

/**
 * Where to publish. Faces are addressed by their dest (their handle is the dest);
 * an owner's site by its connection handle (the connection itself lives behind a port, #41).
 */
export type Target = { readonly dest: FaceDest } | { readonly dest: "site"; readonly handle: string };

/** Settings chosen on the sheet. Stored on the publication, not on the page. */
export interface PublishSettings {
  readonly range: PublicationRange;
  readonly extras: Extras;
  readonly category: string | null;
  readonly related: readonly string[];
}

/** The readable handle of a target, or null when the target is malformed. */
export function handleOfTarget(target: unknown): string | null {
  if (typeof target !== "object" || target === null) return null;
  const { dest, handle } = target as { dest?: unknown; handle?: unknown };
  if (isFaceDest(dest)) return handle === undefined || handle === dest ? dest : null;
  if (dest === "site") return isConnectionHandle(handle) ? handle : null;
  return null;
}

/** The dest a readable handle serves. Faces use their dest as handle. */
export function destOf(handle: string): Dest | null {
  return destOfHandle(handle);
}

/** Legacy face-role vocabulary retained for stored/wire compatibility. No face is currently publishable. */
export const FACE_ROLES = {
  exp: "writer",
} as const;

/** Faces offered for a new publication. Face identifiers remain valid for old records only. */
export const PUBLISHABLE_FACE_DESTS = [] as const satisfies readonly FaceDest[];

export function roleAllows(_roles: readonly string[], _dest: FaceDest): boolean {
  return false;
}
