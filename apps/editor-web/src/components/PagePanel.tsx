"use client";

import { useState } from "react";
import { ShellPanelHead } from "niho-docs-ui/shell";
import type { AttachedAiSteps } from "@/lib/attached-page";

/**
 * 「ページ」のパネルの中身（#311。当面）。開いているページの手順（PageSteps が枠に登録した AttachedAiSteps）の段階と開始を縦に並べる。
 * 本文の上の帯（PageSteps）はそのまま（#308 が本文側の帯を消し、#309 がここを「流れ」に差し替える）。
 * 手順に関わらないページでは一言だけ。
 */
export function PagePanel({ steps, onClose, drag }: { steps: AttachedAiSteps | null; onClose: () => void; drag: boolean }) {
  const [note, setNote] = useState<{ owner: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // 一言はそのページの分だけ出す（ページが替わったら前のページの一言は出さない）
  const ownerId = steps?.ownerId ?? null;
  const run = async (id: string, label: string) => {
    if (!steps || busy !== null) return;
    setBusy(id);
    try {
      const result = await steps.start(id);
      setNote({ owner: steps.ownerId, text: result.message || (result.ok ? `「${label}」を開始しました。` : "開始できませんでした。") });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <ShellPanelHead panel="page" onClose={onClose} drag={drag} />
      <div className="es-pn-body">
        {steps ? (
          <ul className="es-pn-rows" aria-label="手順の段階">
            {steps.options.map((option) => {
              const redo = option.id.startsWith("stage:");
              const disabled = option.disabledReason !== null || busy !== null;
              return (
                <li key={option.id} className="es-pn-row">
                  <div>
                    <b>{option.label}</b>
                    <small>{option.disabledReason ?? option.hint}</small>
                  </div>
                  <button
                    type="button"
                    className="es-btn es-btn--outline es-btn--sm"
                    aria-disabled={disabled || undefined}
                    aria-label={`${option.label}を${redo ? "作り直す" : "開始"}`}
                    title={option.disabledReason ?? undefined}
                    onClick={() => !disabled && void run(option.id, option.label)}
                  >
                    {busy === option.id ? "送っています…" : redo ? "作り直す" : "開始"}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="es-pn-note">手順のあるページ（録音と、録音から作ったページ）で、段階と開始がここに出ます。</p>
        )}
        <p role="status" className="es-pn-note" style={note && note.owner === ownerId ? { marginTop: 10 } : undefined}>
          {note && note.owner === ownerId ? note.text : ""}
        </p>
      </div>
    </>
  );
}
