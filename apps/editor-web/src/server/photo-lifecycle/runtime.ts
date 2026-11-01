import "server-only";
import { getAuthProvider } from "../../auth";
import { verifyPhotoActor } from "../photo-auth";
import { createPhotoLifecycleRoutes } from "./routes";

/** P13 must wire authenticated account lifecycle events and the isolated purge worker before enabling routes. */
export const photoLifecycleRoutes = createPhotoLifecycleRoutes({
  lifecycle: () => null,
  verify: async (request) => (await verifyPhotoActor(request, { auth: () => getAuthProvider() })).actor,
  // P13 must supply the canonical allowlist when it enables lifecycle mutations.
  origins: [],
});
