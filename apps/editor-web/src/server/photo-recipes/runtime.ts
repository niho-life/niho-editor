import "server-only";
import { getAuthProvider } from "../../auth";
import { verifyPhotoActor } from "../photo-auth";
import { createPhotoRecipesRoutes } from "./routes";

/** P13 must provide the accepted SDK validator and P02 store adapter before recipe writes are enabled. */
export const photoRecipesRoutes = createPhotoRecipesRoutes({
  recipes: () => null,
  verify: async (request) => (await verifyPhotoActor(request, { auth: () => getAuthProvider() })).actor,
  // P13 must supply the canonical allowlist before recipe writes are enabled.
  origins: [],
});
