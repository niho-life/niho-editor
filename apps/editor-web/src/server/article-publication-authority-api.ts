import "server-only";
import { notFoundResponse } from "./http";

/** Experience article authority is retired. The endpoint never authenticates, reads data, or calls upstreams. */
export function publicationAuthorityRoute(): Promise<Response> {
  return Promise.resolve(notFoundResponse());
}
