import type { Photo, PhotoInfo, PhotoListQuery, PhotoLookupMatch, PersonalPhotoLibrary } from "../../../../../packages/photo-library-contract/src/v1";

export type PhotoCatalogFilter = Omit<PhotoListQuery, "cursor" | "limit"> & {
  readonly sort: NonNullable<PhotoListQuery["sort"]>;
  readonly lifecycle: NonNullable<PhotoListQuery["lifecycle"]>;
};

export type PhotoCatalogAfter =
  | { readonly sort: "added-desc"; readonly addedAt: string; readonly id: string }
  | { readonly sort: "captured-desc"; readonly capturedAt: string | null; readonly addedAt: string; readonly id: string };

export type PhotoCatalogPageInput = {
  readonly filter: PhotoCatalogFilter;
  /** Null only on the first page. Later pages reuse the first page's immutable creation watermark. */
  readonly watermark: number | null;
  readonly after: PhotoCatalogAfter | null;
  readonly limit: number;
};

export type PhotoCatalogPageResult = {
  readonly library: PersonalPhotoLibrary;
  /** The highest creation sequence visible when this cursor chain started. */
  readonly watermark: number;
  readonly items: readonly Photo[];
  readonly hasMore: boolean;
};

export type PhotoCatalogLibrarySnapshot = Pick<PersonalPhotoLibrary, "id" | "owner" | "state" | "revision">;

export interface PhotoCatalogStore {
  /** Owner is supplied by the trusted route after P01 resolution, never from a query or request body. */
  library(owner: string): Promise<PersonalPhotoLibrary | null>;
  /**
   * Must apply owner, lifecycle, filters, stable ordering and creation watermark in one DB snapshot.
   * added-desc orders addedAt DESC, id DESC; captured-desc orders capturedAt DESC NULLS LAST,
   * addedAt DESC, id DESC. `after` is a keyset tuple, never an offset.
   */
  page(owner: string, input: PhotoCatalogPageInput): Promise<PhotoCatalogPageResult | null>;
  /** Must enforce owner and photo relation before returning any content. */
  photo(owner: string, photoId: string): Promise<{ photo: Photo; library: PhotoCatalogLibrarySnapshot } | null>;
  /** The caller first checks photo() so a missing info row cannot reveal another owner's photo. */
  info(owner: string, photoId: string): Promise<PhotoInfo | null>;
  /** Owner-scoped, limited to requested hashes, and fails closed for deleting libraries. */
  lookup(owner: string, sha256s: readonly string[]): Promise<readonly PhotoLookupMatch[]>;
}
