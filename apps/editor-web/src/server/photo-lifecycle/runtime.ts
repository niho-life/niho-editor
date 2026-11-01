import "server-only";
import { verifyPhotoActor } from "../photo-auth";
import { photoAuthRuntimeDeps } from "../photo-auth/runtime";
import { createPhotoLifecycleRoutes } from "./routes";

/** P13 must wire authenticated account lifecycle events and the isolated purge worker before enabling routes. */
export const photoLifecycleRoutes = createPhotoLifecycleRoutes({
  lifecycle: () => null,
  verify: async (request) => (await verifyPhotoActor(request, photoAuthRuntimeDeps)).actor,
  // P13 must supply the canonical allowlist when it enables lifecycle mutations.
  origins: [],
});
