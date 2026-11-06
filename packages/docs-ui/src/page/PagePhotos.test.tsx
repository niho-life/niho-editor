// @vitest-environment jsdom
import axe from "axe-core";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PageImageEntry, PageImageUploadResult, PageImages } from "./images";
import { PAGE_IMAGE_DRAG_TYPE, type PagePhotosBody } from "./page-photos";
import { PAGE_PHOTOS_ADD_TEXT, PAGE_PHOTOS_FULL_TEXT, PAGE_PHOTOS_LABEL, PagePhotos, type PagePhotosProps } from "./PagePhotos";

// 合成のページ・資産の id と、1 バイトの偽のファイルだけを使う（実在の画像は入れない）
const PAGE = "6f1d0d7c-6f6c-4c39-9a52-6a1f3b1c0d11";
const ids = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(8, "0")}-0d11-4c39-9a52-6f6c6f1d0d7c`);
const srcOf = (assetId: string) => `/api/assets/${assetId}`;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

const entry = (assetId: string, alt: string | null = null): PageImageEntry => ({
  assetId,
  meta: { alt, credit: null, consent: false },
  bytes: 2048,
  contentType: "image/png",
  createdAt: new Date(0).toISOString(),
});

type Log = string[];

function stubImages(options: { entries?: PageImageEntry[]; upload?: (file: File) => PageImageUploadResult; remove?: boolean; log?: Log } = {}) {
  const log = options.log ?? [];
  const uploads: string[] = [];
  const images: PageImages = {
    upload: vi.fn(async (file: File): Promise<PageImageUploadResult> => {
      uploads.push(file.name);
      return options.upload?.(file) ?? { ok: true, assetId: ids[50 + uploads.length]!, meta: { alt: null, credit: null, consent: false } };
    }),
    saveMeta: vi.fn(async () => true),
    list: vi.fn(async () => options.entries ?? [entry(ids[1]!, "新しい合成の写真"), entry(ids[0]!)]),
    remove: vi.fn(async () => {
      log.push("remove");
      return options.remove ?? true;
    }),
  };
  return { images, uploads, log };
}

function stubBody(uses: Map<string, number> = new Map(), log: Log = []) {
  const body: PagePhotosBody = {
    // 本物（pageImageUses）と同じく、読むたびに新しい Map を返す
    uses: () => new Map(uses),
    subscribe: () => () => undefined,
    insert: vi.fn(() => true),
    update: vi.fn(),
    removed: vi.fn((assetId: string) => {
      log.push("removed");
      uses.delete(assetId.toLowerCase());
    }),
  };
  return body;
}

function Harness(props: Omit<PagePhotosProps, "open" | "onOpenChange" | "height" | "onHeightChange"> & { startOpen?: boolean; onHeight?: (value: number) => void }) {
  const [open, setOpen] = useState(props.startOpen ?? false);
  const [height, setHeight] = useState(300);
  return (
    <div data-docs-app-root="" data-docs-shared-ui="">
      <div className="es-root">
        <aside className="es-sb">
          <nav className="es-sb-list" />
          <PagePhotos
            {...props}
            open={open}
            onOpenChange={setOpen}
            height={height}
            onHeightChange={(value) => {
              setHeight(value);
              props.onHeight?.(value);
            }}
          />
        </aside>
      </div>
    </div>
  );
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index++) await Promise.resolve();
  });
}

async function mount(props: Parameters<typeof Harness>[0]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Harness {...props} />));
  await flush();
}

const fold = () => host!.querySelector<HTMLButtonElement>(".es-ph-fold")!;
const addButton = () => host!.querySelector<HTMLButtonElement>("[data-page-photos-add]");
const tiles = () => [...host!.querySelectorAll<HTMLButtonElement>(".es-ph-tile[data-asset-id]")];
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (label: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label) ?? null;
const click = async (target: HTMLElement | null) => {
  expect(target).not.toBeNull();
  await act(async () => target!.click());
  await flush();
};

function chooseFiles(files: File[]) {
  const input = host!.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const png = (name: string) => new File([new Uint8Array([1])], name, { type: "image/png" });

describe("このページの写真（パネル）", () => {
  it("starts closed as a single photo icon, opens and closes on the icon, and never shows a count", async () => {
    const { images } = stubImages();
    await mount({ pageId: PAGE, images, srcOf, body: stubBody() });
    expect(fold().getAttribute("aria-label")).toBe(PAGE_PHOTOS_LABEL);
    expect(fold().getAttribute("title")).toBe(PAGE_PHOTOS_LABEL);
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    expect(fold().textContent).not.toContain(PAGE_PHOTOS_LABEL);
    expect(addButton()).toBeNull();
    expect(images.list).not.toHaveBeenCalled();
    expect(host!.querySelector('[role="separator"]')).toBeNull();

    await click(fold());
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    expect(images.list).toHaveBeenCalledWith(PAGE);
    expect(tiles().map((tile) => tile.dataset.assetId)).toEqual([ids[1], ids[0]]);
    expect(addButton()?.getAttribute("aria-label")).toBe(PAGE_PHOTOS_ADD_TEXT);
    expect(host!.querySelector('[role="separator"]')).not.toBeNull();
    expect(host!.textContent).not.toMatch(/\d+\s*\/\s*100/);
    expect(tiles()[0]!.querySelector("img")!.getAttribute("src")).toBe(srcOf(ids[1]!));

    await click(fold());
    expect(fold().getAttribute("aria-expanded")).toBe("false");
    expect(tiles()).toHaveLength(0);
  });

  it("marks the photos the body uses with a check shape and words, not color alone", async () => {
    const { images } = stubImages();
    await mount({ pageId: PAGE, images, srcOf, body: stubBody(new Map([[ids[0]!, 2]])), startOpen: true });
    const [fresh, used] = tiles();
    expect(used!.querySelector(".es-ph-ck svg")).not.toBeNull();
    expect(used!.getAttribute("aria-label")).toContain("本文で使っています");
    expect(fresh!.querySelector(".es-ph-ck")).toBeNull();
    expect(fresh!.getAttribute("aria-label")).toBe("新しい合成の写真");
    expect(host!.textContent).toContain("✓ は本文で使っている写真");
  });

  it("drags a tile as the page-photo type with its id and fields", async () => {
    const { images } = stubImages();
    await mount({ pageId: PAGE, images, srcOf, body: stubBody(), startOpen: true });
    const data = new Map<string, string>();
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { setData: (type: string, value: string) => data.set(type, value), effectAllowed: "" } });
    act(() => {
      tiles()[0]!.dispatchEvent(event);
    });
    expect(JSON.parse(data.get(PAGE_IMAGE_DRAG_TYPE)!)).toEqual({ assetId: ids[1], alt: "新しい合成の写真", credit: null, consent: false });
    expect(tiles()[0]!.getAttribute("draggable")).toBe("true");
  });

  it("opens a photo large, and puts it into the body from the dialog", async () => {
    const { images } = stubImages();
    const body = stubBody();
    const onInserted = vi.fn();
    await mount({ pageId: PAGE, images, srcOf, body, startOpen: true, onInserted });
    await click(tiles()[0]!);
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector<HTMLImageElement>(".es-ph-big")!.getAttribute("src")).toBe(srcOf(ids[1]!));
    expect(dialog()!.textContent).toContain("まだ本文で使っていません");
    await click(button("本文に入れる", dialog()!));
    expect(body.insert).toHaveBeenCalledWith({ assetId: ids[1], alt: "新しい合成の写真", credit: null, consent: false });
    expect(onInserted).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it("asks before removing, removes on the server first, then from every place in the body", async () => {
    const log: Log = [];
    const { images } = stubImages({ log });
    const body = stubBody(new Map([[ids[0]!, 2]]), log);
    await mount({ pageId: PAGE, images, srcOf, body, startOpen: true });
    await click(tiles()[1]!);
    expect(dialog()!.textContent).toContain("本文で使っています（2 か所）");
    await click(button("パネルから外す", dialog()!));
    expect(dialog()!.textContent).toContain("この写真をパネルから外すと、本文の 2 か所からも消えます。元に戻せません。");
    expect(images.remove).not.toHaveBeenCalled();
    await click(button("やめる", dialog()!));
    await click(button("パネルから外す", dialog()!));
    await click(button("外す", dialog()!));
    expect(log).toEqual(["remove", "removed"]);
    expect(images.remove).toHaveBeenCalledWith(PAGE, ids[0]);
    expect(body.removed).toHaveBeenCalledWith(ids[0]);
    expect(dialog()).toBeNull();
    expect(tiles().map((tile) => tile.dataset.assetId)).toEqual([ids[1]]);
    expect(host!.textContent).toContain("本文の 2 か所からも消しました");
  });

  it("changes nothing in the body when the server could not remove the photo", async () => {
    const log: Log = [];
    const { images } = stubImages({ remove: false, log });
    const body = stubBody(new Map([[ids[0]!, 1]]), log);
    await mount({ pageId: PAGE, images, srcOf, body, startOpen: true });
    await click(tiles()[1]!);
    await click(button("パネルから外す", dialog()!));
    await click(button("外す", dialog()!));
    expect(log).toEqual(["remove"]);
    expect(body.removed).not.toHaveBeenCalled();
    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toContain("外せませんでした");
    expect(tiles()).toHaveLength(2);
  });

  it("adds chosen files to the panel only, and offers retry and cancel on one line when an upload fails", async () => {
    let fail = true;
    const { images, uploads } = stubImages({
      entries: [],
      upload: () => (fail ? { ok: false, problem: "failed" } : { ok: true, assetId: ids[70]!, meta: { alt: null, credit: null, consent: false } }),
    });
    const body = stubBody();
    await mount({ pageId: PAGE, images, srcOf, body, startOpen: true });
    expect(host!.textContent).toContain("関連する写真をここに落とす");
    await act(async () => chooseFiles([png("合成.png"), new File(["x"], "合成.heic", { type: "image/heic" })]));
    await flush();
    expect(uploads).toEqual(["合成.png"]);
    expect(body.insert).not.toHaveBeenCalled();
    const failed = host!.querySelector<HTMLElement>("[data-page-photo-failed]")!;
    expect(failed.textContent).toContain("合成.png");
    fail = false;
    await click(button("再試行", failed));
    expect(uploads).toEqual(["合成.png", "合成.png"]);
    expect(host!.querySelector("[data-page-photo-failed]")).toBeNull();
    expect(tiles().map((tile) => tile.dataset.assetId)).toEqual([ids[70]]);

    fail = true;
    await act(async () => chooseFiles([png("合成2.png")]));
    await flush();
    await click(button("取り消す", host!.querySelector<HTMLElement>("[data-page-photo-failed]")!));
    expect(host!.querySelector("[data-page-photo-failed]")).toBeNull();
    expect(tiles()).toHaveLength(1);
  });

  it("keeps a photo that finished uploading while the list could not be read, and shows it once when the list is read again", async () => {
    const { images, uploads } = stubImages();
    vi.mocked(images.list!).mockResolvedValueOnce(null);
    await mount({ pageId: PAGE, images, srcOf, body: stubBody(), startOpen: true });
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain("写真を読み込めませんでした");
    await act(async () => chooseFiles([png("読めない間.png")]));
    await flush();
    expect(uploads).toEqual(["読めない間.png"]);
    // 一覧が読めていなくても、上がった写真はパネルに出る（消えない）。読めなかった案内と「もう一度」も残る
    expect(tiles().map((tile) => tile.dataset.assetId)).toEqual([ids[51]]);
    expect(host!.querySelector('[role="alert"]')).not.toBeNull();
    // 読み直したら一覧が正（上がった写真が一覧に入っていれば、二重に出さない）
    vi.mocked(images.list!).mockResolvedValueOnce([entry(ids[51]!), entry(ids[0]!)]);
    await click(button("もう一度"));
    expect(tiles().map((tile) => tile.dataset.assetId)).toEqual([ids[51], ids[0]]);
    expect(host!.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a photo that finished uploading before the first list came back, even when that list does not have it yet", async () => {
    const { images } = stubImages();
    let resolveList: (value: PageImageEntry[]) => void = () => undefined;
    vi.mocked(images.list!).mockImplementationOnce(() => new Promise<PageImageEntry[]>((resolve) => (resolveList = resolve)));
    await mount({ pageId: PAGE, images, srcOf, body: stubBody(), startOpen: true });
    expect(host!.textContent).toContain("読み込んでいます");
    await act(async () => chooseFiles([png("先に上がった.png")]));
    await flush();
    expect(tiles().map((tile) => tile.dataset.assetId)).toEqual([ids[51]]);
    // 読み始めたあとに上がった写真は、その一覧に無くても残る（古い一覧で消さない）
    await act(async () => resolveList([entry(ids[0]!)]));
    await flush();
    expect(tiles().map((tile) => tile.dataset.assetId)).toEqual([ids[51], ids[0]]);
  });

  it("removes a photo that was kept outside the list the same way as a listed one", async () => {
    const { images } = stubImages();
    vi.mocked(images.list!).mockResolvedValueOnce(null);
    await mount({ pageId: PAGE, images, srcOf, body: stubBody(), startOpen: true });
    await act(async () => chooseFiles([png("外す.png")]));
    await flush();
    await click(tiles()[0]!);
    await click(button("パネルから外す", dialog()!));
    await click(button("外す", dialog()!));
    expect(images.remove).toHaveBeenCalledWith(PAGE, ids[51]);
    expect(tiles()).toEqual([]);
  });

  it("refuses the 101st photo: the plus is not pressable and says why", async () => {
    const { images } = stubImages({ entries: ids.map((id) => entry(id)) });
    await mount({ pageId: PAGE, images, srcOf, body: stubBody(), startOpen: true });
    expect(tiles()).toHaveLength(100);
    expect(addButton()!.getAttribute("aria-disabled")).toBe("true");
    expect(addButton()!.getAttribute("title")).toBe(PAGE_PHOTOS_FULL_TEXT);
    const picker = host!.querySelector<HTMLInputElement>('input[type="file"]')!;
    const opened = vi.spyOn(picker, "click");
    await click(addButton());
    expect(opened).not.toHaveBeenCalled();
    expect(host!.querySelector('[role="status"]')!.textContent).toContain(PAGE_PHOTOS_FULL_TEXT);
  });

  it("opens and uploads when files are dropped on the closed row", async () => {
    const { images, uploads } = stubImages({ entries: [] });
    await mount({ pageId: PAGE, images, srcOf, body: stubBody() });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [png("落とした合成.png")], dropEffect: "" } });
    await act(async () => {
      host!.querySelector(".es-ph")!.dispatchEvent(drop);
    });
    await flush();
    expect(drop.defaultPrevented).toBe(true);
    expect(fold().getAttribute("aria-expanded")).toBe("true");
    expect(uploads).toEqual(["落とした合成.png"]);
  });

  it("resizes with the arrow keys on the separator", async () => {
    const { images } = stubImages();
    const onHeight = vi.fn();
    await mount({ pageId: PAGE, images, srcOf, body: stubBody(), startOpen: true, onHeight });
    const aside = host!.querySelector<HTMLElement>(".es-sb")!;
    aside.getBoundingClientRect = () => ({ height: 800, width: 272, top: 0, left: 0, right: 272, bottom: 800, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const split = host!.querySelector<HTMLElement>('[role="separator"]')!;
    expect(split.getAttribute("aria-orientation")).toBe("horizontal");
    act(() => {
      split.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(onHeight).toHaveBeenLastCalledWith(324);
    act(() => {
      split.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(onHeight).toHaveBeenLastCalledWith(300);
  });

  it("does not drag on a narrow screen and draws nothing for a host without list and remove", async () => {
    const { images } = stubImages();
    await mount({ pageId: PAGE, images, srcOf, body: stubBody(), startOpen: true, narrow: true });
    expect(tiles()[0]!.getAttribute("draggable")).toBe("false");
    expect(host!.textContent).toContain("押して「本文に入れる」");
    act(() => root!.unmount());
    host!.remove();
    await mount({ pageId: PAGE, images: { upload: images.upload, saveMeta: images.saveMeta }, srcOf, body: stubBody(), startOpen: true });
    expect(host!.querySelector(".es-ph")).toBeNull();
  });
  it("has no serious accessibility problems closed, open with tiles, and with the dialog open", async () => {
    const { images } = stubImages();
    await mount({ pageId: PAGE, images, srcOf, body: stubBody(new Map([[ids[0]!, 1]])) });
    const serious = async () =>
      (await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } })).violations.filter((entry) => entry.impact === "serious" || entry.impact === "critical");
    expect(await serious()).toEqual([]);
    await click(fold());
    expect(await serious()).toEqual([]);
    await click(tiles()[0]!);
    expect(await serious()).toEqual([]);
  });
  it("as the 写真 panel (#311): the head is ShellPanelHead (grip, 写真, ＋, ×), no fold or separator, fills the panel, and reads only while open", async () => {
    const { images } = stubImages();
    const onClose = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const render = (open: boolean) =>
      act(async () =>
        root!.render(
          <div data-docs-app-root="" data-docs-shared-ui="">
            <div className="es-root">
              <PagePhotos pageId={PAGE} images={images} srcOf={srcOf} body={stubBody()} panel={{ onClose, drag: true }} open={open} />
            </div>
          </div>,
        ),
      );
    await render(false);
    await flush();
    // 閉じている間は読まない
    expect(images.list).not.toHaveBeenCalled();
    expect(host.querySelector(".es-ph-body")).toBeNull();
    await render(true);
    await flush();
    expect(images.list).toHaveBeenCalledTimes(1);
    const section = host.querySelector<HTMLElement>("section.es-ph")!;
    expect(section.className).toBe("es-ph es-ph--panel");
    expect(section.getAttribute("style")).toBeNull();
    expect(section.getAttribute("aria-label")).toBe(PAGE_PHOTOS_LABEL);
    const head = section.querySelector<HTMLElement>(".es-pn-hd")!;
    expect(head.getAttribute("draggable")).toBe("true");
    expect(head.querySelector(".es-grip")).not.toBeNull();
    expect(head.querySelector("h2.es-pn-tt")?.textContent).toBe("写真");
    expect([...head.querySelectorAll("button")].map((item) => item.getAttribute("aria-label"))).toEqual([PAGE_PHOTOS_ADD_TEXT, "写真を閉じる"]);
    expect(host.querySelector(".es-ph-fold")).toBeNull();
    expect(host.querySelector(".es-ph-split")).toBeNull();
    expect(tiles().length).toBeGreaterThan(0);
    await click(button("写真を閉じる"));
    expect(onClose).toHaveBeenCalledTimes(1);
    const serious = (await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } })).violations.filter((entry) => entry.impact === "serious" || entry.impact === "critical");
    expect(serious).toEqual([]);
  });
  it("reads the list again when a photo it does not know shows up in the body (the body's image button, paste or drop)", async () => {
    const { images } = stubImages();
    const uses = new Map<string, number>();
    let changed: (() => void) | null = null;
    const body = { ...stubBody(uses), subscribe: (onChange: () => void) => ((changed = onChange), () => undefined) };
    await mount({ pageId: PAGE, images, srcOf, body, startOpen: true });
    expect(images.list).toHaveBeenCalledTimes(1);
    uses.set(ids[1]!, 1);
    await act(async () => changed!());
    await flush();
    expect(images.list).toHaveBeenCalledTimes(1);
    uses.set(ids[9]!, 1);
    await act(async () => changed!());
    await flush();
    expect(images.list).toHaveBeenCalledTimes(2);
    // 同じ「知らない写真」では何度も読み直さない（消した資産を指したままの本文など）
    await act(async () => changed!());
    await flush();
    expect(images.list).toHaveBeenCalledTimes(2);
  });
});
