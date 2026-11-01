import "server-only";
import { verifyPhotoActor } from "../photo-auth";
import { photoAuthRuntimeDeps } from "../photo-auth/runtime";
import { createPhotoMediaRoutes } from "./routes";

/** P13 must provide an accepted renderer/output spec and database adapter before media ensure is enabled. */
export const photoMediaRoutes = createPhotoMediaRoutes({
  media: () => null,
  verify: async (request) => (await verifyPhotoActor(request, photoAuthRuntimeDeps)).actor,
  origins: [],
});
