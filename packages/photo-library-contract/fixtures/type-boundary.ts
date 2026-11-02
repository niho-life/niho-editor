import type { PhotoOperationMap } from "../src/v1.ts";

// These must stay compile errors: identifiers and stale recipes confer no authority.
// @ts-expect-error The caller cannot choose the library owner.
const forged: PhotoOperationMap["library.get"]["request"] = { ownerId: "synthetic-user-b" };
// @ts-expect-error Every recipe write requires expectedRevision and baseVersion.
const unconditional: PhotoOperationMap["recipes.put"]["request"] = { photoId: "synthetic-photo", settings: { v: 1, engine: "niho-14" } };
// @ts-expect-error Resolving a saved conflict is a CAS against the active recipe.
const unconditionalConflict: PhotoOperationMap["recipe-conflicts.resolve"]["request"] = { photoId: "synthetic-photo", conflictId: "synthetic-conflict", decision: "adopt" };
// @ts-expect-error The client selects a saved conflict by ID; it cannot replace its payload.
const clientSuppliedConflict: PhotoOperationMap["recipe-conflicts.resolve"]["request"] = { photoId: "synthetic-photo", conflictId: "synthetic-conflict", expectedRevision: 1, decision: "adopt", settings: { v: 1, engine: "niho-14" } };
void forged;
void unconditional;
void unconditionalConflict;
void clientSuppliedConflict;
