import { describe, expect, it } from "vitest";
import type { PageSummary } from "@niho/editor-store";
import type { SearchHit } from "./search-client";
import { arrangeSidebarItems, folderOptions, formatWhen, searchRows, withoutPageTree } from "./sidebar-items";

/** 2026-10-31 12:00（東京）＝ 03:00 UTC。 */
const NOW = Date.parse("2026-10-31T03:00:00.000Z");

function page(id: string, over: Partial<PageSummary> = {}): PageSummary {
  return { id, kind: "note", title: id, lang: "ja", parent: null, stepStatus: null, sortOrder: 0, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-31T02:00:00.000Z", publication: null, ...over };
}

describe("formatWhen", () => {
  const at = (iso: string) => formatWhen(iso, NOW);

  it("counts minutes and hours within the same Tokyo day", () => {
    expect(at("2026-10-31T03:00:00.000Z")).toBe("たった今");
    expect(at("2026-10-31T02:59:01.000Z")).toBe("たった今");
    expect(at("2026-10-31T03:05:00.000Z")).toBe("たった今");
    expect(at("2026-10-31T02:59:00.000Z")).toBe("1分前");
    expect(at("2026-10-31T02:00:01.000Z")).toBe("59分前");
    expect(at("2026-10-31T02:00:00.000Z")).toBe("1時間前");
    // 東京の 0:00（＝前の日の 15:00 UTC）はまだ同じ日
    expect(at("2026-10-30T15:00:00.000Z")).toBe("12時間前");
  });

  it("uses Tokyo calendar days for 昨日 and N日前, not 24-hour periods", () => {
    expect(at("2026-10-30T14:59:59.000Z")).toBe("昨日");
    expect(at("2026-10-29T15:00:00.000Z")).toBe("昨日");
    expect(at("2026-10-29T14:59:59.000Z")).toBe("2日前");
    expect(at("2026-10-24T15:00:00.000Z")).toBe("6日前");
    expect(at("2026-10-24T14:59:59.000Z")).toBe("10月24日");
  });

  it("shows the month and day in the same Tokyo year and adds the year before that", () => {
    expect(at("2026-01-01T00:00:00.000Z")).toBe("1月1日");
    // 2025-12-31 15:00 UTC は東京では 2026-01-01
    expect(at("2025-12-31T15:00:00.000Z")).toBe("1月1日");
    expect(at("2025-12-31T14:59:59.000Z")).toBe("2025年12月31日");
    expect(at("2019-05-03T00:00:00.000Z")).toBe("2019年5月3日");
    expect(at("not a date")).toBe("");
  });

  it("is a pure function of now (the first browser render matches the server)", () => {
    const iso = "2026-10-31T01:00:00.000Z";
    expect(formatWhen(iso, NOW)).toBe(formatWhen(iso, NOW));
    expect(formatWhen(iso, NOW + 60 * 60 * 1000)).toBe("3時間前");
  });
});

describe("arrangeSidebarItems", () => {
  it("keeps update order at the top level and puts each loaded child under its own parent, in creation order", () => {
    const pages = [
      page("step-2", { parent: "rec", kind: "step", createdAt: "2026-10-02T00:00:00.000Z", stepStatus: "run" }),
      page("note"),
      page("rec", { kind: "rec" }),
      page("step-3", { parent: "step-2", kind: "step", createdAt: "2026-10-03T00:00:00.000Z" }),
      page("step-1", { parent: "rec", kind: "step", createdAt: "2026-10-01T00:00:00.000Z", stepStatus: "done" }),
      page("orphan", { parent: "not-loaded", kind: "step" }),
    ];
    const items = arrangeSidebarItems(pages, { now: NOW });
    // 段は フォルダ（0）› ページ（1）› 録音のサブページ（2）。親を読み込んでいない行（orphan）は上の段に出す
    expect(items.map((item) => [item.id, item.depth ?? 0])).toEqual([
      ["note", 0],
      ["rec", 0],
      ["step-1", 1],
      ["step-2", 1],
      ["step-3", 2],
      ["orphan", 0],
    ]);
    // 子を持つ行はフォルダ（開閉のボタンが付く）。既定は開いている
    expect(items.filter((item) => item.folder).map((item) => [item.id, item.open])).toEqual([
      ["rec", true],
      ["step-2", true],
    ]);
  });

  it("hides the rows inside a closed folder and says that it is closed", () => {
    const pages = [page("folder"), page("inside", { parent: "folder" }), page("deeper", { parent: "inside" }), page("other")];
    const closed = arrangeSidebarItems(pages, { now: NOW, collapsed: new Set(["folder"]) });
    expect(closed.map((item) => item.id)).toEqual(["folder", "other"]);
    expect(closed[0]).toMatchObject({ folder: true, open: false });
    // 中の段だけを閉じる
    const half = arrangeSidebarItems(pages, { now: NOW, collapsed: new Set(["inside"]) });
    expect(half.map((item) => [item.id, item.depth ?? 0])).toEqual([
      ["folder", 0],
      ["inside", 1],
      ["other", 0],
    ]);
  });

  it("never shows a fourth 段: a page under a 録音のサブページ is left out of the tree", () => {
    const pages = [page("folder"), page("inside", { parent: "folder" }), page("sub", { parent: "inside" }), page("too-deep", { parent: "sub" })];
    const items = arrangeSidebarItems(pages, { now: NOW });
    expect(items.map((item) => [item.id, item.depth ?? 0])).toEqual([
      ["folder", 0],
      ["inside", 1],
      ["sub", 2],
    ]);
    expect(items.find((item) => item.id === "sub")?.folder).toBeUndefined();
  });

  it("shows the second line only for recordings and steps that are not done", () => {
    const items = arrangeSidebarItems(
      [page("rec", { kind: "rec" }), page("run", { stepStatus: "run" }), page("done", { stepStatus: "done" }), page("plain", { title: "" })],
      { now: NOW },
    );
    expect(items.map((item) => item.sub)).toEqual([{ text: "録音" }, { text: "作成中…" }, undefined, undefined]);
    expect(items[3]).toEqual({ id: "plain", title: "", when: "1時間前" });
  });

  it("手順の段階の状態を 2 行目に出し、作成中の行には回るマークを付ける（#37）", () => {
    const items = arrangeSidebarItems(
      [
        page("run", { kind: "step", stepStatus: "run" }),
        page("wait", { kind: "step", stepStatus: "wait" }),
        page("failed", { kind: "step", stepStatus: "failed" }),
        page("stale", { kind: "step", stepStatus: "stale" }),
        page("done", { kind: "step", stepStatus: "done" }),
      ],
      { now: NOW },
    );
    // 状態は文字でも出す（印だけで表さない）
    expect(items.map((item) => [item.id, item.sub?.text, item.busy ?? false])).toEqual([
      ["run", "作成中…", true],
      ["wait", "待機", false],
      ["failed", "失敗", false],
      ["stale", "前提変更", false],
      ["done", undefined, false],
    ]);
  });

  it("公開中のサブページでも、作っている間は回るマークを出す（#37）", () => {
    const items = arrangeSidebarItems(
      [page("article", { kind: "step", stepStatus: "run", publication: { dest: "niho", handle: "takuya", range: "live", stopped: false } })],
      { now: NOW },
    );
    expect(items[0]).toMatchObject({ busy: true, sub: { text: "NIHO", dest: "niho" } });
  });

  it("never drops rows whose parents form a cycle", () => {
    const items = arrangeSidebarItems([page("a", { parent: "b" }), page("b", { parent: "a" })], { now: NOW });
    expect(items.map((item) => [item.id, item.depth ?? 0])).toEqual([
      ["a", 0],
      ["b", 0],
    ]);
  });

  it("shows search hits flat, in the server's order, with the matched sentence as the second line", () => {
    const hits: SearchHit[] = [
      { id: "b", kind: "note", title: "鎌倉の朝", snippet: "…江ノ電の音で目が覚めた…", updatedAt: "2026-10-31T02:30:00.000Z" },
      { id: "a", kind: "rec", title: "", snippet: "  ", updatedAt: "2026-10-30T02:00:00.000Z" },
    ];
    expect(searchRows(hits, NOW)).toEqual([
      { id: "b", title: "鎌倉の朝", when: "30分前", sub: { text: "…江ノ電の音で目が覚めた…" } },
      { id: "a", title: "", when: "昨日" },
    ]);
  });
});

describe("arrangeSidebarItems: 2 行目の公開先（#39）", () => {
  const live = { dest: "exp", handle: "exp", range: "live", stopped: false } as const;

  it("公開中は発信先の名前と印。限定公開も同じ。本人のサイトは「自分のサイト」", () => {
    const rows = arrangeSidebarItems(
      [
        { ...page("a"), publication: live },
        { ...page("b"), publication: { dest: "niho", handle: "niho", range: "unlisted", stopped: false } },
        { ...page("c"), publication: { dest: "site", handle: "field-notes", range: "live", stopped: false } },
      ],
      { now: NOW },
    );
    expect(rows.map((row) => row.sub)).toEqual([
      { text: "NIHO Experience", dest: "exp" },
      { text: "NIHO", dest: "niho" },
      { text: "自分のサイト", dest: "site" },
    ]);
  });

  it("公開をやめたページは「公開をやめた」（印なし）。公開の無いページは今までどおり", () => {
    const rows = arrangeSidebarItems(
      [{ ...page("a"), publication: { ...live, stopped: true } }, { ...page("b", { kind: "rec" }), publication: null }, page("c")],
      { now: NOW },
    );
    expect(rows.map((row) => row.sub)).toEqual([{ text: "公開をやめた" }, { text: "録音" }, undefined]);
  });

  it("公開中は録音・作成中より先に出す（モック v6 の順）", () => {
    const rec = { ...page("rec", { kind: "rec", title: "鎌倉の録音" }), publication: live };
    expect(arrangeSidebarItems([rec], { now: NOW })[0]!.sub).toEqual({ text: "NIHO Experience", dest: "exp" });
  });
});

describe("withoutPageTree", () => {
  it("drops the deleted page and every loaded descendant (in any order), and keeps the rest in order", () => {
    // 更新順なので、孫が親より先に来ることもある
    const pages = [page("g", { parent: "c" }), page("a"), page("c", { parent: "p" }), page("p"), page("o", { parent: "a" }), page("c2", { parent: "p" })];
    expect(withoutPageTree(pages, "p").map((item) => item.id)).toEqual(["a", "o"]);
    expect(withoutPageTree(pages, "c").map((item) => item.id)).toEqual(["a", "p", "o", "c2"]);
    expect(withoutPageTree(pages, "missing")).toEqual(pages);
  });

  it("stops on a parent cycle", () => {
    const pages = [page("x", { parent: "y" }), page("y", { parent: "x" }), page("z")];
    expect(withoutPageTree(pages, "x").map((item) => item.id)).toEqual(["z"]);
  });
});

describe("folderOptions", () => {
  it("offers the top-level pages, without the page itself or anything inside it", () => {
    const pages = [page("folder-a"), page("folder-b"), page("inside", { parent: "folder-a" }), page("note")];
    expect(folderOptions(pages, "note").map((option) => option.id)).toEqual(["folder-a", "folder-b", "note"].filter((id) => id !== "note"));
    expect(folderOptions(pages, "inside").map((option) => option.id)).toEqual(["folder-a", "folder-b", "note"]);
    // 自分自身と自分の中のページは入れ先に出さない
    expect(folderOptions(pages, "folder-a").map((option) => option.id)).toEqual(["folder-b", "note"]);
  });

  it("offers nothing for a page that already has 2 段 under it (the move would be refused)", () => {
    const pages = [page("folder"), page("deep"), page("inside", { parent: "deep" }), page("sub", { parent: "inside" })];
    expect(folderOptions(pages, "deep")).toEqual([]);
    // 1 段だけなら入れられる
    expect(folderOptions(pages, "inside").map((option) => option.id)).toEqual(["folder", "deep"]);
  });

  it("keeps the title as it is (the empty one is written 無題 by the shell)", () => {
    expect(folderOptions([page("a", { title: "" }), page("b")], "b")).toEqual([{ id: "a", title: "" }]);
  });
});
