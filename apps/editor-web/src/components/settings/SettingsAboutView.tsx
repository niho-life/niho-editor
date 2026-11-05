"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EDITOR_SETTINGS_HREF, EditorSettingsAboutPage } from "niho-docs-ui/shell";
import type { SettingsDto } from "@/lib/settings-client";
import { useSettingsState } from "./settings-state";

/** あなたについて（`/settings/about`）。呼び名と説明を 1 回で送り、保存できたら一覧へ戻る。 */
export function SettingsAboutView({ initial }: { initial: SettingsDto }) {
  const router = useRouter();
  const { settings, status, busy, apply } = useSettingsState(initial);
  const [draft, setDraft] = useState({ name: settings.aboutName, text: settings.about });
  const over = Array.from(draft.name).length > settings.limits.aboutNameChars || Array.from(draft.text).length > settings.limits.aboutChars;
  return (
    <EditorSettingsAboutPage
      status={status}
      busy={busy}
      value={draft}
      onChange={setDraft}
      limits={settings.limits}
      onSave={() => {
        if (over) return;
        void apply({ aboutName: draft.name, about: draft.text }, () => router.push(EDITOR_SETTINGS_HREF.hub));
      }}
      onNavigate={(href) => router.push(href)}
    />
  );
}
