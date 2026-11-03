import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isShareToken, readSharedPage, type SharedPage } from "@niho/editor-store";
import { sharedImagePath } from "@/image/image-paths";
import { getPool } from "@/server/db";
import { SharedBlocks } from "@/share/render-blocks";
import "./shared-page.css";

export const dynamic = "force-dynamic";

// token は <title>・メタデータに入れない。リンク先へ Referer で token を渡さない（header も next.config.ts で no-referrer）
export const metadata: Metadata = {
  title: { absolute: "共有されたページ" },
  referrer: "no-referrer",
};

/** DB を使えない（未設定・接続できない・問い合わせの失敗）。応答は汎用の 500。token・SQL は文言にもログにも出さない。 */
class SharedPageUnavailable extends Error {
  override readonly name = "SharedPageUnavailable";
  constructor() {
    super("shared page is unavailable");
  }
}

async function loadSharedPage(token: string): Promise<SharedPage | null> {
  // 形の違う token は DB に問い合わせない（DB が無くても同じ 404）
  if (!isShareToken(token)) return null;
  const pool = getPool();
  if (!pool) throw new SharedPageUnavailable();
  try {
    return await readSharedPage(pool, token);
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
    console.error("editor-web: shared page read failed", { name, code });
    throw new SharedPageUnavailable();
  }
}

/**
 * リンクで共有したページ（読み取り専用・ログイン不要。#34）。認証は使わない。
 * 本文の画像（#33）は `/s/{token}/a/{assetId}`（src/app/s/[token]/a/[assetId]/route.ts）が中継する。
 * 形の違う token・共有していない・止めた・作り直す前の token・ゴミ箱のページはどれも同じ 404。
 * 返すのは最新の保存版の題名と本文だけ（編集中の下書きはサーバーに無い）。
 */
export default async function SharedPageView(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  const page = await loadSharedPage(token);
  if (!page) notFound();
  return (
    <main lang={page.lang}>
      <h1>{page.title || (page.lang === "en" ? "Untitled" : "無題")}</h1>
      {/* 画像は同じ token の中継だけを指す（署名付き URL も `/api/assets` も共有ページには出さない） */}
      <SharedBlocks blocks={page.blocks} assetSrc={(assetId) => sharedImagePath(token, assetId)} />
    </main>
  );
}
