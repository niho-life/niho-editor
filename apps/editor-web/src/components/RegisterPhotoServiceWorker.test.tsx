// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let pathname = "/photo";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import { RegisterPhotoServiceWorker } from "./RegisterPhotoServiceWorker";

const register = vi.fn<() => Promise<unknown>>();
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  pathname = "/photo";
  register.mockReset().mockResolvedValue({});
  vi.stubEnv("NODE_ENV", "production");
  Object.defineProperty(document, "readyState", { value: "complete", configurable: true });
  Object.defineProperty(navigator, "serviceWorker", { value: { register }, configurable: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllEnvs();
});

async function mount() {
  await act(async () => root?.render(<RegisterPhotoServiceWorker />));
}

describe("RegisterPhotoServiceWorker", () => {
  it("registers the photo worker with the narrow scope and no HTTP update cache", async () => {
    await mount();
    expect(register).toHaveBeenCalledWith("/photo-sw.js", { scope: "/photo", updateViaCache: "none" });
  });

  it("does not register on a photo authentication route", async () => {
    pathname = "/photo/auth/login";
    await mount();
    expect(register).not.toHaveBeenCalled();
  });
});
