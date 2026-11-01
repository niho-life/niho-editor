import type { MediaState } from "../../../../../packages/photo-library-contract/src/v1";

export type PhotoMediaEnsureSnapshot = {
  readonly ownerId: string;
  readonly photoId: string;
  readonly media: MediaState;
};

export interface PhotoMediaStore {
  ensure(owner: string, photoId: string, input: {
    readonly recipeRevision: number;
    readonly key: string;
    readonly requestHash: string;
  }): Promise<{ readonly snapshot: PhotoMediaEnsureSnapshot; readonly replayed: boolean } | null>;
}

export type PhotoMediaDeps = { readonly store: PhotoMediaStore };
