"use client";

import { useRef, useState } from "react";
import type { ArticleLinkDto, NihoEditorRoles } from "@/auth/niho-experience-api";
import styles from "./AccountConnections.module.css";

const STATE_LABEL: Record<ArticleLinkDto["state"], string> = {
  PENDING: "返事を待っています",
  ACCEPTED: "承諾済み",
  DECLINED: "辞退済み",
  REVOKED: "取り消されました",
  EXPIRED: "期限が切れました",
};

export function AccountConnections({ initial }: { initial: { roles: NihoEditorRoles; links: readonly ArticleLinkDto[] } | null }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState(initial ? "" : "NIHO の役割と招待を確認できませんでした。少し待ってから再読み込みしてください。");

  async function reload() {
    setError("");
    try {
      const response = await fetch("/api/account/article-links", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error();
      setData(await response.json() as { roles: NihoEditorRoles; links: ArticleLinkDto[] });
    } catch {
      setError("最新の状態を確認できませんでした。別の端末で変更した場合も、再読み込みすると反映されます。");
    }
  }

  async function decide(id: string, decision: "accept" | "decline") {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(id);
    setError("");
    try {
      const response = await fetch(`/api/account/article-links/${id}/${decision}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin",
      });
      if (!response.ok) throw new Error();
      await reload();
    } catch {
      setError("招待の状態が変わったか、NIHO に接続できませんでした。最新の状態を再読み込みしてから、もう一度お試しください。");
    } finally { busyRef.current = false; setBusy(null); }
  }

  const writer = data?.roles.version === 1 && data.roles.roles.includes("writer") && data.roles.destinations.includes("exp");
  return (
    <div className={styles.root}>
      <section className={styles.card} aria-labelledby="account-role-title">
        <h2 id="account-role-title">記事ライター</h2>
        <p>{writer ? "NIHO Experience へ記事を公開できます。公開のたびに現在の役割を確認します。" : "現在、NIHO Experience へ公開できる記事ライターの役割はありません。私的なページの作成と編集は続けられます。"}</p>
      </section>
      <section className={styles.card} aria-labelledby="account-links-title">
        <div className={styles.heading}>
          <h2 id="account-links-title">提供者とのつながり</h2>
          <button type="button" className={styles.secondary} onClick={() => void reload()} disabled={busy !== null}>最新の状態を確認</button>
        </div>
        {error ? <p role="alert" className={styles.error}>{error}</p> : null}
        {!data ? null : data.links.length === 0 ? <p>招待や承諾済みのつながりはありません。</p> : (
          <ul className={styles.list}>
            {data.links.map((link) => (
              <li key={link.id} className={styles.link}>
                <div><strong>{link.providerName}</strong><span>{STATE_LABEL[link.state]}</span></div>
                <p>{link.inviterName} さんから {link.writerLabel} への招待</p>
                {link.state === "PENDING" ? (
                  <div className={styles.actions}>
                    <button type="button" onClick={() => void decide(link.id, "accept")} disabled={busy !== null}>{busy === link.id ? "確認中…" : "承諾する"}</button>
                    <button type="button" className={styles.secondary} onClick={() => void decide(link.id, "decline")} disabled={busy !== null}>辞退する</button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
