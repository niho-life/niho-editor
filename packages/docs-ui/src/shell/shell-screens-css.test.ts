import { readFileSync } from "node:fs";
import postcss, { type AtRule, type Declaration, type Node, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

/* フェーズ2（公開のシート・ログイン・公開プレビュー・設定系ページ）の shell.css の決まり。生 hex・先頭付き・緑の hex の検査は shell-css.test.ts が全体に対して行う。 */
const css = readFileSync(new URL("../styles/shell.css", import.meta.url), "utf8");
const root = postcss.parse(css);
const PREFIX = ":where([data-docs-app-root]):where([data-docs-shared-ui]) ";

const rules: Rule[] = [];
root.walkRules((rule) => {
  for (let parent: Node | undefined = rule.parent; parent; parent = parent.parent) {
    if (parent.type === "atrule" && (parent as AtRule).name.endsWith("keyframes")) return;
  }
  rules.push(rule);
});
const decls = (rule: Rule | undefined) => rule?.nodes.filter((node): node is Declaration => node.type === "decl").map((node) => `${node.prop}:${node.value}`).join(";") ?? "";
const full = (selector: string) => (selector.startsWith(".es-root") ? selector : `.es-root ${selector}`);
/** 全幅（@media の外）のルールの宣言。 */
const bodyOf = (selector: string) =>
  decls(rules.find((rule) => rule.parent?.type === "root" && rule.selectors.includes(`${PREFIX}${full(selector)}`)));
const mobile = root.nodes.find((node): node is AtRule => node.type === "atrule" && node.name === "media" && node.params === "(max-width:900px)")!;
const mobileOf = (selector: string) => decls(mobile.nodes?.find((node): node is Rule => node.type === "rule" && node.selectors.includes(`${PREFIX}${full(selector)}`)));

describe("shell.css（フェーズ2）", () => {
  it("文字は 12px 以上（モックの 11px・11.5px は 12px にしてある）", () => {
    const sizes: { selector: string; value: string }[] = [];
    for (const rule of rules) {
      for (const node of rule.nodes) {
        if (node.type !== "decl") continue;
        if (node.prop === "font-size") sizes.push({ selector: rule.selector, value: node.value });
        // font: 12px var(--ed-font-mono) の形
        if (node.prop === "font") {
          const match = /^(?:\d+\s+)?([\d.]+)px/.exec(node.value);
          if (match) sizes.push({ selector: rule.selector, value: `${match[1]}px` });
        }
      }
    }
    expect(sizes.length).toBeGreaterThan(100);
    for (const { selector, value } of sizes) {
      const px = /^([\d.]+)px$/.exec(value);
      if (px) expect(Number(px[1]), `${selector} { font-size: ${value} }`).toBeGreaterThanOrEqual(12);
    }
  });

  it("切り替え（公開プレビューの発信先）は沈めたトラック ＋ 白いピル。緑を使わない", () => {
    const track = bodyOf(".es-track");
    expect(track).toContain("background:var(--ed-track)");
    const button = bodyOf(".es-track button");
    expect(button).toContain("color:var(--ed-track-ink)");
    const on = bodyOf('.es-track button[aria-pressed="true"]');
    expect(on).toContain("background:var(--ed-white)");
    expect(on).toContain("color:var(--ed-ink)");
    for (const body of [track, button, on]) expect(body).not.toMatch(/--ed-(accent|primary|deep|leaf)/);
  });

  it("選んだ発信先・選択チップは淡色面 ＋ 緑の文字（面を緑の文字色で塗らない）。スイッチ・チェックは主ボタンの面と文字のセット", () => {
    expect(bodyOf(".es-dst--on")).toContain("background:var(--ed-accent-soft)");
    expect(bodyOf(".es-pill--exp")).toContain("background:var(--ed-accent-soft)");
    expect(bodyOf(".es-pill--exp")).toContain("color:var(--ed-accent-ink)");
    expect(bodyOf(".es-donebox-mk")).toContain("color:var(--ed-accent-ink)");
    for (const selector of [".es-toggle--on", ".es-chk--on i"]) {
      const body = bodyOf(selector);
      expect(body, selector).toContain("background:var(--ed-primary-bg)");
      expect(body, selector).toContain("color:var(--ed-primary-ink)");
      expect(body, selector).not.toContain("--ed-accent-ink");
    }
  });

  it("公開のシート: 幕は .es-root の中の absolute（.es-root は position:relative）。デスクトップは中央、900px 未満は下から", () => {
    const veil = bodyOf(".es-veil");
    expect(veil).toContain("position:absolute");
    expect(veil).toContain("inset:0");
    expect(veil).toContain("place-items:center");
    expect(bodyOf(".es-root")).toContain("position:relative");
    expect(bodyOf(".es-sheet")).toContain("width:min(100%,520px)");
    expect(bodyOf(".es-sheet")).toContain("max-height:100%");
    expect(mobileOf(".es-veil")).toContain("align-items:end");
    expect(mobileOf(".es-veil")).toContain("padding:0");
    expect(mobileOf(".es-sheet")).toContain("width:100%");
    expect(mobileOf(".es-sheet")).toContain("border-radius:22px 22px 0 0");
    // メニュー（30）・一覧（45）・レール（46）より上
    expect(Number(/z-index:(\d+)/.exec(veil)?.[1])).toBeGreaterThan(46);
  });

  it("モックバーのずらし（42px）は持たない。幕・ログイン・プレビュー・設定は fixed / 100vh / 100vw でなく、高さと幅は枠に従う", () => {
    const own = rules.filter((rule) => rule.selectors.some((s) => /\.es-(veil|sheet|sh-|pv|split|page|art|secnav|sect|dst|dcard|kvs|tbl)\b/.test(s)));
    expect(own.length).toBeGreaterThan(40);
    for (const rule of own) {
      const body = decls(rule);
      expect(body, rule.selector).not.toMatch(/\b42px\b|100vh|100vw|100dvh|position:fixed/);
    }
  });

  it("スマホ（900px 未満）: 表は 1 行 1 枚のカード（display:block）、見出しの行は画面から外す。設定の kvs は 1 列", () => {
    expect(mobileOf(".es-tbl tr")).toContain("display:block");
    expect(mobile.nodes?.some((node) => node.type === "rule" && node.selectors.some((s) => s.endsWith(".es-tbl,") || s.endsWith(".es-tbl")))).toBe(true);
    expect(mobileOf(".es-tbl thead")).toContain("clip-path:inset(50%)");
    expect(mobileOf(".es-tbl td[data-label]::before")).toContain("content:attr(data-label)");
    expect(mobileOf(".es-kvs")).toContain("grid-template-columns:minmax(0,1fr)");
    expect(mobileOf(".es-split")).toContain("grid-template-columns:minmax(0,1fr)");
    expect(mobileOf(".es-dst")).toContain("grid-template-columns:32px minmax(0,1fr)");
  });

  it("設定の行（2026-11-05）: 600px 以下で値を名前の下へ折り返し、› は右に残す。集中編集のシートは右に全高、900px 未満は全面", () => {
    const narrow = root.nodes.find((node): node is AtRule => node.type === "atrule" && node.name === "media" && node.params === "(max-width:600px)")!;
    const narrowOf = (selector: string) => decls(narrow.nodes?.find((node): node is Rule => node.type === "rule" && node.selectors.includes(`${PREFIX}${full(selector)}`)));
    expect(bodyOf(".es-row")).toContain("grid-template-columns:150px minmax(0,1fr) auto");
    expect(narrowOf(".es-row")).toContain("grid-template-columns:minmax(0,1fr) auto");
    expect(narrowOf(".es-row-v")).toContain("grid-column:1");
    expect(narrowOf(".es-row-e")).toContain("grid-column:2");
    expect(bodyOf(".es-veil.es-veil--edit")).toContain("justify-items:end");
    expect(bodyOf(".es-sheet.es-sheet--edit")).toContain("width:min(100%,640px)");
    expect(bodyOf(".es-sheet.es-sheet--edit")).toContain("height:100%");
    expect(mobileOf(".es-sheet.es-sheet--edit")).toContain("width:100%");
    expect(mobileOf(".es-sheet.es-sheet--edit")).toContain("border-radius:0");
  });

  it("(max-width:900px) の @media はひとつだけ（フェーズ1の枠と同じ区切り）", () => {
    const blocks = root.nodes.filter((node): node is AtRule => node.type === "atrule" && node.name === "media" && node.params === "(max-width:900px)");
    expect(blocks).toHaveLength(1);
  });

  it("ログインと公開プレビューは枠の外の単独の画面（.es-root.es-root--scroll）。縦に流れ、中でスクロールする", () => {
    const body = bodyOf(".es-root.es-root--scroll");
    expect(body).toContain("overflow:auto");
    expect(body).toContain("flex-direction:column");
    expect(bodyOf(".es-pvbar")).toContain("position:sticky");
    // 狭い幅で折り返す（320px で横にはみ出さない）
    expect(bodyOf(".es-pvbar")).toContain("flex-wrap:wrap");
    expect(bodyOf(".es-pv-hd")).toContain("flex-wrap:wrap");
  });

  it("見直し 2026-11-07: ヘッダーと本文の間に余白、スマホの「…」はレールより上、読む文字は token から", () => {
    // 本文の列の上の余白（題名がヘッダーに貼り付かない）。設定・録音から も同じ余白を使う（.es-page・.es-start は自前の上の余白を持たない）
    expect(bodyOf(".es-canvas")).toContain("padding:32px 48px 120px");
    expect(mobileOf(".es-canvas")).toContain("padding:24px 18px 80px");
    expect(bodyOf(".es-page")).toContain("padding:0");
    expect(bodyOf(".es-start")).toContain("margin:0 auto");
    // 900px 未満: ヘッダー（メニューの親）はレール（46）より上、幕（60）より下
    const header = Number(/z-index:(\d+)/.exec(mobileOf(".es-dt"))?.[1]);
    expect(header).toBeGreaterThan(46);
    expect(header).toBeLessThan(60);
    // iOS の自動拡大を避ける 16px の入力欄
    expect(mobileOf(".es-ai-composer textarea")).toContain("font-size:16px");
    expect(mobileOf(".es-sb-find input")).toContain("font-size:16px");
    // アプリ名と一覧の行の題名は token（fallback 付き）
    expect(bodyOf(".es-brand")).toContain("font-size:var(--ed-fs-brand,17px)");
    expect(bodyOf(".es-di-t")).toContain("font-size:var(--ed-fs-list,15px)");
    // 本文の列（.es-canvas-in）とタブの帯（#315）は同じ幅（680px・中央）
    expect(bodyOf(".es-canvas-in")).toContain("max-width:680px");
    expect(bodyOf(".es-tabbar")).toContain("max-width:680px");
    expect(bodyOf(".es-tabbar")).toContain("margin:0 auto 10px");
  });

  it("書体は token。発信先ごとの見え方（serif・sans）も --ed-font-* から引く", () => {
    const rule = rules.find((item) => item.selectors.includes(`${PREFIX}.es-root .es-pv--site`));
    expect(decls(rule)).toContain("font-family:var(--ed-font-serif)");
    expect(css).not.toMatch(/Georgia|Hiragino|Nunito|Fraunces/);
  });
});
