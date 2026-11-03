// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachedPage } from "./attached-page";
import { usePageMenu, type PageMenu } from "./use-page-menu";

const PAGE = "11111111-1111-4111-8111-111111111111";

describe("Google Docs共通batch面への入口", () => {
  let root: Root;
  let container: HTMLElement;
  let menu: PageMenu;
  const go = vi.fn();

  function Harness({ saved }: { saved: boolean }) {
    const page = { id: PAGE, flush: vi.fn(async () => saved), shared: null } as unknown as AttachedPage;
    menu = usePageMenu({
      page, current: () => page, onDuplicated: vi.fn(), onDeleted: vi.fn(), openSheet: vi.fn(), focusMore: vi.fn(),
      goToGoogleDocsBatch: go,
    });
    return null;
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    go.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness saved />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("単ページもfolderも同じ面へ、既存flush/CAS成功後だけ移動する", async () => {
    await act(async () => {
      menu.more!.onSelect("export-google-docs-batch");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(go).toHaveBeenCalledWith(`/google-docs/batch/${PAGE}`);

    await act(async () => root.render(<Harness saved={false} />));
    go.mockClear();
    await act(async () => {
      menu.more!.onSelect("export-google-docs-batch");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(go).not.toHaveBeenCalled();
  });
});
