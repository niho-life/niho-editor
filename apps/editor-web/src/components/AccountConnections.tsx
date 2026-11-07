"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, linkTo } from "niho-docs-ui/shell";
import type { ArticleLinkDto, NihoEditorRoles } from "@/auth/niho-experience-api";
import styles from "./AccountConnections.module.css";

const STATE_LABEL: Record<ArticleLinkDto["state"], string> = {
  PENDING: "返事を待っています",
  ACCEPTED: "承諾済み",
  DECLINED: "辞退済み",
  REVOKED: "取り消されました",
  EXPIRED: "期限が切れました",
};

export type AccountConnectionsState =
  | { status: "ready"; roles: NihoEditorRoles; links: readonly ArticleLinkDto[]; linksUnavailable?: boolean }
  | { status: "error" };

export function AccountConnections({ initial }: { initial: AccountConnectionsState }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState(initial.status === "error" ? "接続を確認できませんでした。少し待ってから再読み込みしてください。" : initial.linksUnavailable ? "体験とのつながりを確認できませんでした。" : "");

  async function reload(failure = "最新の接続状態を確認できませんでした。少し待ってから、もう一度お試しください。"): Promise<boolean> {
    setError("");
    try {
      const response = await fetch("/api/account/article-links", { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) throw new Error();
      const next = await response.json() as { roles: NihoEditorRoles; links: ArticleLinkDto[]; linksUnavailable?: boolean };
      setData({ status: "ready", ...next });
      if (next.linksUnavailable) setError("体験とのつながりを確認できませんでした。");
      return true;
    } catch {
      // 古い「接続済み」を確定状態として残さない。
      setData({ status: "error" });
      setError(failure);
      return false;
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
      await reload("招待の操作後に接続状態を確認できませんでした。少し待ってから、もう一度お試しください。");
    } finally { busyRef.current = false; setBusy(null); }
  }

  const writer = data.status === "ready" && data.roles.version === 1 && data.roles.roles.includes("writer") && data.roles.destinations.includes("exp");
  return (
    <div className="es-page">
      <a className="es-back" {...linkTo("/destinations", (href) => router.push(href))}>
        <Icon name="back" />
        発信先
      </a>
      <h1>NIHO Experience</h1>
      <div className={styles.root}>
        <section className={styles.card} aria-labelledby="account-role-title">
          <h2 id="account-role-title">接続状態</h2>
          <p>{data.status === "error" ? "接続を確認できません" : writer ? "接続済み" : "未接続"}</p>
        </section>
        <section className={styles.card} aria-labelledby="account-links-title">
          <div className={styles.heading}>
            <h2 id="account-links-title">提供者とのつながり</h2>
            <button type="button" className={styles.secondary} onClick={() => void reload()} disabled={busy !== null}>最新の状態を確認</button>
          </div>
          {error ? <p role="alert" className={styles.error}>{error}</p> : null}
          {data.status === "error" || data.linksUnavailable ? null : data.links.length === 0 ? <p>招待や承諾済みのつながりはありません。</p> : (
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
    </div>
  );
}
