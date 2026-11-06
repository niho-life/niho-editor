// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellHeader } from "./header";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
function mount(node: React.ReactNode): HTMLDivElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe("ShellHeader の「‹ 行き先」（狭い画面の戻る。#320 A1）", () => {
  it("左端に行き先の名前を出し、押すと onClick。「一覧を出す」は同時には出ない", () => {
    const onClick = vi.fn();
    const top = mount(<ShellHeader back={{ label: "2026年11月の日記", onClick }} showListButton onToggleList={() => undefined} />);
    const button = top.querySelector<HTMLButtonElement>('header.es-dt > button.es-back')!;
    expect(button.getAttribute("aria-label")).toBe("2026年11月の日記へ戻る");
    expect(button.textContent).toBe("2026年11月の日記");
    expect(top.querySelector('button[aria-label="一覧を出す"]')).toBeNull();
    act(() => button.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("back が無ければ今までどおり「一覧を出す」", () => {
    const top = mount(<ShellHeader showListButton onToggleList={() => undefined} />);
    expect(top.querySelector(".es-back")).toBeNull();
    expect(top.querySelector('button[aria-label="一覧を出す"]')).not.toBeNull();
  });
});
