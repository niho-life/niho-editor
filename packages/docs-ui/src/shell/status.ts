import type { ShellButtonTone, ShellPublication, ShellStatusState } from "./types";

/** ページの公開状態から、状態の丸と吹き出しの言葉を決める（モック v6 の statusDot と同じ文言）。 */
export function shellStatus(pub: ShellPublication | null): { state: ShellStatusState; tip: string } {
  if (!pub) return { state: "private", tip: "自分だけ · 保存済み" };
  if (pub.range === "stopped") return { state: "stopped", tip: "公開をやめた · 保存済み" };
  if (pub.updated) return { state: "updated", tip: "更新あり · 直した内容はまだ読者に出ていません" };
  if (pub.range === "unlisted") return { state: "limited", tip: "限定公開 · URL を知っている人だけ · 保存済み" };
  return { state: "published", tip: `公開中 · ${pub.url} · 保存済み` };
}

/**
 * ヘッダーの公開ボタン。発信先が決まっているか記事なら主ボタン、それ以外の「公開」は面も縁も持たない静かなボタン（ジャーナリングが主で、公開は一部）。
 * 公開中は静かな「公開中 ▾」、更新ありは「更新を公開」。
 */
export function shellPublishButton(input: {
  pub: ShellPublication | null;
  /** 発信先を選んだが、まだ公開していない。 */
  planned?: boolean;
  isArticle?: boolean;
}): { label: string; tone: ShellButtonTone; menu: boolean } {
  const { pub } = input;
  if (!pub || pub.range === "stopped") {
    const loud = Boolean(input.planned) || Boolean(input.isArticle);
    return { label: "公開", tone: loud ? "primary" : "quiet", menu: false };
  }
  if (pub.updated) return { label: "更新を公開", tone: "primary", menu: false };
  return { label: "公開中", tone: "quiet", menu: true };
}
