"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EDITOR_SETTINGS_HREF, EditorSettingsAuthorPage } from "niho-docs-ui/shell";
import type { SettingsDto } from "@/lib/settings-client";
import { useSettingsState } from "./settings-state";

/**
 * 公開用の著者紹介（`/settings/author`）。肩書と紹介文を 1 回で送り（空は null＝なし）、保存できたら一覧へ戻る。
 * 公開のとき公開版の authorProfile に固定される（「あなたについて」とは別物で、AI には渡さない）。
 */
export function SettingsAuthorView({ initial }: { initial: SettingsDto }) {
  const router = useRouter();
  const { settings, status, busy, apply } = useSettingsState(initial);
  const [draft, setDraft] = useState({ role: settings.authorRole ?? "", bio: settings.authorBio ?? "" });
  const over = Array.from(draft.role).length > settings.limits.authorRoleChars || Array.from(draft.bio).length > settings.limits.authorBioChars;
  return (
    <EditorSettingsAuthorPage
      status={status}
      busy={busy}
      value={draft}
      onChange={setDraft}
      limits={settings.limits}
      onSave={() => {
        if (over) return;
        const role = draft.role.trim() === "" ? null : draft.role;
        const bio = draft.bio.trim() === "" ? null : draft.bio;
        void apply({ authorRole: role, authorBio: bio }, () => router.push(EDITOR_SETTINGS_HREF.hub));
      }}
      onNavigate={(href) => router.push(href)}
    />
  );
}
