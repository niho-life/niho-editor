import { afterEach, describe, expect, it, vi } from "vitest";
import { IDS, original, reservedUpload } from "../../../../../packages/photo-library-contract/fixtures/v1";
import { NIHO_SESSION_COOKIE } from "../../auth/niho";
import { stubAuthProvider } from "../../auth/stub";
import { AuthTemporarilyUnavailable, type Session } from "../../auth/types";
import { createFakePhotoStorage } from "../../storage/photo-fake";
import { POST as startRoute } from "../../app/api/photo/v1/uploads/route";
import { GET as getRoute } from "../../app/api/photo/v1/uploads/[uploadId]/route";
import { POST as renewRoute } from "../../app/api/photo/v1/uploads/[uploadId]/renew/route";
import { POST as completeRoute } from "../../app/api/photo/v1/uploads/[uploadId]/complete/route";
import { POST as cancelRoute } from "../../app/api/photo/v1/uploads/[uploadId]/cancel/route";
import { GET as contentRoute } from "../../app/api/photo/v1/photos/[photoId]/content/[assetId]/route";
import { GET as maskRoute } from "../../app/api/photo/v1/photos/[photoId]/masks/[surfaceId]/route";
import { PRIVATE_PHOTO_HEADERS } from "./http";
import { createPhotoTransferRoutes } from "./routes";
import { photoTransferRuntimeDeps } from "./runtime";
import type { PhotoTransferDeps, PhotoTransferStore } from "./types";

const ORIGIN = "https://editor.synthetic.invalid";
const NOW = Date.parse("2030-01-01T00:00:00Z");
const session: Session = { mode: "niho", userId: IDS.userA, sessionId: "synthetic-session", expiresAt: new Date(NOW + 3600_000).toISOString() };
const body = { target: reservedUpload.target, sizeBytes: reservedUpload.sizeBytes, sha256: reservedUpload.sha256, contentType: "image/jpeg" };
const request = (method = "GET", headers: Record<string, string> = {}, value: unknown = {}) => new Request(`${ORIGIN}/api/photo/v1/uploads`, {
  method, headers: { origin: ORIGIN, "content-type": "application/json", "idempotency-key": "synthetic_key_0001", ...headers },
  ...(method === "POST" ? { body: JSON.stringify(value) } : {}),
});
function arrange() {
  const getSession = vi.fn(async (): Promise<Session | null> => session);
  const store: PhotoTransferStore = {
    reserve: vi.fn(async () => null), upload: vi.fn(async () => null), uploadByStartKey: vi.fn(async () => null),
    claim: vi.fn(async () => null), complete: vi.fn(async () => null), cancel: vi.fn(async () => null),
    reject: vi.fn(async () => null), orphan: vi.fn(async () => null), photo: vi.fn(async () => null),
    asset: vi.fn(async () => null), mask: vi.fn(async () => null),
  };
  const storage = createFakePhotoStorage(() => NOW).storage;
  const storageCalls = Object.values(storage).map((fn) => vi.fn(fn));
  Object.keys(storage).forEach((key, index) => { Object.assign(storage, { [key]: storageCalls[index] }); });
  const deps: PhotoTransferDeps = { store, storage, origins: [ORIGIN], now: () => NOW,
    journal: { bind: vi.fn(async () => false) }, probe: { inspect: vi.fn() } };
  const transfer = vi.fn(() => deps);
  const auth = () => ({ ...stubAuthProvider, mode: "niho" as const, getSession });
  return { getSession, store, storageCalls, deps, transfer, auth,
    routes: createPhotoTransferRoutes({ auth, transfer, now: () => NOW }) };
}

afterEach(() => vi.restoreAllMocks());

describe("photo transfer HTTP authentication", () => {
  it("uses a newly verified browser actor on each request, and scopes metadata to that actor", async () => {
    const f = arrange();
    vi.mocked(f.store.mask).mockResolvedValue({ ...original, kind: "mask", photoId: IDS.photo, objectKey: "private/synthetic", objectGeneration: "7", deletionState: "retained", createdAt: session.expiresAt! });
    const first = await f.routes.mask(request(), IDS.photo, original.sha256);
    expect(first.status).toBe(200); expect(await first.json()).toEqual({ ...original, kind: "mask" });
    f.getSession.mockResolvedValueOnce({ ...session, userId: IDS.userB });
    await f.routes.mask(request(), IDS.photo, original.sha256);
    expect(f.getSession).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.store.mask).mock.calls).toEqual([[IDS.userA, IDS.photo, original.sha256], [IDS.userB, IDS.photo, original.sha256]]);
    expect(f.deps.probe.inspect).not.toHaveBeenCalled();
  });
  it.each(["missing", "stub", "expired", "unavailable", "identity", "ambiguous", "origin"])("rejects %s authentication before runtime/store/storage", async (kind) => {
    const f = arrange(); const headers: Record<string, string> = {};
    if (kind === "missing") f.getSession.mockResolvedValue(null);
    if (kind === "stub") f.getSession.mockResolvedValue({ ...session, mode: "stub" });
    if (kind === "expired") f.getSession.mockResolvedValue({ ...session, expiresAt: new Date(NOW - 1).toISOString() });
    if (kind === "unavailable") f.getSession.mockRejectedValue(new AuthTemporarilyUnavailable("synthetic private detail"));
    if (kind === "identity") headers["x-owner-id"] = IDS.userB;
    if (kind === "ambiguous") { headers.authorization = "Bearer synthetic"; headers.cookie = `${NIHO_SESSION_COOKIE}=synthetic`; }
    if (kind === "origin") { headers.cookie = `${NIHO_SESSION_COOKIE}=synthetic`; headers.origin = "https://foreign.invalid"; }
    const response = await f.routes.start(request("POST", headers, body));
    expect(response.status).toBe(kind === "unavailable" ? 503 : kind === "identity" || kind === "ambiguous" ? 400 : kind === "origin" ? 403 : 401);
    for (const [key, value] of Object.entries(PRIVATE_PHOTO_HEADERS)) expect(response.headers.get(key)).toBe(value);
    expect(await response.text()).not.toContain("private detail");
    expect(f.transfer).not.toHaveBeenCalled();
    Object.values(f.store).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    f.storageCalls.forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });
  it("verifies Mac bearer against NIHO and derives owner only from the verified result", async () => {
    const f = arrange();
    const fetch = vi.fn(async () => Response.json({ actor: { id: IDS.userB }, sessionId: "synthetic-native", expiresAt: session.expiresAt,
      clientId: "niho-editor", audience: "niho-photo", sourceClientId: "niho-camera", refreshRequired: false }));
    const routes = createPhotoTransferRoutes({ auth: f.auth, transfer: f.transfer, now: () => NOW,
      env: { EDITOR_NIHO_ORIGIN: "https://niho.synthetic.invalid" }, fetch });
    expect((await routes.get(request("GET", { authorization: "Bearer synthetic-native-token" }), IDS.upload)).status).toBe(404);
    expect(f.store.upload).toHaveBeenCalledWith(IDS.userB, IDS.upload); expect(f.getSession).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect((await routes.get(request("GET", { authorization: "Bearer synthetic-native-token" }), IDS.upload)).status).toBe(401);
    expect(f.transfer).toHaveBeenCalledOnce();
  });
  it("passes closed bodies and owner-bound resources through the transfer core", async () => {
    const f = arrange();
    expect((await f.routes.start(request("POST", {}, { ...body, owner: IDS.userB }))).status).toBe(400);
    expect(f.store.reserve).not.toHaveBeenCalled();
    expect((await f.routes.start(request("POST", {}, body))).status).toBe(404);
    expect(f.deps.journal.bind).toHaveBeenCalledWith(expect.objectContaining({ owner: IDS.userA, operation: "uploads.start", resourceId: "original" }));
    for (const method of [f.routes.get, f.routes.renew, f.routes.complete, f.routes.cancel]) {
      expect((await method(request(method === f.routes.get ? "GET" : "POST"), IDS.upload)).status).toBe(404);
    }
    expect((await f.routes.content(request("GET", { range: "invalid" }), IDS.photo, IDS.original)).status).toBe(404);
    expect(f.store.asset).toHaveBeenCalledWith(IDS.userA, IDS.photo, IDS.original);
    expect(f.deps.storage.read).not.toHaveBeenCalled();
  });
});

describe("contract Next routes with default production runtime", () => {
  it("leaves all seven endpoints fail-closed after real actor verification", async () => {
    const getSession = vi.fn(async () => session);
    vi.spyOn(photoTransferRuntimeDeps, "photoAuth").mockReturnValue({ ...stubAuthProvider, mode: "niho", getSession });
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const upload = { params: Promise.resolve({ uploadId: IDS.upload }) };
    const responses = await Promise.all([
      startRoute(request("POST", {}, body)), getRoute(request(), upload), renewRoute(request("POST"), upload),
      completeRoute(request("POST"), upload), cancelRoute(request("POST"), upload),
      contentRoute(request(), { params: Promise.resolve({ photoId: IDS.photo, assetId: IDS.original }) }),
      maskRoute(request(), { params: Promise.resolve({ photoId: IDS.photo, surfaceId: original.sha256 }) }),
    ]);
    expect(getSession).toHaveBeenCalledTimes(7);
    for (const response of responses) {
      expect(response.status).toBe(503); expect(response.headers.get("retry-after")).toBe("1");
      expect((await response.json()).error).toEqual({ code: "temporarily_unavailable", retryable: true, requestId: expect.any(String), retryAfterSeconds: 1 });
    }
  });
});
