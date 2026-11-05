"use client";

import { useRouter } from "next/navigation";
import { EditorSettingsTermsPage } from "niho-docs-ui/shell";
import type { SettingsDto } from "@/lib/settings-client";
import { useSettingsState, useTermRows } from "./settings-state";

/** 固有名詞（`/settings/terms`）。1 行ずつ直し、保存は表の全部を送る（`glossary`）。 */
export function SettingsTermsView({ initial }: { initial: SettingsDto }) {
  const router = useRouter();
  const { settings, status, busy, apply } = useSettingsState(initial);
  const rows = useTermRows(settings.glossary, settings.limits.glossary, busy, (glossary) => apply({ glossary }));
  return <EditorSettingsTermsPage status={status} rows={rows} onNavigate={(href) => router.push(href)} />;
}
