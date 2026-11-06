// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fitTitleHeight } from "./BlockEditor";

/** ResizeObserver の偽物（callback を手で呼ぶ）。 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(public callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.observed.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

/** jsdom は寸法を持たないので、scrollHeight と clientWidth を差し替えられる textarea を作る。 */
function makeTextarea(): HTMLTextAreaElement & { set: (size: { scrollHeight: number; clientWidth: number }) => void } {
  const element = document.createElement("textarea");
  let size = { scrollHeight: 41, clientWidth: 700 };
  Object.defineProperty(element, "scrollHeight", { get: () => size.scrollHeight });
  Object.defineProperty(element, "clientWidth", { get: () => size.clientWidth });
  document.body.appendChild(element);
  return Object.assign(element, { set: (next: { scrollHeight: number; clientWidth: number }) => void (size = next) });
}

describe("fitTitleHeight（題名の textarea を書いた分だけの高さにする）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeResizeObserver.instances = [];
    document.body.innerHTML = "";
  });

  it("最初に測り、欄の幅が変わったら測り直す（幅が同じなら触らない）。やめると見張りも外す", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const element = makeTextarea();
    const stop = fitTitleHeight(element);
    expect(element.style.height).toBe("41px");
    const observer = FakeResizeObserver.instances[0]!;
    expect(observer.observed).toEqual([element]);

    // 列が狭くなって 3 行に折り返した（レールを開いた・画面を回した）
    element.set({ scrollHeight: 122, clientWidth: 400 });
    observer.fire();
    expect(element.style.height).toBe("122px");

    // 幅が変わらない通知（自分の高さの変更など）では測り直さない
    element.set({ scrollHeight: 999, clientWidth: 400 });
    observer.fire();
    expect(element.style.height).toBe("122px");

    stop();
    expect(observer.disconnected).toBe(true);
  });

  it("ResizeObserver が無い環境では最初の 1 回だけ測る", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const element = makeTextarea();
    const stop = fitTitleHeight(element);
    expect(element.style.height).toBe("41px");
    expect(() => stop()).not.toThrow();
  });
});
