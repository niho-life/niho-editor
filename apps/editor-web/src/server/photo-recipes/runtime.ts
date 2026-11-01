import "server-only";
import { verifyPhotoActor } from "../photo-auth";
import { photoAuthRuntimeDeps } from "../photo-auth/runtime";
import { createPhotoRecipesRoutes } from "./routes";

/** P13 must provide the accepted SDK validator and P02 store adapter before recipe writes are enabled. */
export const photoRecipesRoutes = createPhotoRecipesRoutes({
  recipes: () => null,
  verify: async (request) => (await verifyPhotoActor(request, photoAuthRuntimeDeps)).actor,
  // P13 must supply the canonical allowlist before recipe writes are enabled.
  origins: [],
});
