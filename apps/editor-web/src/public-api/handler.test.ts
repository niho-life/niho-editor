// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createPublicApi, type PublicApiRequest } from "./handler";
import { buildFixture, docPath, listPath, previewPath, SITE_A, type Fixture } from "./testing/contract-scenarios";
import { worldSource } from "./testing/world-source";

/**
 * The contract reference model still understands the old face wire format. The production runtime
 * intentionally differs: it accepts only a personal-site connection key and never consults face credentials.
 */
describe("public API after operated-face retirement", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await buildFixture();
  });

  const call = (request: PublicApiRequest, faceLookup = vi.fn(() => "exp" as const)) => {
    const api = createPublicApi({
      source: worldSource(fixture.world),
      faces: { audienceByHash: faceLookup },
      clock: { now: () => fixture.world.now },
    });
    return { response: api.handle(request), faceLookup };
  };

  it("keeps personal-site list, document, and preview reads available", async () => {
    const requests = [
      { method: "GET", url: listPath(SITE_A), headers: { authorization: `Bearer ${fixture.keys.siteA}` } },
      { method: "GET", url: docPath(SITE_A, fixture.ids.siteLive), headers: { authorization: `Bearer ${fixture.keys.siteA}` } },
      { method: "GET", url: previewPath(fixture.keys.previewSiteA), headers: { authorization: `Bearer ${fixture.keys.siteA}` } },
    ];
    for (const request of requests) {
      const { response } = call(request);
      expect((await response).status, request.url).toBe(200);
    }
  });

  it("rejects legacy Experience credentials without consulting their configured lookup", async () => {
    const requests = [
      { method: "GET", url: listPath("exp"), headers: { authorization: `Bearer ${fixture.keys.exp}` } },
      { method: "GET", url: docPath("exp", fixture.ids.expLive), headers: { authorization: `Bearer ${fixture.keys.exp}` } },
      { method: "GET", url: previewPath(fixture.keys.previewExp), headers: { authorization: `Bearer ${fixture.keys.exp}` } },
    ];
    for (const request of requests) {
      const faceLookup = vi.fn(() => "exp" as const);
      const { response } = call(request, faceLookup);
      expect((await response).status, request.url).toBe(401);
      expect(faceLookup).not.toHaveBeenCalled();
    }
  });

  it("does not let a personal-site key read retained Experience publications or old tokens", async () => {
    for (const url of [docPath("exp", fixture.ids.expLive), previewPath(fixture.keys.previewExp)]) {
      const { response } = call({ method: "GET", url, headers: { authorization: `Bearer ${fixture.keys.siteA}` } });
      expect((await response).status, url).toBe(404);
    }
  });
});
