import type { VerifiedPhotoActor } from "../../../../../packages/photo-library-contract/src/v1";

export type PrivatePhotoJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PrivatePhotoJsonValue[]
  | { readonly [key: string]: PrivatePhotoJsonValue };

export type PrivatePhotoDevelopSettings = { readonly [key: string]: PrivatePhotoJsonValue };

/** NIHOapp private APIのDTO。公開P00 Photo/Libraryとは別契約で、相互変換はまだ行わない。 */
export type NihoPrivatePhoto = Readonly<{
  id: string;
  contentSha256: string;
  fileName: string;
  fileExtension: string;
  contentType: string;
  sizeBytes: number;
  status: "stored";
  storedAt: string;
  developSettings: PrivatePhotoDevelopSettings | null;
  developSettingsUpdatedAt: string | null;
  developRevision: number;
  hasEdits: boolean;
  createdAt: string;
}>;

export type NihoPrivatePhotoList = Readonly<{
  photos: readonly NihoPrivatePhoto[];
  nextCursor: string | null;
}>;

export type NihoPhotoPrivateApiResult<T> = Readonly<{
  actor: VerifiedPhotoActor;
  data: T;
}>;

export type NihoPhotoPrivateApiPurgeResult = Readonly<{
  actor: VerifiedPhotoActor;
}>;
