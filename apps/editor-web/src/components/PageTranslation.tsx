"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PageLang } from "@niho/editor-store";
import { Icon, ShellSheet } from "niho-docs-ui/shell";
import {
  TranslationRequestError,
  adoptTranslation,
  detachTranslation,
  generateTranslation,
  loadTranslation,
  reviewTranslation,
  type TranslationFieldDto,
  type TranslationStateDto,
} from "@/lib/translation-client";

type Props = {
  pageId: string;
  lang: PageLang;
  saveFirst: () => Promise<boolean>;
  savedRevision: number | null;
  currentRevision: () => number | null;
};

const FIELD_STYLE = {
  display: "grid",
  gap: 5,
  minWidth: 0,
  padding: 9,
  borderRadius: 8,
  background: "var(--niho-docs-surface)",
  overflowWrap: "anywhere",
  whiteSpace: "pre-wrap",
} as const;

/** 英語案を作っているあいだ、状態を読み直す間隔。 */
export const TRANSLATION_POLL_MS = 4000;

/** ⓘ（英語版について）の説明。画面には出さず、押したときのシートだけに置く。 */
export const JA_INFO = [
  "保存済みの題名・リード・本文・画像の代替テキストとキャプションをAnthropic APIへ送り、従量対象の英語案を作ります。候補は確認・採用するまでページや公開版を変更しません。",
  "上限は20,000文字・256項目です。コード、画像ID・URL・リンク・書式・クレジット・許諾は翻訳せず維持します。録音を含む本文は、文章のページに分けてから英語案を作ってください。未対応構造や欠落した結果は全体を採用しません。",
  "採用すると、初回は非公開の英語ページを作ります。作り直しは、現在の英語版を自動変更せず、この操作で新版として採用します。",
] as const;
export const EN_INFO = [
  "日本語原文との管理翻訳か、独立した英語ページかは、開いたときにサーバーで確認します。",
  "管理翻訳の英語版は、原文または英語版が更新されたら、固有名詞・価格・時刻・個人情報・画像の代替テキストを確認してください。",
  "独立した英語ページには、管理翻訳の確認条件は付きません。",
] as const;

function TranslationInfo({ paragraphs, onClose }: { paragraphs: readonly string[]; onClose: () => void }) {
  return (
    <ShellSheet label="英語版について" onClose={onClose}>
      <div className="es-sh-hd">
        <h2>英語版について</h2>
      </div>
      <div className="es-sh-body">
        <div className="es-sh-sec" style={{ display: "grid", gap: 8 }}>
          {paragraphs.map((text) => (
            <p key={text} className="es-sh-text">
              {text}
            </p>
          ))}
        </div>
      </div>
      <div className="es-sh-foot">
        <span className="es-sp" />
        <button type="button" className="es-btn es-btn--quiet" data-autofocus="" onClick={onClose}>
          閉じる
        </button>
      </div>
    </ShellSheet>
  );
}

function messageOf(error: unknown): string {
  if (!(error instanceof TranslationRequestError)) return "翻訳の状態を更新できませんでした。時間をおいてもう一度お試しください。";
  const messages: Record<string, string> = {
    translation_recording_requires_text_page: "録音を含む本文は、文字起こしを文章のページに分けてから英語案を作ってください。",
    translation_unknown_structure: "このページには翻訳に未対応の本文構造があります。本文を確認してください。",
    translation_too_many_fields: "翻訳対象が256項目を超えています。ページを分けてください。",
    translation_too_large: "翻訳対象が20,000文字を超えています。ページを分けてください。",
    translation_no_fields: "翻訳できる文字がありません。",
    translation_asset_unavailable: "画像の保存状態が変わったため実行できません。保存を確認してやり直してください。",
    translation_conflict: "原文または英語版が先に更新されました。両方を残したまま停止しました。読み直して確認してください。",
    translation_review_conflict: "原文または英語版が別の画面で更新されました。ページを再読み込みし、表示された本文をもう一度確認してください。",
    translation_not_ready: "候補が期限切れか、まだ準備できていません。",
    translation_copy_failed: "画像の独立コピーを完了できませんでした。原本と英語版は変更していません。もう一度採用できます。",
    translation_source_missing: "日本語の原文が見つかりません。",
    quota_exceeded: "今月のAPI利用上限に達しています。",
    ai_unavailable: "英語案を作るAPIを利用できません。設定を確認してください。",
    ai_rate_limit: "APIが混み合っています。候補は採用されていません。時間をおいて新しく実行してください。",
  };
  return (error.code && messages[error.code]) || "翻訳処理を完了できませんでした。原文と既存の英語版は変更していません。";
}

function labelOf(path: string): string {
  if (path === "title") return "題名";
  if (path === "lead") return "公開用リード";
  if (path.startsWith("assets[") && path.endsWith("].alt")) return "画像の代替テキスト";
  if (path.endsWith(".attrs.alt")) return "本文画像の代替テキスト";
  if (path.endsWith(".attrs.caption")) return "画像キャプション";
  return "本文";
}

function Comparisons(props: { source: readonly TranslationFieldDto[]; candidate: readonly TranslationFieldDto[] }) {
  const candidate = new Map(props.candidate.map((field) => [field.path, field.text] as const));
  return (
    <div style={{ display: "grid", gap: 8, minWidth: 0 }} aria-label="英語案の比較">
      {props.source.map((field) => (
        <div key={field.path} style={FIELD_STYLE}>
          <strong>{labelOf(field.path)}</strong>
          <span lang="ja">原文: {field.text}</span>
          <span lang="en">英語案: {candidate.get(field.path) ?? ""}</span>
        </div>
      ))}
    </div>
  );
}

export function PageTranslation({ pageId, lang, saveFirst, savedRevision, currentRevision }: Props) {
  const router = useRouter();
  const [state, setState] = useState<TranslationStateDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"generate" | "adopt" | "review" | "detach" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detachChecked, setDetachChecked] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setState(await loadTranslation(pageId));
      setError(null);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setLoading(false);
    }
  }, [pageId]);

  // 開いたとき・ページが替わったときに読む（「状態を読み直す」「翻訳の状態を確認」のボタンは持たない）
  useEffect(() => {
    let alive = true;
    loadTranslation(pageId).then(
      (next) => {
        if (!alive) return;
        setState(next);
        setError(null);
      },
      (failure: unknown) => {
        if (alive) setError(messageOf(failure));
      },
    );
    return () => {
      alive = false;
    };
  }, [pageId]);

  const previousRevision = useRef(savedRevision);
  useEffect(() => {
    const changed = previousRevision.current !== savedRevision;
    previousRevision.current = savedRevision;
    if (changed && lang === "en") void reload();
  }, [savedRevision, lang, reload]);

  const relation = state?.relation ?? null;
  const proposal = state?.proposal ?? null;
  const isTarget = relation?.targetPageId === pageId;
  const reviewCurrent = relation !== null
    && !relation.detached
    && !relation.sourceMissing
    && relation.sourceRevision === relation.reviewedSourceRevision
    && relation.targetRevision === relation.reviewedTargetRevision
    && relation.targetRevision === savedRevision;
  const candidateReady = proposal?.status === "ready" && proposal.sourceFields && proposal.candidateFields;
  const targetHref = relation ? `/p/${relation.targetPageId}` : proposal?.status === "adopted" ? `/p/${proposal.targetPageId}` : null;
  const omissions = useMemo(() => proposal?.omissions ?? [], [proposal?.omissions]);

  // 英語案を作っているあいだは、少し待って読み直す（作り終えたら・画面を離れたら止める）
  const generating = proposal?.status === "generating";
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => void reload(), TRANSLATION_POLL_MS);
    return () => clearInterval(timer);
  }, [generating, reload]);

  const generate = async () => {
    setBusy("generate");
    setError(null);
    try {
      if (!(await saveFirst())) throw new Error("save");
      const next = await generateTranslation(pageId, crypto.randomUUID());
      setState((current) => current ? { ...current, proposal: next } : {
        page: { id: pageId, lang, revision: next.sourceRevision },
        relation: null,
        proposal: next,
        provider: { destination: "Anthropic API", metered: true },
      });
    } catch (failure) {
      setError(failure instanceof Error && failure.message === "save" ? "先にページの保存を完了してください。" : messageOf(failure));
    } finally {
      setBusy(null);
    }
  };

  const adopt = async () => {
    if (!proposal) return;
    setBusy("adopt");
    setError(null);
    try {
      const result = await adoptTranslation(pageId, proposal);
      router.push(`/p/${result.targetPageId}`);
    } catch (failure) {
      setError(messageOf(failure));
      await reload();
    } finally {
      setBusy(null);
    }
  };

  const review = async () => {
    setBusy("review");
    setError(null);
    try {
      if (!(await saveFirst())) throw new Error("save");
      // Fix the expected revisions before reading server state. A clean stale tab
      // must not review newer content that this editor has never displayed.
      const sourceRevision = relation?.sourceRevision;
      const targetRevision = currentRevision();
      const current = await loadTranslation(pageId);
      if (!current.relation?.sourceRevision) throw new TranslationRequestError(409, "translation_source_missing");
      if (!sourceRevision || targetRevision === null || current.relation.sourceRevision !== sourceRevision
        || current.relation.targetRevision !== targetRevision) {
        throw new TranslationRequestError(409, "translation_review_conflict");
      }
      await reviewTranslation(pageId, sourceRevision, targetRevision);
      await reload();
    } catch (failure) {
      setError(failure instanceof Error && failure.message === "save" ? "先に英語版の保存を完了してください。" : messageOf(failure));
    } finally {
      setBusy(null);
    }
  };

  const detach = async () => {
    if (!relation || !detachChecked) return;
    setBusy("detach");
    setError(null);
    try {
      if (!(await saveFirst())) throw new Error("save");
      const current = await loadTranslation(pageId);
      if (!current.relation) throw new TranslationRequestError(404, "not_found");
      await detachTranslation(pageId, current.relation.targetRevision);
      setDetachChecked(false);
      await reload();
    } catch (failure) {
      setError(failure instanceof Error && failure.message === "save" ? "先に英語版の保存を完了してください。" : messageOf(failure));
    } finally {
      setBusy(null);
    }
  };

  const [infoOpen, setInfoOpen] = useState(false);
  const info = infoOpen ? <TranslationInfo paragraphs={lang === "en" ? EN_INFO : JA_INFO} onClose={() => setInfoOpen(false)} /> : null;
  const infoButton = (
    <button type="button" className="es-info" aria-label="英語版について" title="英語版について" onClick={() => setInfoOpen(true)}>
      <Icon name="info" />
    </button>
  );
  const alert = error && <p role="alert" className="es-upnote">{error}</p>;

  if (lang === "en" && state === null) {
    return (
      <section aria-label="英語版" className="es-pf">
        <span className="es-pf-row">
          <span className="es-pf-lbl" aria-hidden="true">英語版</span>
          <span>{error ? "確認できませんでした" : "確認しています…"}</span>
          <span className="es-pf-act">{infoButton}</span>
        </span>
        {alert}
        {info}
      </section>
    );
  }

  if (lang === "en" && (!relation || relation.detached)) {
    return (
      <section aria-label="英語版" className="es-pf">
        <span className="es-pf-row">
          <span className="es-pf-lbl" aria-hidden="true">英語版</span>
          <span>独立した英語ページ</span>
          <span className="es-pf-act">{infoButton}</span>
        </span>
        {alert}
        {info}
      </section>
    );
  }

  if (lang === "en" && isTarget) {
    return (
      <section aria-label="日本語原文との対応" className="es-pf">
        <span className="es-pf-row">
          <span className="es-pf-lbl" aria-hidden="true">原文</span>
          {!relation?.sourceMissing && relation?.sourcePageId ? <a href={`/p/${relation.sourcePageId}`}>日本語の原文を開く</a> : <span>なし</span>}
          <span className="es-pf-act">{infoButton}</span>
        </span>
        {relation?.sourceMissing ? (
          <>
            <p role="status">原文が見つかりません。既存の公開版は変わりませんが、次の公開・更新は停止します。</p>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <input type="checkbox" checked={detachChecked} disabled={busy !== null} onChange={(event) => setDetachChecked(event.currentTarget.checked)} />
              現在の英語本文を確認し、原文との対応を外して独立した英語ページにする
            </label>
            <button type="button" className="es-btn es-btn--outline es-btn--sm" style={{ justifySelf: "start" }} disabled={!detachChecked || busy !== null} onClick={() => void detach()}>
              {busy === "detach" ? "独立化しています…" : "対応を外す"}
            </button>
          </>
        ) : reviewCurrent ? (
          <p role="status">原文と英語版を確認済み</p>
        ) : (
          <span className="es-pf-row">
            <span role="status">原文または英語版が更新されています</span>
            <button type="button" className="es-btn es-btn--outline es-btn--sm es-pf-act" disabled={busy !== null} onClick={() => void review()}>
              {busy === "review" ? "確認を保存しています…" : "原文と英語版を確認しました"}
            </button>
          </span>
        )}
        {alert}
        {info}
      </section>
    );
  }

  const stateWord = proposal?.status === "generating" ? "作成中…" : candidateReady ? "候補あり" : "なし";
  return (
    <section aria-label="英語版" className="es-pf">
      <span className="es-pf-row">
        <span className="es-pf-lbl" aria-hidden="true">英語版</span>
        {targetHref ? <a href={targetHref}>英語版を開く</a> : <span>{stateWord}</span>}
        <span className="es-pf-act">
          <button type="button" className="es-btn es-btn--outline es-btn--sm" disabled={busy !== null || loading} onClick={() => void generate()}>
            {busy === "generate" ? "作成中…" : relation ? "作り直す" : "英語案を作る"}
          </button>
          {infoButton}
        </span>
      </span>
      {proposal?.status === "generating" && <p role="status">英語案を生成しています。同じ操作を再送しても二重実行しません。</p>}
      {proposal?.status === "failed" && <p role="status">前回の生成は完了しませんでした。原文と英語版は変更していません。</p>}
      {proposal?.status === "expired" && <p role="status">候補の期限が切れました。内容は消去されています。</p>}
      {candidateReady && (
        <>
          {omissions.length > 0 && <p>今回の対象外: {omissions.join("、")}</p>}
          <Comparisons source={proposal.sourceFields!} candidate={proposal.candidateFields!} />
          <button type="button" className="es-btn es-btn--primary es-btn--sm" style={{ justifySelf: "start" }} disabled={busy !== null} onClick={() => void adopt()}>
            {busy === "adopt" ? "画像を独立コピーして採用しています…" : "この英語案を採用"}
          </button>
        </>
      )}
      {alert}
      {info}
    </section>
  );
}
