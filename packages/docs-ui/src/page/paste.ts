/**
 * 貼り付けた HTML を、エディタの schema が読む前に洗う。貼り付け・ドロップのファイル（画像）もここで選ぶ。
 *
 * ProseMirror は schema に無い要素を読み捨てるので script・style の中身は本文に入らないが、読み取りの規則に頼らず、
 * 本文に持ち込めない要素・属性をここで取り除く（`<iframe>`・`<svg>`・`<form>`・`style` の宣言など）。
 * 残す属性は、リンク先（a の href。scheme の検査は schema 側）・番号の開始（ol の start）・
 * Word や Google ドキュメントが太字・斜体を表す style の `font-weight`・`font-style` だけ。
 * 見出し 1 は題名の役なので 2 に、4 以下は 3 にそろえる（schema は 2・3 だけ）。
 *
 * **外の `<img src>` は文字どおり落とす**（`DROP_WITH_CONTENT` に `img`・`picture`・`source`。本文（AST）は資産の id しか
 * 持たないので、他のサイトの画像に繋いだまま（hotlink）にはしない）。例外は、このエディタが書き出した
 * `img[data-asset-id]`（資産の id が UUID のもの。エディタの中でコピー・切り取りした画像）で、`data-asset-id`・`alt`・
 * `data-credit`・`data-consent` だけ残す（`src` などは落とす）。本文に入るのは、貼り付け・ドロップされた**ファイル**を
 * private bucket にアップロードした画像だけ（`imageFilesFrom` → image-node.ts）。
 */

/** このエディタが書き出した画像（`img[data-asset-id]`。資産の id が UUID のもの。image-node.ts の読み取りと同じ条件）。 */
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_ATTRIBUTES = new Set(["data-asset-id", "alt", "data-credit", "data-consent"]);

function isEditorImage(element: Element): boolean {
  return element.tagName.toLowerCase() === "img" && ASSET_ID.test(element.getAttribute("data-asset-id") ?? "");
}

const DROP_WITH_CONTENT = [
  "script",
  "style",
  "link",
  "meta",
  "base",
  "title",
  "head",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "svg",
  "math",
  "canvas",
  "template",
  "noscript",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "audio",
  "video",
  "img",
  "picture",
  "source",
  "track",
];

const KEPT_STYLE_PROPERTIES = new Set(["font-weight", "font-style"]);
const HEADING_LEVEL: Record<string, string> = { h1: "h2", h4: "h3", h5: "h3", h6: "h3" };

/** style 属性から、太字・斜体を表す宣言だけを残す。 */
function keptStyle(style: string): string {
  return style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      const [property = "", ...value] = declaration.split(":");
      return KEPT_STYLE_PROPERTIES.has(property.trim().toLowerCase()) && !/[{}<>\\]|url\(|expression/i.test(value.join(":"));
    })
    .join("; ");
}

function cleanAttributes(element: Element): void {
  const tag = element.tagName.toLowerCase();
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name === "data-type" && ((tag === "ul" && attribute.value === "taskList") || (tag === "li" && attribute.value === "taskItem"))) continue;
    if (name === "data-checked" && tag === "li" && (attribute.value === "true" || attribute.value === "false")) continue;
    if (name === "href" && tag === "a") continue;
    if (name === "start" && tag === "ol") continue;
    if (tag === "img" && IMAGE_ATTRIBUTES.has(name)) continue;
    if (name === "style") {
      const kept = keptStyle(attribute.value);
      if (kept) element.setAttribute("style", kept);
      else element.removeAttribute("style");
      continue;
    }
    element.removeAttribute(attribute.name);
  }
}

function renameTag(element: Element, tag: string): Element {
  const replacement = element.ownerDocument.createElement(tag);
  while (element.firstChild) replacement.appendChild(element.firstChild);
  element.replaceWith(replacement);
  return replacement;
}

/** 貼り付けられた HTML 文字列を、本文に持ち込める要素だけの HTML にする（ブラウザの DOMParser が要る）。 */
export function normalizePastedHtml(html: string): string {
  // DOMParser の文書は不活性（script は動かず、画像も読み込まれない）
  const doc = new DOMParser().parseFromString(html, "text/html");
  // ブラウザからのチェックリストは input を本文へ残さず、TaskItem の安全な状態属性へ写す。
  for (const list of Array.from(doc.body.querySelectorAll("ul"))) {
    const items = Array.from(list.children).filter((child) => child.tagName.toLowerCase() === "li");
    if (items.length === 0 || !items.every((item) => item.querySelector('input[type="checkbox"]') || item.getAttribute("data-type") === "taskItem")) continue;
    list.setAttribute("data-type", "taskList");
    for (const item of items) {
      const input = item.querySelector('input[type="checkbox"]');
      item.setAttribute("data-type", "taskItem");
      item.setAttribute("data-checked", input ? String((input as HTMLInputElement).checked) : String(item.getAttribute("data-checked") === "true"));
      input?.remove();
    }
  }
  for (const element of Array.from(doc.body.querySelectorAll(DROP_WITH_CONTENT.join(",")))) {
    if (!isEditorImage(element)) element.remove();
  }
  // コメント・処理命令（条件付きコメントなど）
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const comment of comments) comment.parentNode?.removeChild(comment);
  for (const element of Array.from(doc.body.querySelectorAll("*"))) {
    const target = HEADING_LEVEL[element.tagName.toLowerCase()];
    cleanAttributes(target ? renameTag(element, target) : element);
  }
  return doc.body.innerHTML;
}

/**
 * 貼り付け・ドロップで来たファイルのうち、画像のファイルだけ。受け付ける種類と大きさの上限はアップロードの口が見る
 * （断る理由を画面に出せるように。ここで黙って捨てない）。画像でないファイルは返さないので、ProseMirror の既定の扱いに任せる。
 * 本文のノードを移す操作（エディタの中のドラッグ）は files を持たないので、ここは空になる。
 */
export function imageFilesFrom(data: DataTransfer | null | undefined): File[] {
  if (!data?.files) return [];
  return Array.from(data.files).filter((file) => /^image\//i.test(file.type));
}
