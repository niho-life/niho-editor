import type { FaceDest } from "@niho/editor-publish-contract";

/**
 * dev（stub の方式）で `EDITOR_DESTINATION_DECLARATIONS` が未設定のときに使う、面の宣言（#39）。本番の宣言は発信先が出す。
 *
 * 条件（requires）は、いまの editor の画面で埋められる欄のものだけにしてある。画面にあるのは題名と本文だけで、
 * 言語・リード・カバー写真・カテゴリ・関連する体験の欄はまだ無い（#33 以降）。だから lang・lead・cover・category・relatedLive は
 * 入れず、本文で直せる headings（見出し）と noConfirm（未確認の印）だけを置く。題名と本文があることは、どの発信先でも
 * editor-publish が見る（宣言には書かない）。NIHO Experience には、本文の画面で直せる title（題名の長さ。110 字は Experience の
 * `Article.headline` の上限）と images（写真の代替テキスト）も置く（本番の宣言と同じ。SEO・AIO に要る）。
 *
 * host・path はモック v6 と同じ。dev の公開版はここに届かない（「見る」で開くと 404）。
 */
export const DEV_DECLARATIONS: { readonly [K in FaceDest]: Readonly<Record<string, unknown>> } = {
  exp: {
    schemaVersion: 1,
    id: "exp",
    label: "NIHO Experience",
    host: "experience.niho.life",
    path: "guides",
    ranges: ["live", "unlisted"],
    extras: ["app", "news", "xp"],
    // 引用は受けない（docs/architecture/editor-publish-core.md の例のとおり。本文で直せる）
    accepts: { blocks: ["paragraph", "heading", "list", "figure", "divider", "note"], marks: ["bold", "italic", "strike", "code", "link"] },
    requires: [
      { id: "headings", kind: "headings", min: 1, message: "本文に見出しを 1 つ以上入れてください", fix: "body" },
      { id: "no-confirm", kind: "noConfirm", message: "未確認の印（CONFIRM）を解消してください", fix: "body" },
      { id: "title", kind: "title", max: 110, message: "題名を 110 字以内にしてください", fix: "body" },
      { id: "image-alt", kind: "images", alt: true, message: "写真に代替テキスト（alt）を入れてください", fix: "body" },
    ],
  },
  niho: {
    schemaVersion: 1,
    id: "niho",
    label: "NIHO",
    host: "niho.life",
    path: "article",
    ranges: ["live", "unlisted"],
    extras: ["app", "news"],
    accepts: { blocks: ["paragraph", "heading", "list", "quote", "figure", "divider", "note"], marks: ["bold", "italic", "strike", "code", "link"] },
    requires: [{ id: "no-confirm", kind: "noConfirm", message: "未確認の印（CONFIRM）を解消してください", fix: "body" }],
  },
};
