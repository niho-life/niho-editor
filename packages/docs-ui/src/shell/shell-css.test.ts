import { readFileSync } from "node:fs";
import postcss, { type AtRule, type Declaration, type Node, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../styles/shell.css", import.meta.url), "utf8");
const root = postcss.parse(css);
const PREFIX = ":where([data-docs-app-root]):where([data-docs-shared-ui]) ";

const inKeyframes = (rule: Rule): boolean => {
  for (let parent: Node | undefined = rule.parent; parent; parent = parent.parent) {
    if (parent.type === "atrule" && (parent as AtRule).name.endsWith("keyframes")) return true;
  }
  return false;
};
const rules: Rule[] = [];
root.walkRules((rule) => {
  if (!inKeyframes(rule)) rules.push(rule);
});
const selectors = rules.flatMap((rule) => rule.selectors);
/** `.es-root` の下のセレクタ（例: ".es-dt"）の宣言を "prop:value;…" にして返す。 */
const bodyOf = (selector: string) => {
  const full = selector.startsWith(".es-root") ? selector : `.es-root ${selector}`;
  const rule = rules.find((item) => item.selectors.includes(`${PREFIX}${full}`));
  return rule ? rule.nodes.filter((node): node is Declaration => node.type === "decl").map((node) => `${node.prop}:${node.value}`).join(";") : undefined;
};

describe("shell.css（モック v6 の枠のスタイル）", () => {
  it("緑の生 hex を書かない（緑は --ed-* の token から引く）", () => {
    const greens = ["#7dba3a", "#63a109", "#b2d67c", "#eef6e1", "#56751e", "#74b033", "#5c9508", "#4b9e5e", "#46811f"];
    const text = css.toLowerCase();
    for (const green of greens) expect(text, green).not.toContain(green);
  });

  it("生 hex を書かない。色は token か rgba()（影）", () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const hexes = [...stripped.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
    expect(hexes).toEqual([]);
    expect(stripped).not.toMatch(/\b(?:rgb|hsl)a?\((?!\s*(?:0|28|255)\s*,)/);
  });

  it("初期化（ul・ol の list-style、a の下線、見出し・p の margin）は、本文（.ProseMirror の中）に効かせない", () => {
    // EditorShell は本文のエディタごと .es-root に入れるので、枠の初期化が本文の箇条書きの印・リンクの下線を消してしまう（#70 の枠で確認）
    const resets = css.split("\n").filter((line) => /\.es-root (?:ul|ol|a)(?::where\(:not\(\.ProseMirror \*\)\))?[,{]/.test(line) && /list-style:none|text-decoration:none|\{margin:0\}/.test(line));
    expect(resets.length).toBeGreaterThanOrEqual(3);
    for (const rule of resets) {
      for (const selector of rule.split("{")[0]!.split(/,(?=:where)/)) {
        if (/\.es-root (?:h1|h2|h3|h4|p|dl|dd|ul|ol|a)\b/.test(selector)) expect(selector, selector.slice(-60)).toContain(":where(:not(.ProseMirror *))");
      }
    }
  });

  it("全セレクタが共通 UI の root の中の .es-root 配下（@media の中も）。裸の * html body :root は無い", () => {
    expect(selectors.length).toBeGreaterThan(200);
    for (const selector of selectors) {
      expect(selector.startsWith(`${PREFIX}.es-root`), selector).toBe(true);
      expect(selector, selector).not.toMatch(/(^|[\s>+~,(])(html|body)\b|:root/);
    }
    // @media の中にもあり、すべて同じ形
    const media = rules.filter((rule) => rule.parent?.type === "atrule" && (rule.parent as AtRule).name === "media");
    expect(media.length).toBeGreaterThan(10);
  });

  it("クラスはすべて es- 接頭辞、@keyframes も es-、@import・@font-face・url() は持たない", () => {
    for (const selector of selectors) {
      // 本文（TipTap の .ProseMirror）は初期化の対象から外すために `:not(.ProseMirror *)` で参照するだけ（スタイルは当てない）
      for (const match of selector.replaceAll(":not(.ProseMirror *)", "").matchAll(/\.([A-Za-z_][\w-]*)/g)) expect(match[1], selector).toMatch(/^es-/);
    }
    const names: string[] = [];
    root.walkAtRules((rule) => {
      if (rule.name.endsWith("keyframes")) names.push(rule.params);
      expect(["import", "font-face", "charset"]).not.toContain(rule.name);
    });
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^es-/);
    expect(css).not.toMatch(/url\(/);
  });

  it("書体は token（--ed-font-sans / --ed-font-serif）から引き、写真変数を持たない", () => {
    const fonts = [...css.matchAll(/font-family:([^;}]+)/g)].map((m) => m[1]!.trim());
    for (const font of fonts) expect(font, font).toMatch(/^var\(--ed-font-(sans|serif)\)$/);
    expect(css).toContain("var(--ed-font-serif)");
    expect(css).not.toContain("--i-");
  });

  it("主ボタンは面と文字をセット（--ed-primary-bg に --ed-primary-ink）。hover は面だけ", () => {
    const primaries = rules.filter((rule) => rule.nodes.some((node) => node.type === "decl" && /var\(--ed-primary-bg\)/.test((node as Declaration).value) && /^background/.test((node as Declaration).prop)));
    expect(primaries.length).toBeGreaterThan(3);
    for (const rule of primaries) {
      if (rule.selector.includes(":hover")) continue;
      const decls = rule.nodes.filter((node): node is Declaration => node.type === "decl");
      expect(decls.some((d) => d.prop === "color" && d.value === "var(--ed-primary-ink)"), rule.selector).toBe(true);
    }
    // 黒ベタの主ボタンは禁止
    expect(css).not.toMatch(/background:\s*var\(--ed-ink(-sub)?\)/);
  });

  it("--ed-accent-ink は文字・縁・小さな印だけに使い、面（ボタンやチップの背景）には使わない", () => {
    for (const rule of rules) {
      for (const node of rule.nodes) {
        if (node.type !== "decl" || !/^background/.test(node.prop) || !node.value.includes("--ed-accent-ink")) continue;
        const marks = rule.selectors.every((s) => / i$|::before$|::after$|\.es-tone--a$/.test(s));
        expect(marks, `${rule.selector} { ${node.prop}: ${node.value} }`).toBe(true);
      }
    }
    // 選択チップ・現在の手順・ヒントは淡色面 ＋ accent-ink の文字
    for (const selector of [".es-flow-row--cur .es-flow-go", ".es-pills button.es-on", ".es-trhint"]) {
      const body = bodyOf(selector) ?? "";
      expect(body, selector).toContain("background:var(--ed-accent-soft)");
      expect(body, selector).toContain("color:var(--ed-accent-ink)");
    }
  });

  it("ヘッダーは1段（高さ固定の flex 行で、折り返さない）", () => {
    const body = bodyOf(".es-dt") ?? "";
    expect(body).toContain("display:flex");
    expect(body).toContain("align-items:center");
    expect(body).toContain("height:var(--es-header)");
    expect(body).not.toMatch(/flex-wrap|flex-direction:\s*column/);
    expect(bodyOf(".es-root")).toContain("--es-header:48px");
  });

  it("状態の吹き出しはホバーとフォーカス（キーボード）で出る", () => {
    expect(selectors).toContain(`${PREFIX}.es-root .es-st-wrap:hover .es-st-tip`);
    expect(selectors).toContain(`${PREFIX}.es-root .es-st-wrap:focus-within .es-st-tip`);
    expect(bodyOf(".es-st-tip")).toContain("opacity:0");
    expect(bodyOf(".es-st-wrap:focus-within .es-st-tip")).toContain("opacity:1");
    expect(bodyOf(".es-st-wrap[data-dismissed=\"true\"] .es-st-tip")).toContain("opacity:0");
  });

  it("右レール: 横罫線で区切り、AI は最低 220px で残りの高さを使い、節は中でスクロールする", () => {
    const fill = bodyOf(".es-cd--fill") ?? "";
    expect(fill).toContain("min-height:220px");
    expect(fill).toContain("flex:1 1 0");
    expect(bodyOf(".es-cd")).toMatch(/border-top:1px solid var\(--ed-line\)/);
    expect(bodyOf(".es-cd")).toContain("flex:0 1 auto");
    expect(bodyOf(".es-cb")).toContain("overflow:auto");
    expect(bodyOf(".es-rail")).toContain("overflow:hidden");
    expect(bodyOf(".es-rail")).toContain("flex-direction:column");
    expect(bodyOf(".es-rail-presence")).toBe("display:contents");
  });

  it("AI 入力欄はレールの面を透過して使い、320px で縮められ、縦方向だけ手動リサイズできる", () => {
    const composer = bodyOf(".es-ai-composer") ?? "";
    const textarea = bodyOf(".es-ai-composer textarea") ?? "";
    expect(composer).toContain("min-width:0");
    expect(composer).not.toContain("background:");
    expect(textarea).toContain("width:100%");
    expect(textarea).toContain("min-width:0");
    expect(textarea).toContain("resize:vertical");
    expect(textarea).toContain("background:transparent");
  });

  it("--ed-ink-faint は文字に使わない（装飾の矢印 ▾ と「＋」のアイコンだけ。非テキストの 3:1。#43）", () => {
    const users = rules.filter((rule) => rule.nodes.some((node) => node.type === "decl" && node.value.includes("--ed-ink-faint")));
    expect(users.length).toBeGreaterThan(0);
    for (const rule of users) {
      for (const selector of rule.selectors) expect(selector, selector).toMatch(/ \.es-cv$| \.es-addrow button$/);
    }
    // プレースホルダー（data-ph の ::before）は文字なので 4.5:1 の --ed-ink-mute
    const placeholder = rules.find((rule) => rule.selectors.includes(`${PREFIX}.es-root .es-tt:empty::before`));
    expect(placeholder?.toString()).toContain("color:var(--ed-ink-mute)");
    // 入力欄のプレースホルダーも同じ色に揃える（ブラウザの既定は Safari の darkgray のように 4.5:1 に届かないものがある）
    expect(bodyOf(".es-root ::placeholder")).toBe("color:var(--ed-ink-mute);opacity:1");
  });

  it("橙の文字は --ed-amber-ink。--ed-amber（--niho-orange）は面・点だけ（#43）", () => {
    for (const rule of rules) {
      for (const node of rule.nodes) {
        if (node.type !== "decl" || !/var\(--ed-amber\)/.test(node.value)) continue;
        expect(node.prop, `${rule.selector} { ${node.prop}: ${node.value} }`).toMatch(/^background/);
      }
    }
    for (const selector of [".es-bd mark", ".es-upnote", ".es-sh-note.es-sh-left"]) expect(bodyOf(selector), selector).toContain("color:var(--ed-amber-ink)");
  });

  it("文字を opacity で薄めない（AA を割るので、薄めるのは押せない状態と飾りの面だけ。#43）", () => {
    const faded = rules.flatMap((rule) =>
      rule.nodes
        .filter((node): node is Declaration => node.type === "decl" && node.prop === "opacity" && Number(node.value) > 0 && Number(node.value) < 1)
        .map(() => rule.selectors),
    );
    expect(faded.length).toBeGreaterThan(0);
    for (const selectors of faded) for (const selector of selectors) expect(selector, selector).toMatch(/:disabled$|--off$|>i$/);
    // 済んだ提案の段落は、opacity ではなく --ed-ink-mute の文字で沈める
    expect(bodyOf(".es-blk--done")).toBe("color:var(--ed-ink-mute)");
  });

  it("本文へ移動（skip link）: フォーカスするまで切り抜いて見せず、900px 未満で一覧・レールが全画面のときは出さない", () => {
    expect(bodyOf(".es-skip")).toContain("position:absolute");
    expect(bodyOf(".es-skip:not(:focus)")).toBe("clip-path:inset(50%)");
    // 移動先の main（tabindex=-1）には枠を出さない
    expect(bodyOf(".es-canvas:focus")).toBe("outline:none");
    const media = root.nodes.find((node): node is AtRule => node.type === "atrule" && node.name === "media" && node.params === "(max-width:900px)")!;
    const hide = media.nodes?.find((node): node is Rule => node.type === "rule" && node.selectors.includes(`${PREFIX}.es-root[data-view="list"] .es-skip`));
    expect(hide?.selectors).toContain(`${PREFIX}.es-root[data-view="rail"] .es-skip`);
    expect(hide?.toString()).toContain("display:none");
  });

  it("900px 未満: 一覧とレールは全画面、道具は下端の帯、ヘッダーに題名", () => {
    const media = root.nodes.filter((node): node is AtRule => node.type === "atrule" && node.name === "media" && node.params === "(max-width:900px)");
    expect(media).toHaveLength(1);
    const inside = (selector: string) => {
      const full = selector.startsWith(".es-root") ? selector : `.es-root ${selector}`;
      const rule = media[0]!.nodes?.find((node): node is Rule => node.type === "rule" && node.selectors.includes(`${PREFIX}${full}`));
      return rule?.nodes.filter((n): n is Declaration => n.type === "decl").map((n) => `${n.prop}:${n.value}`).join(";") ?? "";
    };
    expect(inside(".es-sb")).toContain("position:absolute");
    expect(inside(".es-sb")).toContain("inset:0");
    expect(inside(".es-rail")).toContain("position:absolute");
    expect(inside(".es-mtb")).toContain("display:flex");
    expect(inside(".es-dt .es-tools")).toContain("display:none");
    expect(inside(".es-ttl")).toContain("display:block");
    expect(inside('.es-root[data-rail="open"] .es-mtb')).toContain("display:none");
    expect(bodyOf(".es-mtb")).toContain("display:none");
  });

  it("900px 未満: レールのシート（.es-sheet--rail）は背の高い下からのシートで、中のレールは全画面の位置取りをやめて残りの高さを使う（#43）", () => {
    const media = root.nodes.find((node): node is AtRule => node.type === "atrule" && node.name === "media" && node.params === "(max-width:900px)")!;
    const inside = (selector: string) => {
      const rule = media.nodes?.find((node): node is Rule => node.type === "rule" && node.selectors.includes(`${PREFIX}.es-root ${selector}`));
      return rule?.nodes.filter((n): n is Declaration => n.type === "decl").map((n) => `${n.prop}:${n.value}`).join(";") ?? "";
    };
    expect(inside(".es-sheet--rail")).toContain("height:calc(100% - 24px)");
    expect(inside(".es-sheet--rail>.es-rail")).toContain("position:static");
    expect(inside(".es-sheet--rail>.es-rail")).toContain("flex:1");
    // シートはデスクトップでは出さない（JS の matchMedia と同じ境目の中だけに書く）
    expect(selectors.filter((selector) => selector.includes("es-sheet--rail") && !media.nodes?.some((node) => node.type === "rule" && (node as Rule).selectors.includes(selector)))).toEqual([]);
  });
});

describe("文字の最小は 12px（#43）", () => {
  /** px の font-size（font の省略形も）を集める。em・% などの相対値は数えない。 */
  const pxSizes = (source: string) => {
    const sizes: { selector: string; px: number }[] = [];
    postcss.parse(source).walkDecls((decl) => {
      const value = decl.prop === "font-size" ? decl.value : decl.prop === "font" ? (/^(?:[\w-]+\s+)*?([\d.]+px)/.exec(decl.value)?.[1] ?? "") : "";
      const px = /^([\d.]+)px\b/.exec(value.trim());
      if (px) sizes.push({ selector: (decl.parent as Rule).selector, px: Number(px[1]) });
    });
    return sizes;
  };

  it("shell.css に 12px 未満の font-size の宣言が無い", () => {
    const sizes = pxSizes(css);
    expect(sizes.length).toBeGreaterThan(100);
    expect(sizes.filter((size) => size.px < 12)).toEqual([]);
  });

  it("editor.css（BlockEditor）の font-size も 12px 以上（もとの 10.5px・11px・11.5px は 12px にした）", () => {
    const editor = readFileSync(new URL("../styles/editor.css", import.meta.url), "utf8");
    const sizes = pxSizes(editor);
    expect(sizes.length).toBeGreaterThan(5);
    expect(sizes.filter((size) => size.px < 12)).toEqual([]);
    // その 3 つ（時刻の印・ブロックの一覧の小見出しと右のヒント）が 12px であること
    for (const selector of [".doc.timestamps-on p > .transcript-timestamp", ".be-slash .h", ".be-slash .hint"]) {
      expect(sizes.find((size) => size.selector.endsWith(selector))?.px, selector).toBe(12);
    }
  });
});
