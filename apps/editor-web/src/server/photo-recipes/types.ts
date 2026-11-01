import type { NamedVersion, PersonalPhotoLibrary, Photo, RecipeDocument, VersionSet, WorkingCopy } from "../../../../../packages/photo-library-contract/src/v1";

export type PhotoRecipeLibrarySnapshot = Pick<PersonalPhotoLibrary, "id" | "owner" | "state" | "revision" | "capabilities">;
export type PhotoRecipeSnapshot = { readonly photo: Photo; readonly library: PhotoRecipeLibrarySnapshot };

/** The pinned SDK/runtime validates recipe compatibility and extracts every referenced mask surface. */
export interface PhotoRecipeValidator {
  validate(settings: RecipeDocument["settings"], input: {
    readonly photo: Photo;
    readonly library: PhotoRecipeLibrarySnapshot;
  }): Promise<{ readonly settingsSha256: string; readonly maskSurfaceIds: readonly string[] } | null>;
}

export type PhotoCanonicalContextIdentity = {
  readonly ownerId: string;
  readonly libraryId: string;
  readonly photoId: string;
  readonly originalAssetId: string;
  readonly originalSha256: string;
  readonly baseVersion: string;
  readonly rendererManifestSha256: string;
};

export type PhotoCanonicalContext = PhotoCanonicalContextIdentity & {
  readonly workingCopy: WorkingCopy;
};

/** Server-only lookup. The verified actor/snapshot supplies every ownership and source field. */
export type PhotoCanonicalContextResolver = (
  expected: PhotoCanonicalContextIdentity,
) => Promise<PhotoCanonicalContext | null>;

export type ValidatedRecipeWrite = {
  readonly settings: RecipeDocument["settings"];
  readonly settingsSha256: string;
  readonly baseVersion: string | null;
  readonly maskSurfaceIds: readonly string[];
};

export type ValidatedVersionWrite = {
  readonly id: string;
  readonly name: string;
  readonly kind: NamedVersion["kind"];
  readonly recipe: ValidatedRecipeWrite;
};

/**
 * P02 is the only writer. Every mutation must atomically enforce owner, active lifecycle,
 * expected revision, mask ownership/existence, idempotency and media outbox fencing. Resolve an
 * existing matching idempotency key before evaluating CAS so successful retries stay replayable.
 */
export interface PhotoRecipeStore {
  photo(owner: string, photoId: string): Promise<PhotoRecipeSnapshot | null>;
  versionSet(owner: string, photoId: string): Promise<(PhotoRecipeSnapshot & { readonly versions: VersionSet }) | null>;
  /** Return current owner state for an already committed key, or null for a new key; hash mismatch conflicts. */
  replayRecipe(owner: string, photoId: string, input: { readonly key: string; readonly requestHash: string }): Promise<PhotoRecipeSnapshot | null>;
  replayVersions(owner: string, photoId: string, input: { readonly key: string; readonly requestHash: string }): Promise<(PhotoRecipeSnapshot & { readonly versions: VersionSet }) | null>;
  putRecipe(owner: string, photoId: string, input: {
    readonly expectedRevision: number;
    readonly key: string;
    readonly requestHash: string;
    readonly recipe: ValidatedRecipeWrite;
  }): Promise<{ readonly photo: Photo; readonly replayed: boolean } | null>;
  putVersions(owner: string, photoId: string, input: {
    readonly expectedRevision: number;
    readonly key: string;
    readonly requestHash: string;
    readonly versions: readonly ValidatedVersionWrite[];
  }): Promise<{ readonly versions: VersionSet; readonly replayed: boolean } | null>;
}

export type PhotoRecipeDeps = {
  readonly store: PhotoRecipeStore;
  readonly validator: PhotoRecipeValidator;
};
