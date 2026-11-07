"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EditorDestinationsPage, type EditorAddSiteDraft } from "niho-docs-ui/shell";
import { createSite, loadDestinations, type DestinationsDto, type IssuedKeyDto } from "@/lib/destinations-client";
import { DESTINATION_MESSAGES } from "@/publish/messages";

/**
 * 発信先（`/destinations`。Issue #41）。画面は docs-ui の `EditorDestinationsPage`（モック v6 の V.dest）で、
 * ここは状態・下書き・通信だけを持つ。
 *
 * 作ったときの平文の鍵は、この component の state に 1 回だけ置く（「閉じる」で消える）。保存もログも URL も通さない。
 */

const EMPTY_DRAFT: EditorAddSiteDraft = { mode: "api", handle: "", siteUrl: "https://", path: "" };

export type DestinationsViewProps = { initial: DestinationsDto };

export function DestinationsView({ initial }: DestinationsViewProps) {
  const router = useRouter();
  const [destinations, setDestinations] = useState(initial);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<EditorAddSiteDraft | null>(null);
  const [issuedKey, setIssuedKey] = useState<IssuedKeyDto | null>(null);

  const create = async () => {
    if (busy || draft === null) return;
    setBusy(true);
    setStatus("");
    const trimmed = draft.path.trim().replace(/^\/+|\/+$/g, "");
    const siteUrl = draft.siteUrl.trim();
    let host = "";
    try {
      host = new URL(siteUrl).host;
    } catch {
      setBusy(false);
      setStatus(DESTINATION_MESSAGES.invalid_site_url);
      return;
    }
    const result = await createSite({ handle: draft.handle.trim(), mode: draft.mode, siteUrl, urlShape: { host, path: trimmed } });
    setBusy(false);
    if (!result.ok) {
      setStatus(result.message);
      return;
    }
    setDraft(null);
    setIssuedKey(result.value.key);
    setStatus(DESTINATION_MESSAGES.keyOnce);
    // 一覧は作った後の状態をサーバーから読み直す（公開中の数・面の並びを画面で組み立てない）
    const reread = await loadDestinations();
    if (reread.ok) setDestinations(reread.value);
  };

  const copyKey = async () => {
    if (!issuedKey) return;
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("clipboard is unavailable");
      await navigator.clipboard.writeText(issuedKey.plaintext);
      setStatus("鍵をコピーしました");
    } catch {
      setStatus("コピーできませんでした。鍵の文字を選んで写してください");
    }
  };

  return (
    <EditorDestinationsPage
      status={status}
      busy={busy}
      faces={[]}
      sites={destinations.sites.map((site) => ({ id: site.id, handle: site.handle, host: site.urlShape.host, path: site.urlShape.path, mode: site.mode, published: site.published }))}
      onOpenFace={() => undefined}
      onOpenSite={(id) => router.push(`/destinations/${id}`)}
      onNavigate={(href) => router.push(href)}
      draft={draft}
      onAdd={() => setDraft(EMPTY_DRAFT)}
      onDraft={setDraft}
      onCancelAdd={() => setDraft(null)}
      onCreate={() => void create()}
      issuedKey={issuedKey ? { masked: issuedKey.masked, plaintext: issuedKey.plaintext } : null}
      onCopyKey={() => void copyKey()}
      onCloseKey={() => {
        setIssuedKey(null);
        setStatus("");
      }}
    />
  );
}
