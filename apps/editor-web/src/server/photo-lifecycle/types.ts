import type { Photo, PurgeJob } from "../../../../../packages/photo-library-contract/src/v1";

export type PhotoLifecycleMutation = { readonly idempotencyKey: string; readonly requestHash: string };
export type PhotoLifecycleStore = {
  trash(owner: string, photoId: string, input: PhotoLifecycleMutation): Promise<{ readonly photo: Photo; readonly replayed: boolean } | null>;
  restore(owner: string, photoId: string, input: PhotoLifecycleMutation): Promise<{ readonly photo: Photo; readonly replayed: boolean } | null>;
  purge(owner: string, photoId: string, input: PhotoLifecycleMutation): Promise<{ readonly job: PurgeJob; readonly replayed: boolean } | null>;
  photo(owner: string, photoId: string): Promise<Photo | null>;
  job(owner: string, jobId: string): Promise<PurgeJob | null>;
};

export type PhotoLifecycleDeps = { readonly store: PhotoLifecycleStore };
